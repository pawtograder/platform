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
    .select("slug,repo_mode,has_autograder,classes(slug,github_org)")
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
  // Read the CURRENT pointer and SHA before snapshotting the head, so what follows is decided by
  // state observed no later than the snapshot it guards.
  //
  // `grader_repo` being already published is the discriminator that matters. While it is NULL no
  // webhook can find this assignment — handlePushToGraderSolution looks it up by that column — so
  // any SHA present is one of OUR earlier attempts, and overwriting it is correct. Once it is
  // published the webhook is live and authoritative for this metadata, and a targeted repair that
  // rewrote it would fight a writer it cannot serialize with: the webhook writes config and points
  // across several requests and only advances the SHA afterwards, so our atomic transition can
  // match the SHA it has not moved yet, replace its config and points with an older snapshot, and
  // then watch it advance the SHA over the top.
  const { data: existingPointer, error: existingPointerError } = await adminSupabase
    .from("autograder")
    .select("grader_repo, latest_autograder_sha")
    .eq("id", assignment_id)
    .maybeSingle();
  if (existingPointerError) throw existingPointerError;
  // Specifically THIS repository, not merely any pointer. A targeted repair is often run precisely
  // because grader_repo names the WRONG repo — and webhooks for the repo we are about to attach were
  // never discoverable through that other pointer, so treating them as webhook-owned would skip the
  // metadata write and then swap the pointer underneath, leaving the previous repository's config,
  // SHA and points attached to the new one until somebody pushed.
  const pointerAlreadyPublished = (existingPointer?.grader_repo ?? null) === solutionRepoFullName;
  const expectedSha = existingPointer?.latest_autograder_sha ?? null;

  const [headCommit, defaultBranch] = await Promise.all([
    getCommit(solutionRepoFullName, "HEAD", scope),
    getDefaultBranch(solutionRepoFullName, scope)
  ]);
  scope.setTag("solution_head_sha", headCommit.sha);
  const graderConfig = await getFileFromRepo(solutionRepoFullName, "pawtograder.yml", scope, headCommit.sha);
  const asObj = (await parse(graderConfig.content)) as Json;
  // The config is NOT written here. record_autograder_head_metadata below is the sole writer, so it
  // moves inside the same conditional transaction as the SHA, points and commit row.
  //
  // A standalone write used to sit here, and it survived a lost compare-and-set: on a targeted
  // repair of an already-published assignment, this update committed and then the RPC declined,
  // leaving this request's older config paired with the concurrent winner's SHA and points. Storing
  // the config is still exactly as load-bearing as it was — the submission-file globs, the handout
  // hashes seeded below and the empty-submission check all depend on it — which is why the RPC
  // failing or declining now aborts the whole function rather than being tolerated.

  // Record the metadata the initial push would have carried.
  //
  // `handlePushToGraderSolution` in github-repo-webhook is what normally records these, but it
  // finds the assignment by `grader_repo` — and that pointer is deliberately written at the END of
  // this function (see below), so any push arriving before then, including the template-generation
  // push itself, is dropped. Nothing else ever writes `latest_autograder_sha`, so without this a
  // freshly created assignment carries no points, no SHA and no commit row until somebody happens
  // to push again.
  //
  // One RPC, because the four values move together or not at all: config and latest_autograder_sha
  // on `autograder`, autograder_points on `assignments`, and a row in `autograder_commits`. They
  // span two tables, so no arrangement of PostgREST statements can condition them as a unit — every
  // ordering leaves an interleaving where a concurrent push webhook ends up with its newer SHA
  // paired with this request's older config or points. `record_autograder_head_metadata` does the
  // whole transition in one transaction, gated on the SHA we believe is current, and reports
  // whether it applied.
  //
  const recordHeadMetadata = async (
    commitSha: string,
    message: string,
    author: string | null,
    config: Json,
    previousSha: string | null
  ): Promise<boolean> => {
    const parsed = config as unknown as PawtograderConfig | null;
    // An assignment with has_autograder=false still comes through here — the create page calls this
    // for every repo-backed mode so `submissionFiles` gets loaded — but no autograder will ever run
    // for it. Copying the solution template's graded points into assignments.autograder_points
    // would have the rubric editor and the grading summary treat that as an automated-score
    // allocation and subtract it from hand-grading, so a repo-only or PR-mode assignment would show
    // points nothing can award.
    const points = assignment.has_autograder === false || !parsed ? 0 : calculateTotalAutograderPoints(parsed);
    scope.setTag("total_autograder_points", points.toString());
    const { data: applied, error } = await adminSupabase.rpc("record_autograder_head_metadata", {
      p_assignment_id: assignment_id,
      p_expected_sha: previousSha,
      p_new_sha: commitSha,
      p_config: config,
      p_points: points,
      p_message: message,
      p_author: author,
      p_ref: `refs/heads/${defaultBranch}`
    });
    if (error) throw error;
    return applied === true;
  };

  // Replacing a pointer that names a DIFFERENT repository: retire the old one first.
  //
  // Until grader_repo is swapped, the OLD repo is still what handlePushToGraderSolution resolves
  // this assignment by, so a push to it during provisioning can overwrite the new repo's metadata —
  // or interleave with the write — and we would then publish the new pointer over the old repo's
  // config, SHA and points. Clearing it first makes the assignment invisible to that webhook for
  // the rest of this function, and NULL is the same state every failure path here already leaves
  // behind: unfinished and therefore repairable.
  if (!pointerAlreadyPublished && (existingPointer?.grader_repo ?? null) !== null) {
    scope.setTag("retired_stale_grader_repo", existingPointer!.grader_repo!);
    console.log(
      `Clearing stale grader_repo ${existingPointer!.grader_repo} on assignment ${assignment_id} before attaching ${solutionRepoFullName}`
    );
    const { error: clearError } = await adminSupabase
      .from("autograder")
      .update({ grader_repo: null })
      .eq("id", assignment_id);
    if (clearError) {
      // Proceeding would leave the old repo webhook-discoverable for the rest of this function,
      // which is the whole thing this clear exists to prevent.
      Sentry.captureException(clearError, scope);
      throw clearError;
    }
  }

  // Deferring to the webhook needs BOTH: the pointer names this repo, and something has actually
  // been recorded through it. A matching pointer alone proves only that deliveries can now be
  // routed to this assignment, not that any of them ever landed — which is exactly the state the
  // repair script's --assignment recovery path exists for: a creation that wrote grader_repo and
  // then failed before storing config or a SHA. Treating that as webhook-owned made the rerun a
  // no-op that reported success while leaving the metadata missing, defeating the recovery it was
  // invoked to perform. The same shape occurs when a deleted repository is recreated under its old
  // name.
  const webhookHasReconciled = pointerAlreadyPublished && expectedSha !== null;
  if (webhookHasReconciled) {
    // The push webhook owns this metadata and is at least as current as anything we snapshotted, so
    // the repair's job here is done — the repository exists, the pointer is set, and a SHA recorded
    // through that pointer means a delivery actually reconciled it. Rewriting would be a race we
    // cannot win correctly, and the next push reconciles anything genuinely stale.
    scope.setTag("initial_autograder_metadata", "skipped_webhook_owned");
    console.log(
      `Not rewriting autograder metadata for ${solutionRepoFullName}: grader_repo names this repo and a SHA is recorded, so the push webhook owns it`
    );
  } else {
    try {
      const applied = await recordHeadMetadata(
        headCommit.sha,
        headCommit.commit.message,
        headCommit.commit.author?.name ?? null,
        asObj,
        expectedSha
      );
      if (!applied) {
        // Nothing was written, so the state is whatever the winner left — coherent, just not ours.
        // Refusing to publish the pointer keeps the assignment repairable rather than freezing it
        // half-configured.
        throw new Error(
          `Refusing to publish ${solutionRepoFullName}: latest_autograder_sha changed from ${expectedSha ?? "NULL"} while provisioning`
        );
      }
    } catch (metadataError) {
      // NOT best-effort. Publishing grader_repo after this failed would take the assignment out of
      // every repair scan while leaving it half-configured, and nothing would revisit it, because the
      // pointer is exactly what the scans key on. Failing keeps the pointer NULL, so the assignment
      // stays repairable and a retry adopts the repository that already exists.
      scope.setTag("initial_autograder_metadata", "failed");
      Sentry.captureException(metadataError, scope);
      console.error(`Could not record initial autograder metadata for ${solutionRepoFullName}`, metadataError);
      throw metadataError;
    }
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

  // There is deliberately NO post-pointer recheck here.
  //
  // One existed, to catch a push landing between the head snapshot above and the pointer write —
  // that push is dropped, because handlePushToGraderSolution finds the assignment by grader_repo
  // and it was still NULL. But the recheck was the only part of provisioning that ran concurrently
  // with a LIVE webhook: everything above happens while grader_repo is NULL, so the webhook cannot
  // find this assignment at all and no interleaving is possible.
  //
  // Closing that window properly needs both writers to share one conditional transaction, and the
  // webhook's transition is not a single statement — it writes config and points across several
  // requests and only advances latest_autograder_sha afterwards, deliberately holding the pointer
  // when a reconcile fails. Making it use record_autograder_head_metadata would mean rewriting the
  // hottest push path in the system, and its multi-autograder and pointer-hold semantics with it,
  // to fix a race that can only occur in the seconds while one brand-new repo is being provisioned.
  //
  // The cost of not having it is that such a push leaves the assignment one commit behind until the
  // next push reconciles it — which is the behaviour that already existed before this function
  // recorded any metadata at all, and 209 of 912 production assignments currently carry no
  // latest_autograder_sha whatsoever. Every attempt to close it instead produced a new interleaving.

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
