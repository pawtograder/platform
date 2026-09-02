import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { AssignmentCreateSolutionRepoRequest } from "../_shared/FunctionTypes.d.ts";
import { createRepo, getFileFromRepo, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { resolveTemplateRepos } from "../_shared/GitHubSyncHelpers.ts";
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
    .select("slug,classes(slug,github_org)")
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
  await adminSupabase
    .from("autograder")
    .update({
      grader_repo: `${solutionRepoOrg}/${solutionRepoName}`
    })
    .eq("id", assignment_id);
  const { solution: solutionTemplateRepo } = await resolveTemplateRepos(adminSupabase, class_id);
  scope.setTag("solution_template_repo", solutionTemplateRepo);

  // E2E fixtures must never hit real GitHub. Return before createRepo + syncRepoPermissions +
  // getFileFromRepo (the last has no stub seam and would 404 on the fixture repo). The grader_repo
  // pointer update above is a harmless DB write and stays; the config update below is correctly
  // skipped since it depends on getFileFromRepo. Stub-record tests still fall through.
  if (
    shouldSkipRealGithubForE2eFixture({
      org: solutionRepoOrg,
      courseSlug: assignment.classes.slug,
      repoName: solutionRepoName
    })
  ) {
    return { repo_name: solutionRepoName, org_name: solutionRepoOrg, skipped: true };
  }

  await createRepo(solutionRepoOrg, solutionRepoName, solutionTemplateRepo, {}, scope);
  await syncRepoPermissions(solutionRepoOrg, solutionRepoName, assignment.classes.slug, [], scope);
  const graderConfig = await getFileFromRepo(`${solutionRepoOrg}/${solutionRepoName}`, "pawtograder.yml");
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
