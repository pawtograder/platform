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
  isGithubStubEnabled,
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
  const { assignment_id, class_id, expect_no_grader_repo } = (await req.json()) as AssignmentCreateSolutionRepoRequest;
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

  // Snapshot the pointer BEFORE any GitHub mutation. createRepo and syncRepoPermissions take
  // seconds to minutes, and an instructor can select a custom grader repository from the settings
  // page while they run — reading afterwards would take that new value as this request's own
  // baseline, and the stale-pointer clear below would then match it and delete an explicit choice.
  // Every later transition is conditioned on THIS observation.
  //
  // `grader_repo` already naming this repo is the discriminator that matters. While it is NULL no
  // webhook can find this assignment — handlePushToGraderSolution looks it up by that column — so
  // any SHA present is one of OUR earlier attempts and overwriting it is correct. Once it is
  // published the webhook is live and authoritative for this metadata.
  const { data: existingPointer, error: existingPointerError } = await adminSupabase
    .from("autograder")
    .select("grader_repo, latest_autograder_sha, config")
    .eq("id", assignment_id)
    .maybeSingle();
  if (existingPointerError) throw existingPointerError;
  // Specifically THIS repository, not merely any pointer. A targeted repair is often run precisely
  // because grader_repo names the WRONG repo — and webhooks for the repo we are about to attach were
  // never discoverable through that other pointer, so treating them as webhook-owned would skip the
  // metadata write and then swap the pointer underneath, leaving the previous repository's config,
  // SHA and points attached to the new one until somebody pushed.
  if (expect_no_grader_repo === true && (existingPointer?.grader_repo ?? null) !== null) {
    // An unattended caller asked to act only on an assignment with no pointer at all, and there is
    // one. Refuse WITHOUT clearing it, and refuse HERE — before createRepo, the permission sync and
    // the head/config reads. Deciding this after the GitHub work still protected the instructor's
    // pointer, but left a conventionally named solution repository behind in the course org that
    // nobody asked for and that a later legitimate creation would then collide with.
    //
    // The reconciler and the repair script's sweep check grader_repo before they call, but the
    // handout request they make first takes minutes, so an instructor can choose a custom grader
    // repository in between. This endpoint's own compare-and-set does not protect that choice — by
    // the time it reads the pointer, the custom value IS its snapshot, and the clear below is
    // written to retire exactly such a "differently named" pointer. That behaviour is right for a
    // human running a targeted repair and wrong for a sweep, and only the caller knows which it is.
    scope.setTag("grader_repo_pointer", "present_for_unattended_repair");
    console.log(
      `Not attaching ${solutionRepoFullName} to assignment ${assignment_id}: an unattended repair requires a NULL grader_repo and it holds ${existingPointer!.grader_repo}`
    );
    throw new UserVisibleError(
      `This assignment already has a grader repository (${existingPointer!.grader_repo}), so automated repair left it alone.`,
      409
    );
  }

  const pointerAlreadyPublished = (existingPointer?.grader_repo ?? null) === solutionRepoFullName;
  const expectedSha = existingPointer?.latest_autograder_sha ?? null;
  // What the metadata RPC should expect grader_repo to be when it runs. It starts as what we
  // observed and becomes NULL if we clear a stale pointer below — passing the pre-clear value there
  // would make the RPC's predicate unsatisfiable, so every stale-pointer repair would remove the old
  // pointer and then throw, leaving the assignment worse than it found it.
  let pointerExpectationForRpc: string | null = existingPointer?.grader_repo ?? null;

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

  // Under PAWTOGRADER_GITHUB_STUB the fixture guard above deliberately falls THROUGH, so createRepo
  // and syncRepoPermissions reach their stub seams and record intent. These three reads have no
  // such seam — they would query api.github.com for a repository the stub never created, and the
  // whole call would fail before persisting anything. There is no head to describe in stub mode, so
  // the metadata is skipped and the pointer below is still written, which is what the stubbed e2e
  // flows assert on.
  if (isGithubStubEnabled()) {
    scope.setTag("initial_autograder_metadata", "skipped_github_stub");
    const { error: stubPointerError } = await adminSupabase
      .from("autograder")
      .update({ grader_repo: solutionRepoFullName })
      .eq("id", assignment_id);
    if (stubPointerError) {
      Sentry.captureException(stubPointerError, scope);
      throw stubPointerError;
    }
    return { repo_name: solutionRepoName, org_name: solutionRepoOrg, stubbed: true };
  }

  const [headCommit, defaultBranch] = await Promise.all([
    getCommit(solutionRepoFullName, "HEAD", scope),
    getDefaultBranch(solutionRepoFullName, scope)
  ]);
  scope.setTag("solution_head_sha", headCommit.sha);
  // Deferring to the webhook needs THREE things: the pointer names this repo, something has been
  // recorded through it, and what was recorded is the revision this repository is actually at. A
  // matching pointer alone proves only that deliveries can be routed here, not that any landed —
  // and a recorded SHA alone proves only that one landed for SOME repository at this name.
  //
  // The third condition is what covers a targeted repair of a repo that was DELETED on GitHub after
  // its pointer was set — a shape the repair script explicitly supports. Recreating it at the same
  // conventional name leaves the old pointer and the old SHA both looking healthy, so without the
  // identity check this function fetched the replacement's head and config and then discarded both,
  // reporting success while the database kept a config and a SHA that exist in no repository.
  //
  // Decided here rather than with the other snapshot values above, because it needs the head, and
  // the head cannot be read before the stub guard has had its say.
  const webhookHasReconciled = pointerAlreadyPublished && expectedSha !== null && expectedSha === headCommit.sha;
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
      p_ref: `refs/heads/${defaultBranch}`,
      // The pointer we observed at the top of this function. The autograder settings page writes a
      // custom repository's parsed config BEFORE writing its pointer, so checking only the SHA
      // could overwrite that config with this repository's. Declining is the right answer when the
      // expectation is already stale — the instructor's selection is explicit, ours is derived.
      //
      // NULL here means "expect no pointer", not "do not care": the RPC compares with IS NOT
      // DISTINCT FROM either way. NULL is the normal value on this path, so a "do not care" reading
      // would switch the check off exactly when it is needed.
      p_expected_grader_repo: pointerExpectationForRpc,
      // The config as it stood when this function read the pointer. github-repo-configure-webhook
      // persists a newly selected repository's parsed pawtograder.yml BEFORE the settings page
      // writes the matching grader_repo, and touches neither the sha nor the pointer doing it — so
      // without this the other two predicates still matched and this call would overwrite an
      // instructor's chosen config with the derived repository's, permanently.
      p_expected_config: (existingPointer?.config ?? null) as Json,
      // The flag `points` was derived from, checked inside the same transaction that writes them.
      // An instructor toggling the autograder while the GitHub calls ran would otherwise have this
      // commit zero points for an assignment they just enabled, or the template's graded points for
      // one they just disabled — and nothing recomputes it until the next push to this repository.
      p_expected_has_autograder: assignment.has_autograder
    });
    if (error) throw error;
    return applied === true;
  };

  // Retire whatever pointer is there before we write metadata ourselves.
  //
  // This covers both shapes that reach the write below: a pointer naming a DIFFERENT repository,
  // and a same-name pointer with no SHA recorded (the recovery case). In either,
  // Until grader_repo is swapped, the OLD repo is still what handlePushToGraderSolution resolves
  // this assignment by, so a push to it during provisioning can overwrite the new repo's metadata —
  // or interleave with the write — and we would then publish the new pointer over the old repo's
  // config, SHA and points. Clearing it first makes the assignment invisible to that webhook for
  // the rest of this function, and NULL is the same state every failure path here already leaves
  // behind: unfinished and therefore repairable.
  if (!webhookHasReconciled && (existingPointer?.grader_repo ?? null) !== null) {
    scope.setTag("retired_stale_grader_repo", existingPointer!.grader_repo!);
    console.log(
      `Clearing stale grader_repo ${existingPointer!.grader_repo} on assignment ${assignment_id} before attaching ${solutionRepoFullName}`
    );
    // Conditional on the value we actually observed. An unconditional clear defeats the
    // compare-and-set on the final write further down: an instructor changing grader_repo while the
    // GitHub work runs would have their new value wiped to NULL here, and the final `.is(null)`
    // would then match and attach the conventionally derived repo over it — the exact data loss
    // that CAS exists to prevent, reintroduced two statements earlier.
    // The SHA is part of the condition, not just the repository name. A push webhook can advance
    // latest_autograder_sha between the snapshot at the top of this function and this clear — and on
    // a targeted repair of an already-published assignment that is a webhook doing its job. Without
    // the SHA here, the clear succeeded against the unchanged name, and the metadata RPC below then
    // declined against the stale expected SHA — leaving the function to throw with grader_repo NULL,
    // so the assignment was DETACHED and further pushes to it undiscoverable until another repair.
    // Including it makes a completed webhook miss this write, which aborts the repair without
    // touching anything.
    let clearWrite = adminSupabase
      .from("autograder")
      .update({ grader_repo: null })
      .eq("id", assignment_id)
      .eq("grader_repo", existingPointer!.grader_repo!);
    clearWrite =
      expectedSha === null
        ? clearWrite.is("latest_autograder_sha", null)
        : clearWrite.eq("latest_autograder_sha", expectedSha);
    const { data: clearedRows, error: clearError } = await clearWrite.select("id");
    if (clearError) {
      // Proceeding would leave the old repo webhook-discoverable for the rest of this function,
      // which is the whole thing this clear exists to prevent.
      Sentry.captureException(clearError, scope);
      throw clearError;
    }
    if ((clearedRows?.length ?? 0) === 0) {
      scope.setTag("grader_repo_pointer", "changed_before_clear");
      throw new UserVisibleError(
        `The grader repository for this assignment changed while ${solutionRepoFullName} was being created, so it was not attached. ` +
          `The repository exists — re-save if you intended to use it.`,
        409
      );
    }
    // The clear landed, so every later condition must expect NULL rather than the old value.
    pointerExpectationForRpc = null;
  }

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
  // Compare-and-set against the pointer this function is entitled to replace. An instructor can
  // save a different grader_repo from the autograder settings page while this runs, and the window
  // is not small — the value was read before several GitHub round trips. An unconditional write
  // would silently discard their explicit choice in favour of the conventionally derived name.
  //
  // Both of the conditions that have to hold at this moment — nobody else changed grader_repo while
  // we worked, and the assignment still uses a repo-backed mode — are checked inside ONE statement,
  // by publish_grader_repo. They live on different tables (`autograder` and `assignments`), so the
  // earlier version re-read the mode and then wrote the pointer, and the gap between the two FAILED
  // OPEN: an instructor opting out has the edit flow clear grader_repo to NULL, which is exactly
  // what the write's own condition expected, so the pointer was republished after the opt-out — and
  // the reconciler, which excludes no-repo modes, would never revisit it.
  //
  // Expected value: this repo's own name when the webhook already owns it and we touched nothing,
  // NULL otherwise (we either cleared a stale pointer above or never had one).
  const { data: published, error: pointerError } = await adminSupabase.rpc("publish_grader_repo", {
    p_assignment_id: assignment_id,
    p_expected_grader_repo: webhookHasReconciled ? solutionRepoFullName : null,
    p_new_grader_repo: solutionRepoFullName,
    // Rechecked here as well as in the metadata RPC, because those are two transactions. A disable
    // landing between them leaves points computed from the enabled state already committed, and
    // nothing recomputes autograder_points afterwards — so publishing would attach a repository to
    // an assignment carrying an automated allocation it can never award. Declining leaves the
    // pointer NULL, which is the repairable state.
    p_expected_has_autograder: assignment.has_autograder
  });
  if (pointerError) {
    // Same reasoning as the config write: reporting success here would leave a solution repo that
    // nothing points at, and the assignment would keep being reported as missing one.
    Sentry.captureException(pointerError, scope);
    throw pointerError;
  }
  if (published !== true) {
    // Either somebody set grader_repo to something else while we worked, or the assignment stopped
    // using repositories. Their action is explicit and ours is derived from a naming convention, so
    // theirs wins; the repository we created is left in place rather than attached over the top.
    scope.setTag("grader_repo_pointer", "superseded");
    throw new UserVisibleError(
      `This assignment's grader repository or repository configuration changed while ${solutionRepoFullName} was ` +
        `being created, so it was not attached. The repository exists — re-save if you intended to use it.`,
      409
    );
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
