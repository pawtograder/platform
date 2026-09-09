import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { AssignmentCreateSolutionRepoRequest } from "../_shared/FunctionTypes.d.ts";
import { createRepo, getFileFromRepo, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
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
    await adminSupabase.from("autograder").update({ grader_repo: solutionRepoFullName }).eq("id", assignment_id);
    return { repo_name: solutionRepoName, org_name: solutionRepoOrg, skipped: true };
  }

  await createRepo(solutionRepoOrg, solutionRepoName, solutionTemplateRepo, {}, scope);
  await syncRepoPermissions(solutionRepoOrg, solutionRepoName, assignment.classes.slug, [], scope);
  const graderConfig = await getFileFromRepo(solutionRepoFullName, "pawtograder.yml");
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
