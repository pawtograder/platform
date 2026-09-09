import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { AssignmentCreateSolutionRepoRequest } from "../_shared/FunctionTypes.d.ts";
import {
  createRepo,
  getCommit,
  getDefaultBranch,
  getFileFromRepo,
  syncRepoPermissions
} from "../_shared/GitHubWrapper.ts";
import { calculateTotalAutograderPoints } from "../_shared/pawtograderYmlHelpers.ts";
import { PawtograderConfig } from "../_shared/PawtograderYml.d.ts";
import { resolveTemplateRepos } from "../_shared/GitHubSyncHelpers.ts";
import { assignmentShouldHaveRepos } from "../_shared/handoutRepoStrategy.ts";
import { shouldSkipRealGithubForE2eFixture } from "../_shared/e2eGithubGuard.ts";
import { parse } from "jsr:@std/yaml";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { describeHandoutSeedResult, seedHandoutFileHashes } from "../_shared/handoutFileHashes.ts";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, class_id } = (await req.json()) as AssignmentCreateSolutionRepoRequest;
  scope?.setTag("function", "assignment-create-solution-repo");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());

  // Allow both instructor users and service role (for admin scripts)
  await assertUserIsInstructorOrServiceRole(class_id, req.headers.get("Authorization"));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("slug,repo_mode,classes(slug,github_org)")
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new UserVisibleError("Assignment not found");
  }
  if (!assignment.classes.slug) {
    throw new UserVisibleError("Class does not have a slug");
  }
  const solutionRepoName = `${assignment.classes.slug}-solution-${assignment.slug}`;
  const solutionRepoOrg = assignment.classes.github_org;
  if (!solutionRepoOrg) {
    throw new UserVisibleError("Class does not have a GitHub organization");
  }
  // Enforced HERE rather than trusted to callers. `repo_mode` can change between the moment a
  // caller decides to create a solution repo and the moment this runs — the reconciler builds a
  // repair plan from a scan that may be minutes old, and in its handout-then-solution case the
  // handout function already honours a mode change by clearing template_repo and returning a no-op.
  // Without this check the solution call that follows would still create and attach a repository to
  // an assignment that has since explicitly opted out of having any.
  if (!assignmentShouldHaveRepos(assignment.repo_mode)) {
    throw new UserVisibleError(
      `This assignment's repository configuration is "${assignment.repo_mode}", which does not use GitHub repositories.`,
      400
    );
  }

  const solutionRepoFullName = `${solutionRepoOrg}/${solutionRepoName}`;
  const { solution: solutionTemplateRepo } = await resolveTemplateRepos(adminSupabase, class_id);
  scope.setTag("solution_template_repo", solutionTemplateRepo);

  // E2E fixtures must never hit real GitHub. Return before createRepo + syncRepoPermissions +
  // getFileFromRepo (the last has no stub seam and would 404 on the fixture repo). The grader_repo
  // pointer is written HERE for this branch specifically, preserving the behaviour it had when the
  // write lived at the top of the function; the config update below is correctly skipped since it
  // depends on getFileFromRepo. Stub-record tests still fall through.
  if (
    shouldSkipRealGithubForE2eFixture({
      org: solutionRepoOrg,
      courseSlug: assignment.classes.slug,
      repoName: solutionRepoName
    })
  ) {
    const { error: e2ePointerError } = await adminSupabase
      .from("autograder")
      .update({ grader_repo: solutionRepoFullName })
      .eq("id", assignment_id);
    if (e2ePointerError) {
      // Returning `skipped: true` over a failed write would report success while grader_repo stayed
      // NULL — the same "reported done, pointer absent" state the real path refuses below.
      Sentry.captureException(e2ePointerError, scope);
      throw e2ePointerError;
    }
    return { repo_name: solutionRepoName, org_name: solutionRepoOrg, skipped: true };
  }

  await createRepo(solutionRepoOrg, solutionRepoName, solutionTemplateRepo, {}, scope);
  await syncRepoPermissions(solutionRepoOrg, solutionRepoName, assignment.classes.slug, [], scope);

  // Resolve the head BEFORE reading the config, and read the config AT that commit, so every value
  // recorded below describes one revision. An unqualified read races any push landing between the
  // two calls: config and points would come from the old tree while latest_autograder_sha and the
  // commit row named the new one — and because grader_repo is not written until the end of this
  // function, the webhook for that intervening push cannot find the assignment and is dropped, so
  // the mismatch is not self-correcting. getFileFromRepo's own parameter documentation asks for
  // exactly this, and it is the same pinning assignment-create-handout-repo does when it passes
  // strippedHandoutSha to updateAutograderWorkflowHash.
  //
  // `autograder_commits.ref` is NOT NULL and a template-generated repo inherits the template's
  // default branch, which may not be `main` — the push handlers all carry a comment about that
  // exact bug, so this asks rather than guesses.
  const [headCommit, defaultBranch] = await Promise.all([
    getCommit(solutionRepoFullName, "HEAD", scope),
    getDefaultBranch(solutionRepoFullName, scope)
  ]);
  scope.setTag("solution_head_sha", headCommit.sha);
  const graderConfig = await getFileFromRepo(solutionRepoFullName, "pawtograder.yml", scope, headCommit.sha);
  const asObj = (await parse(graderConfig.content)) as Json;
  const { error: configError } = await adminSupabase
    .from("autograder")
    .update({
      config: asObj
    })
    .eq("id", assignment_id);
  if (configError) {
    // Storing the config IS the point of reading pawtograder.yml, and everything downstream
    // depends on it: the submission-file globs, the handout hashes seeded below, and the
    // empty-submission check. Ignoring this error reported success over an assignment with a
    // solution repo and no config at all.
    Sentry.captureException(configError, scope);
    throw configError;
  }

  // Record the metadata the initial push would have carried.
  //
  // `handlePushToGraderSolution` in github-repo-webhook is what normally records these, but it
  // finds the assignment by `grader_repo` — and that pointer is deliberately written at the END of
  // this function (see below), so any push arriving before then, including the template-generation
  // push itself, is dropped. Nothing else ever writes `latest_autograder_sha`, so without this a
  // freshly created assignment carries no points, no SHA and no commit row until somebody happens
  // to push again.
  //
  // Everything is pinned to one revision: the head is resolved first and the config is read AT that
  // sha, so config, points, latest_autograder_sha and the commit row cannot describe different
  // trees. Reconciling is a closure because it runs TWICE — see the recheck after the pointer write.
  //
  // Best-effort, like the handout hash seeding below: the repository exists and is usable, the
  // values are re-derivable from the next push, and failing creation over them would be the worse
  // trade. Reported to Sentry so a persistent failure is visible.
  const reconcileHeadMetadata = async (commitSha: string, message: string, author: string | null, config: Json) => {
    const parsed = config as unknown as PawtograderConfig | null;
    const points = parsed ? calculateTotalAutograderPoints(parsed) : 0;
    scope.setTag("total_autograder_points", points.toString());
    const [{ error: pointsError }, { error: shaError }] = await Promise.all([
      adminSupabase.from("assignments").update({ autograder_points: points }).eq("id", assignment_id),
      adminSupabase.from("autograder").update({ latest_autograder_sha: commitSha }).eq("id", assignment_id)
    ]);
    if (pointsError) throw pointsError;
    if (shaError) throw shaError;
    // Same upsert shape and conflict target the push handler uses, so a later push over the same
    // commit updates this row rather than colliding with it.
    const { error: commitError } = await adminSupabase.from("autograder_commits").upsert(
      [
        {
          autograder_id: assignment_id,
          message,
          sha: commitSha,
          author,
          class_id: class_id,
          ref: `refs/heads/${defaultBranch}`
        }
      ],
      { onConflict: "autograder_id,sha" }
    );
    if (commitError) throw commitError;
  };

  try {
    await reconcileHeadMetadata(
      headCommit.sha,
      headCommit.commit.message,
      headCommit.commit.author?.name ?? null,
      asObj
    );
  } catch (metadataError) {
    scope.setTag("initial_autograder_metadata", "failed");
    Sentry.captureException(metadataError, scope);
    console.error(`Could not record initial autograder metadata for ${solutionRepoFullName}`, metadataError);
  }

  // Persist grader_repo only NOW — the same discipline assignment-create-handout-repo applies to
  // template_repo, and for the same reason. This write used to be the FIRST thing the function did,
  // which meant any later failure (a GitHub error, a permission sync, a config read, or the
  // reconciler's request timeout) left a non-NULL pointer to a repo that might not exist or might
  // have no config. Every scan that looks for unfinished work keys on this pointer being NULL, so
  // such a row became permanently invisible: never retried, never alerted, and not reachable by the
  // repair script's sweep either. Writing it last makes a NULL pointer mean exactly "this did not
  // finish", which is what the reconciler and the repair script both assume, and makes every
  // partial failure retryable — createRepo adopts the repo it already made.
  const { error: pointerError } = await adminSupabase
    .from("autograder")
    .update({ grader_repo: solutionRepoFullName })
    .eq("id", assignment_id);
  if (pointerError) {
    // Same reasoning as the config write: reporting success here would leave a solution repo that
    // nothing points at, and the assignment would keep being reported as missing one.
    Sentry.captureException(pointerError, scope);
    throw pointerError;
  }

  // Now that grader_repo is published, recheck the head once.
  //
  // A push landing between the snapshot above and the pointer write is dropped by
  // handlePushToGraderSolution — it finds the assignment by grader_repo, which was still NULL — so
  // nothing else will ever notice it, and the assignment would keep serving the config and SHA of
  // the commit before it until somebody pushed again. Any push from HERE on is discoverable,
  // because the pointer now exists, so one recheck is enough to close the window rather than
  // needing a loop.
  //
  // Costs one extra request on the common path, where the head has not moved and this is a no-op.
  // Best-effort for the same reason as the first pass.
  try {
    const currentHead = await getCommit(solutionRepoFullName, "HEAD", scope);
    if (currentHead.sha !== headCommit.sha) {
      scope.setTag("solution_head_moved_during_creation", "true");
      console.log(
        `Solution repo ${solutionRepoFullName} moved from ${headCommit.sha} to ${currentHead.sha} during creation; re-reading config`
      );
      // Re-read the config AT the new head, so the reconciled values still describe one revision.
      const newerConfig = await getFileFromRepo(solutionRepoFullName, "pawtograder.yml", scope, currentHead.sha);
      const newerObj = (await parse(newerConfig.content)) as Json;
      const { error: reconfigError } = await adminSupabase
        .from("autograder")
        .update({ config: newerObj })
        .eq("id", assignment_id);
      if (reconfigError) throw reconfigError;
      await reconcileHeadMetadata(
        currentHead.sha,
        currentHead.commit.message,
        currentHead.commit.author?.name ?? null,
        newerObj
      );
    }
  } catch (recheckError) {
    // The stored config and SHA are consistent with each other either way — they just describe an
    // older commit — so this is reportable, not fatal.
    scope.setTag("solution_head_recheck", "failed");
    Sentry.captureException(recheckError, scope);
    console.error(`Could not recheck the head of ${solutionRepoFullName} after publishing grader_repo`, recheckError);
  }

  // Seed the handout's file hashes now that submissionFiles is known.
  //
  // This is the first point in the CREATE flow where they can be computed at all:
  // assignment-create-handout-repo runs before this function, so its own seeding call finds no
  // globs and no-ops. Without these rows the ingestion path has nothing to compare a
  // submission against and reads an untouched starter repo as real work — on a repo-only
  // assignment, where every push is a submission, that makes the student's first unchanged
  // push their active submission even with empty submissions prohibited.
  //
  // Reports rather than throwing: the rows are re-derivable from GitHub and the next handout
  // push recomputes them, so they must not fail solution-repo creation.
  const { data: handoutTarget } = await adminSupabase
    .from("assignments")
    .select("template_repo, latest_template_sha")
    .eq("id", assignment_id)
    .maybeSingle();
  const seedResult = await seedHandoutFileHashes({
    adminSupabase,
    assignmentId: assignment_id,
    classId: class_id,
    templateRepo: handoutTarget?.template_repo ?? null,
    commitSha: handoutTarget?.latest_template_sha,
    scope
  });
  if (!seedResult.seeded) {
    console.log(
      `Not seeding handout file hashes for assignment ${assignment_id}: ${describeHandoutSeedResult(seedResult)}`
    );
  }

  return {
    repo_name: solutionRepoName,
    org_name: solutionRepoOrg
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
