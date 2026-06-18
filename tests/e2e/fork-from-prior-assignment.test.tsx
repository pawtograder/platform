/**
 * E2E coverage for the assignment-repo-config feature (PR #781): the
 * fork_from_prior_assignment repo_mode and the fork_merge_upstream sync
 * strategy. The production code touches GitHub through several seams
 * (assignment-create-handout-repo, assignment-create-all-repos, the
 * github-async-worker sync_repo_to_handout case). To make the chain testable
 * without an actual GitHub install, GitHubWrapper.ts has a stub seam gated on
 * PAWTOGRADER_GITHUB_STUB=1 that records each call into
 * public.e2e_github_calls instead of round-tripping to api.github.com.
 *
 * If the stub isn't active in the edge-function runtime, this suite skips
 * itself with a message explaining how to enable it. The test set is shaped
 * around the parts of the flow that the stub covers end-to-end:
 *
 *   1. mode 2 (template_with_student_forks) handout creation                    -> stub records createRepo + applyBranchProtectionRuleset
 *   2. mode 3 (fork_from_prior_assignment) handout inherits from a prior        -> no createRepo call, template_repo + latest_template_sha copied
 *   3. fork_merge_upstream sync_repo_to_handout via the async worker            -> stub records mergeForkUpstream, repository row updated
 *   4. fork_merge_upstream `dirty` fallback                                      -> skipped (requires per-test edge-runtime env override)
 *   5. DB CHECK constraint: fork_from_prior_assignment <=> source_assignment_id
 *   6. trigger enforcement: cross-class source + self-reference
 *
 * The per-student create-repo path (assignment-create-all-repos) is
 * intentionally NOT exercised end-to-end here: that function calls
 * syncRepoPermissions which is not part of the stub seam and will fail with
 * "No octokit found for organization …" on the playground org. The createRepo
 * args we'd assert against in that test are already covered by the unit tests
 * for repoCreationStrategy/buildCreateRepoArgs.
 */

import { Course } from "@/utils/supabase/DatabaseTypes";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { expect, test } from "../global-setup";
import { addDays } from "date-fns";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  supabase,
  TEST_HANDOUT_REPO,
  TestingUser
} from "./TestingUtils";

test.setTimeout(180_000);

// Module-level state populated in beforeAll. Tests check stubActive at the top
// and short-circuit when the stub seam isn't wired up in this environment.
let stubActive = false;
let stubProbeError: string | null = null;
let course: Course;
let instructor: TestingUser;
let alice: TestingUser;
let bob: TestingUser;

type GithubCallRow = {
  id: number;
  created_at: string;
  fn: string;
  args: Json;
  scope: string | null;
};

/**
 * Read every e2e_github_calls row created after `sinceIso` (exclusive). The
 * stub records rows synchronously inside the edge-function handler, so by the
 * time the handler returns the rows are visible to us via the admin client.
 * We still poll briefly to absorb any small lag on first run (Realtime fanout,
 * Supabase cold-start, etc).
 */
