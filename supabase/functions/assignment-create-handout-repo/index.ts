import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { AssignmentCreateHandoutRepoRequest } from "../_shared/FunctionTypes.d.ts";
import {
  createRepo,
  deleteFileFromRepo,
  GRADE_WORKFLOW_PATH,
  syncRepoPermissions,
  updateAutograderWorkflowHash
} from "../_shared/GitHubWrapper.ts";
import { resolveTemplateRepos } from "../_shared/GitHubSyncHelpers.ts";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { resolveHandoutRepoAction, type HandoutSourceAssignment } from "../_shared/handoutRepoStrategy.ts";
import { shouldSkipRealGithubForE2eFixture } from "../_shared/e2eGithubGuard.ts";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, class_id, template_repo_override } = (await req.json()) as AssignmentCreateHandoutRepoRequest;
  scope?.setTag("function", "assignment-create-handout-repo");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());

  // Allow both instructor users and service role (for admin scripts)
  await assertUserIsInstructorOrServiceRole(class_id, req.headers.get("Authorization"));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // `*` rather than an explicit column list: the long list this used to carry
  // overflowed postgrest-js's select-string type parser, collapsing `assignment`
  // to GenericStringError so every field access below was an unchecked type
  // error. One extra row's worth of columns is a fine trade for real types.
  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("*, classes(slug,github_org)")
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new UserVisibleError("Assignment not found", 400);
  }
  if (!assignment.classes.slug) {
    throw new UserVisibleError("Class does not have a slug", 400);
  }
  const handoutRepoOrg = assignment.classes.github_org;
  if (!handoutRepoOrg && assignment.repo_mode !== "none" && assignment.repo_mode !== "no_submission") {
    throw new UserVisibleError("Class does not have a GitHub organization", 400);
  }
  scope.setTag("repo_mode", assignment.repo_mode);

  let sourceAssignment: HandoutSourceAssignment | null = null;
  if (assignment.repo_mode === "fork_from_prior_assignment" && assignment.source_assignment_id) {
    const { data: src } = await adminSupabase
      .from("assignments")
      .select("id, class_id, title, has_autograder, template_repo, latest_template_sha")
      .eq("id", assignment.source_assignment_id)
      .maybeSingle();
    if (src) {
      sourceAssignment = src as HandoutSourceAssignment;
      // This mode adopts the SOURCE assignment's handout repo verbatim, and
      // student repos fork each student's source-assignment repo. So the two
      // assignments share one handout, and the autograder setting is a property
      // of that shared handout — it cannot differ between them. Allowing it
      // would leave a state that assignment-sync-autograder-workflow later
      // refuses (so every subsequent save fails), and the student forks would
      // inherit the source's grade.yml regardless of this assignment's flag.
      if ((src.has_autograder !== false) !== (assignment.has_autograder !== false)) {
        throw new UserVisibleError(
          `This assignment forks from "${src.title}" (#${src.id}), so both share that assignment's handout ` +
            `repository and must have the same autograder setting. ` +
            `"${src.title}" has the autograder ${src.has_autograder === false ? "disabled" : "enabled"}, ` +
            `so this assignment must too. Change the autograder setting to match, or pick a different ` +
            `repository configuration so this assignment gets its own handout.`,
          400
        );
      }
    }
  }

  const action = resolveHandoutRepoAction(
    {
      id: assignment.id,
      class_id: assignment.class_id,
      repo_mode: assignment.repo_mode,
      source_assignment_id: assignment.source_assignment_id
    },
    sourceAssignment
  );

  if (action.kind === "noop") {
    // repo_mode in ('none', 'no_submission'). Clear template_repo so downstream
    // consumers don't try to use a stale value, and skip GitHub entirely.
    if (assignment.template_repo) {
      await adminSupabase.from("assignments").update({ template_repo: null }).eq("id", assignment_id);
    }
    return {
      repo_name: null,
      org_name: null,
      skipped: true,
      repo_mode: assignment.repo_mode
    };
  }

  if (action.kind === "inherit_from_source") {
    // For fork_from_prior_assignment we don't create a new handout repo; the
    // student repos fork from each student's prior-assignment repo. We still
    // copy the source assignment's template_repo + latest_template_sha onto
    // this assignment so the handout-history UI and template-SHA-driven sync
    // continue to work.
    await adminSupabase
      .from("assignments")
      .update({
        template_repo: sourceAssignment!.template_repo,
        latest_template_sha: sourceAssignment!.latest_template_sha ?? null
      })
      .eq("id", assignment_id);
    // Populate this assignment's autograder.workflow_sha from the inherited
    // handout's grade.yml. Without this the auto-created autograder row keeps
    // workflow_sha = NULL and every student submission is rejected with a
    // "workflow sha mismatch" error. updateAutograderWorkflowHash bulk-updates
    // all assignments sharing this template_repo, so the source assignment is
    // unaffected (it already has the same value).
    //
    // Skipped when this assignment has no autograder: there is no submission
    // path that checks workflow_sha, and the inherited handout may legitimately
    // have no grade.yml at all (updateAutograderWorkflowHash throws in that
    // case). Note we deliberately do NOT delete grade.yml from the inherited
    // handout — it belongs to the source assignment, which may well have an
    // autograder of its own.
    if (sourceAssignment!.template_repo && assignment.has_autograder !== false) {
      await updateAutograderWorkflowHash(sourceAssignment!.template_repo);
    }
    return {
      repo_name: sourceAssignment!.template_repo?.split("/")[1] ?? null,
      org_name: sourceAssignment!.template_repo?.split("/")[0] ?? null,
      inherited_from_source: true,
      source_assignment_id: sourceAssignment!.id,
      repo_mode: assignment.repo_mode
    };
  }

  // action.kind === "create"
  const handoutRepoName = `${assignment.classes.slug}-handout-${assignment.slug}`;
  scope.setTag("handout_repo_name", handoutRepoName);
  scope.setTag("handout_repo_org", handoutRepoOrg!);

  // An explicit override (e.g. demo-mode provisioning) wins; otherwise resolve the
  // configured handout template (per-class override -> github_org default -> hardcoded
  // constant). resolveTemplateRepos already falls back to the same constant the strategy
  // uses as action.sourceRepo, so it supersedes it for the create case. Resolve lazily so an
  // explicit override skips the extra resolve_class_template_repos round-trip.
  const sourceTemplateRepo = template_repo_override ?? (await resolveTemplateRepos(adminSupabase, class_id)).handout;
  scope.setTag("source_template_repo", sourceTemplateRepo);

  // E2E fixtures (pawtograder-playground + e2e-ignore-* class) must never hit real GitHub. Return
  // before every GitHub call below (createRepo + syncRepoPermissions + updateAutograderWorkflowHash).
  // Don't persist template_repo: no repo was created, so leaving it null keeps the DB honest
  // (mirrors the noop branch above). Stub-record tests still fall through (predicate returns false).
  if (
    shouldSkipRealGithubForE2eFixture({
      org: handoutRepoOrg,
      courseSlug: assignment.classes.slug,
      repoName: handoutRepoName
    })
  ) {
    return {
      repo_name: handoutRepoName,
      org_name: handoutRepoOrg,
      skipped: true,
      repo_mode: assignment.repo_mode
    };
  }

  // The protect_* columns configure STUDENT repos. The staff handout repo must
  // never require pull requests / approving reviews — that would block
  // instructors pushing handout updates — so only carry force-push protection
  // onto the handout (and only when configured for student repos).
  const branchProtection = {
    blockForcePush: assignment.protect_block_force_push ?? true,
    requirePullRequest: false,
    requiredReviewers: 0
  };

  await createRepo(
    handoutRepoOrg!,
    handoutRepoName,
    sourceTemplateRepo,
    {
      is_template_repo: action.isTemplateRepo,
      creation_method: "template",
      branch_protection: branchProtection
    },
    scope
  );
  await syncRepoPermissions(
    handoutRepoOrg!,
    handoutRepoName,
    assignment.classes.slug,
    [],
    scope,
    action.studentTeamPermission ? { studentTeamPermission: action.studentTeamPermission } : undefined
  );
  // Branch protection is applied inside createRepo (both the fresh-create and
  // the pre-existing-repo branches), so we no longer need a redundant call here.
  //
  // Repo-only assignments (has_autograder=false) get a handout with NO grading
  // workflow: the stock handout template ships .github/workflows/grade.yml, which
  // would otherwise run in every student repo generated from this handout and
  // fail (there is no autograder to report to), showing students a red X. Strip
  // it here, after the repo exists — GitHub's create-from-template API copies the
  // whole tree, so there is no way to exclude it up front.
  //
  // updateAutograderWorkflowHash must be skipped in that case: it reads grade.yml
  // and throws "File not found" when absent, which would fail the whole creation.
  // Leaving autograder.workflow_sha NULL is correct, since the sha check only runs
  // on the Actions-driven submission path, which no longer exists here.
  if (assignment.has_autograder === false) {
    await deleteFileFromRepo(
      `${handoutRepoOrg}/${handoutRepoName}`,
      GRADE_WORKFLOW_PATH,
      "Remove autograder workflow: this assignment has no autograder",
      scope
    );
  } else {
    await updateAutograderWorkflowHash(`${handoutRepoOrg}/${handoutRepoName}`);
  }

  // Only persist the template_repo pointer after GitHub creation + permission
  // sync succeed, so a partial failure does not leave the assignment pointing
  // at a repo that does not exist. For pr-mode the handout IS the upstream repo
  // (students fork it and PR back to it), so point upstream_repo at the same
  // repo here — the github-repo-webhook PR ingestion matches upstream_repo
  // against the repo a PR targets, and handout == upstream must never drift.
  const handoutFullName = `${handoutRepoOrg}/${handoutRepoName}`;
  await adminSupabase
    .from("assignments")
    .update({
      template_repo: handoutFullName,
      ...(assignment.submission_mode === "pr" ? { upstream_repo: handoutFullName } : {})
    })
    .eq("id", assignment_id);

  return {
    repo_name: handoutRepoName,
    org_name: handoutRepoOrg,
    repo_mode: assignment.repo_mode
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
