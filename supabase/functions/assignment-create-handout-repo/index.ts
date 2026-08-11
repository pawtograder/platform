import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { AssignmentCreateHandoutRepoRequest } from "../_shared/FunctionTypes.d.ts";
import {
  createRepo,
  deleteFileFromRepo,
  getDefaultBranchHeadSha,
  GRADE_WORKFLOW_PATH,
  syncRepoPermissions,
  updateAutograderWorkflowHash
} from "../_shared/GitHubWrapper.ts";
import { resolveTemplateRepos } from "../_shared/GitHubSyncHelpers.ts";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { resolveHandoutRepoAction, type HandoutSourceAssignment } from "../_shared/handoutRepoStrategy.ts";
import { shouldSkipRealGithubForE2eFixture } from "../_shared/e2eGithubGuard.ts";
import { describeHandoutSeedResult, seedHandoutFileHashes } from "../_shared/handoutFileHashes.ts";

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
  const handoutFullName = `${handoutRepoOrg}/${handoutRepoName}`;
  let strippedHandoutSha: string | undefined;
  if (assignment.has_autograder === false) {
    const { deleted, commit_sha } = await deleteFileFromRepo(
      handoutFullName,
      GRADE_WORKFLOW_PATH,
      "Remove autograder workflow: this assignment has no autograder",
      scope
    );
    // Keep this sha: it is the FINAL handout commit, and it is created before
    // template_repo exists in the DB below. So the template-repo push webhook for it
    // finds no assignment to attribute it to and records nothing — leaving
    // latest_template_sha null, which gives student syncs no target revision. We
    // persist it ourselves rather than relying on that delivery.
    strippedHandoutSha = commit_sha;
    // `deleted: false` means grade.yml was already gone — the shape a RETRY takes when
    // the delete succeeded but the pointer update below then failed. Without this the
    // retry would save template_repo with no latest_template_sha at all, and the
    // original deletion webhook may already have been acknowledged while no assignment
    // referenced the repo, so nothing would ever record it. Resolve the current head
    // instead of relying on a commit we cannot re-create.
    if (!deleted) {
      strippedHandoutSha = await getDefaultBranchHeadSha(handoutFullName, scope);
      scope.setTag("recovered_stripped_handout_sha", String(!!strippedHandoutSha));
    }
  } else {
    // An AUTOGRADED handout needs the pointer just as much, and nothing else was setting it.
    //
    // The reasoning above applies whether or not grade.yml is stripped: every commit in this repo
    // predates the `template_repo` write below, so the template-repo push webhook has no
    // assignment to attribute it to and `latest_template_sha` stayed NULL for the whole life of a
    // freshly created autograded assignment. That silently disabled the handout-hash seeding this
    // flow now depends on — the call at the end of this function, the one in
    // assignment-create-solution-repo, and the one in github-repo-configure-webhook all key off
    // `latest_template_sha` and returned `no_commit_sha` — so empty-submission detection had
    // nothing to compare against until an instructor happened to push to the handout.
    //
    // Best-effort: creation must not fail because a head lookup did, and the pointer is
    // re-derivable from the next handout push.
    try {
      strippedHandoutSha = await getDefaultBranchHeadSha(handoutFullName, scope);
      scope.setTag("resolved_handout_head_sha", String(!!strippedHandoutSha));
    } catch (headErr) {
      scope.setTag("resolve_handout_head_failed", "true");
      Sentry.captureException(headErr, scope);
    }
  }

  // Only persist the template_repo pointer after GitHub creation + permission
  // sync succeed, so a partial failure does not leave the assignment pointing
  // at a repo that does not exist. For pr-mode the handout IS the upstream repo
  // (students fork it and PR back to it), so point upstream_repo at the same
  // repo here — the github-repo-webhook PR ingestion matches upstream_repo
  // against the repo a PR targets, and handout == upstream must never drift.
  //
  // This has to happen BEFORE updateAutograderWorkflowHash below: that helper picks
  // the autograder rows to write via `.eq("template_repo", repoName)`, so calling it
  // first matched zero rows and silently left autograder.workflow_sha NULL — which
  // autograder-create-submission then rejects as a "workflow sha mismatch" on the
  // first real student run, and which the has_autograder backfill reads as "the
  // autograder was never wired up".
  const { error: pointerError } = await adminSupabase
    .from("assignments")
    .update({
      template_repo: handoutFullName,
      ...(strippedHandoutSha ? { latest_template_sha: strippedHandoutSha } : {}),
      ...(assignment.submission_mode === "pr" ? { upstream_repo: handoutFullName } : {})
    })
    .eq("id", assignment_id);
  if (pointerError) {
    // Reporting success here would leave the handout repo created but unreferenced:
    // nothing points at it, and a retry cannot recover latest_template_sha because
    // grade.yml is already gone (deleteFileFromRepo then reports nothing deleted).
    Sentry.captureException(pointerError, scope);
    throw pointerError;
  }

  // updateAutograderWorkflowHash is skipped for a repo-only assignment: it reads
  // grade.yml and throws "File not found" when absent, which would fail the whole
  // creation. Leaving autograder.workflow_sha NULL is correct there, since the sha
  // check only runs on the Actions-driven submission path, which no longer exists.
  if (assignment.has_autograder !== false) {
    // Pinned to the same revision `latest_template_sha` now advertises, so the hash and the tree
    // students receive describe one commit. An unqualified read would hash whatever the default
    // branch holds at this instant, which a concurrent instructor push can already have moved.
    await updateAutograderWorkflowHash(handoutFullName, strippedHandoutSha);
  }

  // Seed the handout's file hashes for the revision just pinned.
  //
  // Those rows are what let an ingested submission be recognised as "the student pushed
  // nothing of their own", and only the template-repo push webhook used to write them — which
  // never fires for a handout created here, because our commits land BEFORE template_repo
  // exists, so the webhook has no assignment to attribute them to. Without them the ingestion
  // path compares against nothing and treats an untouched starter repo as real work: on a
  // repo-only assignment, where every push is a submission, the student's first unchanged push
  // becomes their active submission even with empty submissions prohibited.
  //
  // Best-effort BY CONSTRUCTION, unlike most steps in this PR: the rows are re-derivable from
  // GitHub, the next handout push recomputes them, and a failure is visible in Sentry — so
  // failing handout creation over them would be the worse trade. It is also a no-op for a
  // brand-new assignment whose autograder config has not been read yet (no submissionFiles to
  // hash), which is why github-repo-configure-webhook seeds again once that config lands.
  const seedResult = await seedHandoutFileHashes({
    adminSupabase,
    assignmentId: assignment_id,
    classId: assignment.class_id,
    templateRepo: handoutFullName,
    commitSha: strippedHandoutSha,
    scope
  });
  scope.setTag("handout_hashes_seeded", String(seedResult.seeded));
  if (!seedResult.seeded) {
    console.log(`Not seeding handout file hashes for ${handoutFullName}: ${describeHandoutSeedResult(seedResult)}`);
  }

  return {
    repo_name: handoutRepoName,
    org_name: handoutRepoOrg,
    repo_mode: assignment.repo_mode
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