async function readGithubCalls(sinceCursor: string | number, opts: { minRows?: number; timeoutMs?: number } = {}) {
  const minRows = opts.minRows ?? 0;
  const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
  let rows: GithubCallRow[] = [];
  // Loop until we either see the expected number of rows or the deadline
  // elapses. Cursor can be either an ISO timestamp (string) — uses created_at —
  // or a numeric id (number) — uses id > cursor, which is race-safe across
  // back-to-back tests where the DB clock may differ from the node clock.
  while (true) {
    const query = supabase.from("e2e_github_calls").select("id, created_at, fn, args, scope");
    const filtered =
      typeof sinceCursor === "number" ? query.gt("id", sinceCursor) : query.gt("created_at", sinceCursor);
    const { data, error } = await filtered.order("id", { ascending: true });
    if (error) {
      throw new Error(`Failed to read e2e_github_calls: ${error.message}`);
    }
    rows = (data ?? []) as GithubCallRow[];
    if (rows.length >= minRows || Date.now() >= deadline) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Return the highest currently-recorded e2e_github_calls id (0 if none). Use as
 *  a baseline for filtering subsequent reads — race-free across tests. */
async function currentMaxGithubCallId(): Promise<number> {
  const { data } = await supabase
    .from("e2e_github_calls")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as number | undefined) ?? 0;
}

/**
 * Helper for the constraint tests: raw assignments inserts need a
 * self_review_setting_id (NOT NULL), but we want the CHECK / trigger to be
 * the thing that fails — not NOT NULL. Mint one of these once per class.
 */
async function createSelfReviewSetting(classId: number): Promise<number> {
  const { data, error } = await supabase
    .from("assignment_self_review_settings")
    .insert({ class_id: classId, enabled: false, deadline_offset: 2, allow_early: true })
    .select("id")
    .single();
  if (error) throw new Error(`createSelfReviewSetting failed: ${error.message}`);
  return data!.id;
}

async function currentTimestampMinusFudgeIso(): Promise<string> {
  // The stub writes `created_at` with the DB clock; tests use Node's clock to
  // pick a `since` cursor. Subtract a small fudge so we never miss a row
  // that landed on the same millisecond as our cursor.
  return new Date(Date.now() - 1_500).toISOString();
}

/**
 * Probe whether PAWTOGRADER_GITHUB_STUB is wired up in the edge-function
 * runtime. We invoke assignment-create-handout-repo against a brand-new
 * throwaway class+assignment in mode 2; if the stub is on, we'll see a
 * createRepo row appear; if not, the call either errors out trying to reach
 * GitHub or completes without recording anything.
 */
async function detectGithubStub(): Promise<{ active: boolean; error?: string }> {
  // Override via env var: useful when the harness already knows the stub is
  // enabled and wants to skip the probe (probe takes ~2s).
  if (process.env.PAWTOGRADER_E2E_STUB_AVAILABLE === "1") {
    return { active: true };
  }
  try {
    const probeClass = await createClass({ name: "Stub Probe Class" });
    const [probeInstructor] = await createUsersInClass([
      {
        name: "Stub Probe Instructor",
        public_profile_name: "Stub Probe Pseudonym Instructor",
        role: "instructor",
        class_id: probeClass.id,
        useMagicLink: true
      }
    ]);
    const probeAssignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      class_id: probeClass.id,
      name: "Stub Probe Assignment",
      repo_mode: "template_with_student_forks"
    });

    const since = await currentMaxGithubCallId();
    const { error } = await supabase.functions.invoke("assignment-create-handout-repo", {
      body: { assignment_id: probeAssignment.id, class_id: probeClass.id }
    });
    if (error) {
      return { active: false, error: `probe invoke failed: ${error.message}` };
    }
    const rows = await readGithubCalls(since, { minRows: 1, timeoutMs: 5_000 });
    // Stop using probe* state — discard it. Tests use the real `course` set
    // up below.
    void probeInstructor;
    return { active: rows.some((r) => r.fn === "createRepo") };
  } catch (e) {
    return { active: false, error: (e as Error).message };
  }
}

test.beforeAll(async () => {
  const probe = await detectGithubStub();
  stubActive = probe.active;
  stubProbeError = probe.error ?? null;
  if (!stubActive) return; // skip suite — see test.skip below
  course = await createClass({ name: "Fork Prior Class" });
  [instructor, alice, bob] = await createUsersInClass([
    {
      name: "Fork Prior Instructor",
      public_profile_name: "Fork Prior Pseudonym Instructor",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Fork Prior Student Alice",
      public_profile_name: "Fork Prior Pseudonym Alice",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Fork Prior Student Bob",
      public_profile_name: "Fork Prior Pseudonym Bob",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
});

test.afterAll(async ({}) => {
  // No-op — we intentionally leave e2e_github_calls rows behind for
  // post-mortem inspection if a CI run failed. Other tests filter by
  // created_at so leftovers don't bleed.
});

test.describe("fork_from_prior_assignment + fork_merge_upstream (PR #781)", () => {
  test("1. mode 2 (template_with_student_forks): handout creation records createRepo + ruleset", async () => {
    test.skip(
      !stubActive,
      `PAWTOGRADER_GITHUB_STUB=1 not active in edge-function env (probe: ${stubProbeError ?? "no createRepo row recorded"})`
    );

    const assignmentA = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      class_id: course.id,
      name: "Assignment A (mode 2)",
      repo_mode: "template_with_student_forks"
      // protect_* fields default (block_force_push=true, require_pr=false, reviewers=0)
    });

    const since = await currentMaxGithubCallId();
    const { error } = await supabase.functions.invoke("assignment-create-handout-repo", {
      body: { assignment_id: assignmentA.id, class_id: course.id }
    });
    expect(error).toBeNull();

    // Wait for at least the createRepo row.
    const rows = await readGithubCalls(since, { minRows: 1, timeoutMs: 10_000 });
    const createRepoRows = rows.filter((r) => r.fn === "createRepo");

    // mode 2 handout is a NON-template repo (per handoutRepoStrategy.ts:62-69).
    expect(createRepoRows.length).toBeGreaterThanOrEqual(1);
    const handoutCreate = createRepoRows[0]!;
    const args = handoutCreate.args as Record<string, unknown>;
    expect(args.org).toBe("pawtograder-playground");
    expect(args.is_template_repo).toBe(false);
    expect(args.creation_method).toBe("template");
    expect(args.template_repo).toBe("pawtograder/template-assignment-handout");
    const branchProtection = args.branch_protection as Record<string, unknown>;
    expect(branchProtection).toMatchObject({
      blockForcePush: true,
      requirePullRequest: false,
      requiredReviewers: 0
    });
    // In production, applyBranchProtectionRuleset is called INSIDE createRepo
    // (GitHubWrapper.ts) right after the GitHub create succeeds. The stub
    // short-circuits createRepo before reaching that call, so we don't
    // expect a separate ruleset row here — the configured cfg is already
    // carried in createRepo's `branch_protection` arg above.

    // The edge function should have persisted the new template_repo onto the
    // assignment so downstream consumers (mode 3 inherit) can read it.
    const { data: refreshed } = await supabase
      .from("assignments")
      .select("template_repo, slug")
      .eq("id", assignmentA.id)
      .single();
    expect(refreshed?.template_repo).toMatch(/^pawtograder-playground\/.+-handout-/);

    // Stash for test #2.
    assignmentAId = assignmentA.id;
    assignmentATemplateRepo = refreshed!.template_repo!;
  });

  test("2. mode 3 (fork_from_prior_assignment): handout inherits without creating a new repo", async () => {
    test.skip(!stubActive, "stub not active");
    test.skip(!assignmentAId, "Assignment A from test #1 not initialized — test #1 must run first");

    // Seed a latest_template_sha on assignment A so the inherit path has
    // something to copy.
    const seededSha = "abc1234567890abc1234567890abc1234567890a";
    {
      const { error } = await supabase
        .from("assignments")
        .update({ latest_template_sha: seededSha })
        .eq("id", assignmentAId!);
      expect(error).toBeNull();
    }

    const assignmentB = await insertAssignment({
      due_date: addDays(new Date(), 14).toUTCString(),
      class_id: course.id,
      name: "Assignment B (mode 3)",
      repo_mode: "fork_from_prior_assignment",
      source_assignment_id: assignmentAId!,
      protect_block_force_push: true,
      protect_require_pull_request: true,
      protect_required_reviewers: 1
    });

    const since = await currentMaxGithubCallId();
    const { error } = await supabase.functions.invoke("assignment-create-handout-repo", {
      body: { assignment_id: assignmentB.id, class_id: course.id }
    });
    expect(error).toBeNull();

    // Brief poll window: inherit_from_source MAY record nothing. We can't use
    // `minRows: 0` to detect "no row" directly, so wait a short fixed window
    // and then assert.
    await new Promise((r) => setTimeout(r, 2_000));
    const rows = await readGithubCalls(since);
    const createRepoRows = rows.filter((r) => r.fn === "createRepo");
    // The inherit branch must NOT call createRepo for the handout — that's
    // the whole point: mode 3 reuses A's handout.
    expect(createRepoRows).toEqual([]);

    // template_repo + latest_template_sha should have been copied onto B.
    const { data: assignmentBRow } = await supabase
      .from("assignments")
      .select("template_repo, latest_template_sha")
      .eq("id", assignmentB.id)
      .single();
    expect(assignmentBRow?.template_repo).toBe(assignmentATemplateRepo);
    expect(assignmentBRow?.latest_template_sha).toBe(seededSha);

    assignmentBId = assignmentB.id;
  });

  test("3. fork_merge_upstream sync via github-async-worker (default: synced)", async () => {
    test.skip(!stubActive, "stub not active");
    test.skip(!assignmentBId, "Assignment B from test #2 not initialized");
    const edgeSecret = process.env.EDGE_FUNCTION_SECRET ?? process.env.EDGE_FUNCTION_SECRET_OVERRIDE;
    test.skip(!edgeSecret, "EDGE_FUNCTION_SECRET not set in test env — required to invoke github-async-worker");

    // Insert a repositories row for Alice on Assignment B. The repo name uses
    // pawtograder-playground/ — note the worker would short-circuit if we
    // tried to drive create_repo through the queue against an e2e-ignore-*
    // courseSlug, but sync_repo_to_handout has no such short-circuit so we
    // can drive a real merge through the stub.
    const repoFullName = `pawtograder-playground/fork-prior-alice-${Date.now()}`;
    const upstreamRepo = `pawtograder-playground/fork-prior-alice-source-${Date.now()}`;
    const fromSha = "0000000000000000000000000000000000000000";
    const toSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const { data: repoRow, error: repoErr } = await supabase
      .from("repositories")
      .insert({
        class_id: course.id,
        assignment_id: assignmentBId!,
        profile_id: alice.private_profile_id,
        repository: repoFullName,
        synced_handout_sha: fromSha,
        desired_handout_sha: toSha,
        is_github_ready: true
      })
      .select("id")
      .single();
    expect(repoErr).toBeNull();
    expect(repoRow?.id).toBeTruthy();

    // Build the envelope exactly as queue_repository_syncs would. Service
    // role can send via pgmq_public.send directly, so we sidestep
    // queue_repository_syncs (which requires auth.uid()).
    const envelope = {
      method: "sync_repo_to_handout" as const,
      class_id: course.id,
      repo_id: repoRow!.id,
      args: {
        repository_id: repoRow!.id,
        repository_full_name: repoFullName,
        template_repo: assignmentATemplateRepo,
        from_sha: fromSha,
        to_sha: toSha,
        assignment_title: "Assignment B (mode 3)",
        sync_strategy: "fork_merge_upstream",
        upstream_repo_full_name: upstreamRepo
      }
    };

    const sendResult = await supabase.schema("pgmq_public").rpc("send", {
      queue_name: "async_calls",
      message: envelope as unknown as Json
    });
    expect(sendResult.error).toBeNull();

    const since = await currentMaxGithubCallId();
    // Kick the worker. It runs in the background (waitUntil) — we then poll
    // for the recorded mergeForkUpstream + the repositories row update.
    await supabase.functions
      .invoke("github-async-worker", {
        headers: { "x-edge-function-secret": edgeSecret! }
      })
      .catch(() => {
        // Worker returns 200 immediately even before doing work; ignore.
      });

    // Poll up to 60s for the merge call to appear AND the repository row to
    // be updated.
    const deadline = Date.now() + 60_000;
    let mergeRows: GithubCallRow[] = [];
    let updatedRepo: { synced_handout_sha: string | null; sync_data: Json | null } | null = null;
    while (Date.now() < deadline) {
      const rows = await readGithubCalls(since);
      mergeRows = rows.filter((r) => r.fn === "mergeForkUpstream");
      const { data } = await supabase
        .from("repositories")
        .select("synced_handout_sha, sync_data")
        .eq("id", repoRow!.id)
        .maybeSingle();
      updatedRepo = data as { synced_handout_sha: string | null; sync_data: Json | null } | null;
      if (mergeRows.length > 0 && updatedRepo?.synced_handout_sha === toSha) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }

    expect(mergeRows.length).toBeGreaterThanOrEqual(1);
    expect(mergeRows[0]!.args).toMatchObject({
      repoFullName,
      branch: "main",
      expectedUpstreamFullName: upstreamRepo
    });
    expect(updatedRepo?.synced_handout_sha).toBe(toSha);
    const syncData = updatedRepo!.sync_data as Record<string, unknown> | null;
    expect(syncData).not.toBeNull();
    expect(syncData).toMatchObject({
      status: "merged_via_fork_sync",
      sync_strategy: "fork_merge_upstream",
      upstream_repo_full_name: upstreamRepo
    });
  });

  test("4. fork_merge_upstream fallback on `dirty` (manual harness only)", async () => {
    test.skip(
      true,
      "Requires PAWTOGRADER_GITHUB_STUB_MERGE_RESULT=dirty on the edge-function runtime. Cannot " +
        "be flipped from the Node test side, since GitHubWrapper reads the env at call time inside " +
        "Deno. To run manually: stop the edge runtime, export PAWTOGRADER_GITHUB_STUB_MERGE_RESULT=dirty, " +
        "restart, then re-run this test in isolation. Expected behavior: the worker sets the " +
        "'fork_merge_upstream_fallback' Sentry scope tag to 'dirty' and falls through to the " +
        "template_pr path (which then errors out for the e2e fake repo — that's fine; the " +
        "presence of the fallback breadcrumb is the assertion). See " +
        "supabase/functions/github-async-worker/index.ts lines 1270-1278."
    );
  });

  test("5. constraint enforcement: fork mode requires source_assignment_id and vice versa", async () => {
    test.skip(!stubActive, "stub not active");

    // Case 5a: fork_from_prior_assignment + null source -> CHECK violation.
    const a1 = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Constraint Source A1"
    });
    // Reuse a self_review_setting_id (required NOT NULL on the table) so we
    // can do raw inserts and observe the CHECK firing rather than a NOT NULL
    // error masking it.
    const selfReviewId = await createSelfReviewSetting(course.id);
    const baseSlug = `constraint-fork-no-source-${Date.now()}`;
    const { error: caseAError } = await supabase.from("assignments").insert({
      title: "fork without source",
      description: "should fail CHECK",
      due_date: addDays(new Date(), 1).toUTCString(),
      template_repo: TEST_HANDOUT_REPO,
      autograder_points: 10,
      total_points: 10,
      max_late_tokens: 0,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: course.id,
      slug: baseSlug,
      group_config: "individual",
      permit_empty_submissions: true,
      self_review_setting_id: selfReviewId,
      repo_mode: "fork_from_prior_assignment",
      source_assignment_id: null
    });
    expect(caseAError).not.toBeNull();
    expect(caseAError!.message).toMatch(/assignments_source_assignment_iff_fork|check/i);

    // Case 5b: non-fork mode + non-null source -> CHECK violation.
    const { error: caseBError } = await supabase.from("assignments").insert({
      title: "template only with source",
      description: "should fail CHECK",
      due_date: addDays(new Date(), 1).toUTCString(),
      template_repo: TEST_HANDOUT_REPO,
      autograder_points: 10,
      total_points: 10,
      max_late_tokens: 0,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: course.id,
      slug: `constraint-template-with-source-${Date.now()}`,
      group_config: "individual",
      permit_empty_submissions: true,
      self_review_setting_id: selfReviewId,
      repo_mode: "template_only_staff",
      source_assignment_id: a1.id
    });
    expect(caseBError).not.toBeNull();
    expect(caseBError!.message).toMatch(/assignments_source_assignment_iff_fork|check/i);
  });

  test("6. trigger enforcement: cross-class source + self-reference", async () => {
    test.skip(!stubActive, "stub not active");

    // Two classes; assignment in class A trying to fork from assignment in class B.
    const otherClass = await createClass({ name: "Fork Prior Other Class" });
    const otherClassAssignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      class_id: otherClass.id,
      name: "Other Class Source"
    });

    // Direct insert with the foreign source — trigger should reject.
    const selfReviewId = await createSelfReviewSetting(course.id);
    const { error: crossClassErr } = await supabase.from("assignments").insert({
      title: "cross class fork",
      description: "should fail trigger",
      due_date: addDays(new Date(), 1).toUTCString(),
      template_repo: TEST_HANDOUT_REPO,
      autograder_points: 10,
      total_points: 10,
      max_late_tokens: 0,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: course.id,
      slug: `cross-class-fork-${Date.now()}`,
      group_config: "individual",
      permit_empty_submissions: true,
      self_review_setting_id: selfReviewId,
      repo_mode: "fork_from_prior_assignment",
      source_assignment_id: otherClassAssignment.id
    });
    expect(crossClassErr).not.toBeNull();
    expect(crossClassErr!.message).toMatch(/source_assignment_id .* class/i);

    // Self-reference: a fork assignment cannot point to itself. We can't INSERT
    // with self-id since the id doesn't exist yet, so we create a valid mode-3
    // chain first and then UPDATE the row to point to itself.
    const sameClassSource = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Same Class Source for Self-ref"
    });
    const targetForSelfRef = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      class_id: course.id,
      name: "Self-ref target",
      repo_mode: "fork_from_prior_assignment",
      source_assignment_id: sameClassSource.id
    });
    const { error: selfRefErr } = await supabase
      .from("assignments")
      .update({ source_assignment_id: targetForSelfRef.id })
      .eq("id", targetForSelfRef.id);
    expect(selfRefErr).not.toBeNull();
    expect(selfRefErr!.message).toMatch(/cannot reference the assignment itself|class/i);
  });
});

// Cross-test state.
let assignmentAId: number | undefined;
let assignmentATemplateRepo = "";
let assignmentBId: number | undefined;
