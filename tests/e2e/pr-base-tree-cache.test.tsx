import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// E2E coverage for FU2: the immutable PR base-tree cache + the get-pr-base-files
// edge function (the GitHub-pressure fix). Models on pr-submission-mode.test.tsx
// / pr-webhook-ingest.test.tsx.
//
// What we assert (works under E2E_MOCK_GITHUB too, where the upstream isn't a
// real GitHub repo so the function caches an EMPTY base instead of cloning):
//   * the owner can fetch base files (a { files } object; tolerate empty);
//   * a pr_base_tree_cache row is written, content-addressed by
//     (upstream_repo, base_sha);
//   * a SECOND call hits the cache: no duplicate row, fetched_at unchanged;
//   * RLS / authz: a student who doesn't own the submission, and a student in
//     another class, are denied.
//
// The upstream_repo uses the E2E student-repo prefix so that on a real-clone CI
// run getRepoToCloneConsideringE2E resolves it to the fixture repo. Under
// E2E_MOCK_GITHUB the function short-circuits to an empty cached base, so this
// suite does not depend on the clone path actually running.
//
// Requires (see AGENTS.md): `npx supabase functions serve --env-file .env.local`
// with E2E_ENABLE=true (and E2E_MOCK_GITHUB=true for the mock path).

const END_TO_END_REPO_PREFIX = "pawtograder-playground/test-e2e-student-repo";

type IngestArgs = {
  p_assignment_id: number;
  p_pr_repo: string;
  p_pr_number: number;
  p_base_sha?: string | null;
  p_head_sha?: string | null;
  p_pr_state?: string | null;
  p_profile_id?: string | null;
  p_assignment_group_id?: number | null;
  p_auto_confirm?: boolean;
};

async function ingest(args: IngestArgs) {
  return (await (supabase.rpc as CallableFunction)("ingest_pr_submission", args)) as {
    data: number | null;
    error: { message: string; code?: string } | null;
  };
}

type GetPrBaseFilesResponse = { files: Record<string, string>; error?: string };

/** Read a pr_base_tree_cache row (the table isn't in the generated types yet). */
async function readCacheRow(upstreamRepo: string, baseSha: string) {
  const { data } = await (
    supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (
            c: string,
            v: string
          ) => {
            eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: { fetched_at: string } | null }> };
          };
        };
      };
    }
  )
    .from("pr_base_tree_cache")
    .select("fetched_at")
    .eq("upstream_repo", upstreamRepo)
    .eq("base_sha", baseSha)
    .maybeSingle();
  return data;
}

/** Count pr_base_tree_cache rows for a (upstream_repo, base_sha). */
async function countCacheRows(upstreamRepo: string, baseSha: string): Promise<number> {
  const { count } = await (
    supabase as unknown as {
      from: (t: string) => {
        select: (
          c: string,
          o: { count: "exact"; head: true }
        ) => {
          eq: (c: string, v: string) => { eq: (c: string, v: string) => Promise<{ count: number | null }> };
        };
      };
    }
  )
    .from("pr_base_tree_cache")
    .select("upstream_repo", { count: "exact", head: true })
    .eq("upstream_repo", upstreamRepo)
    .eq("base_sha", baseSha);
  return count ?? 0;
}

test.describe.configure({ mode: "serial" });

test.describe("PR base-tree cache (get-pr-base-files + immutable cache + RLS)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // E2E student-repo prefix so a real-clone CI run resolves to the fixture repo.
  const UPSTREAM = `${END_TO_END_REPO_PREFIX}--pr-base-${SAFE_ID}`;
  const BASE_SHA = `base-${SAFE_ID}`;
  const HEAD_SHA = `head-${SAFE_ID}`;
  const PR_NUMBER = 101;

  let classId: number;
  let otherClassId: number;
  let owner: TestingUser;
  let nonOwner: TestingUser;
  let otherClassStudent: TestingUser;
  let assignmentId: number;
  let submissionId: number;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E PR Base Cache ${RUN_PREFIX}` });
    classId = cls.id;
    const other = await createClass({ name: `E2E PR Base Cache Other ${RUN_PREFIX}` });
    otherClassId = other.id;

    owner = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Base Owner ${RUN_PREFIX}`,
      email: `e2e-prbase-owner-${SAFE_ID}@pawtograder.net`
    });
    nonOwner = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Base NonOwner ${RUN_PREFIX}`,
      email: `e2e-prbase-nonowner-${SAFE_ID}@pawtograder.net`
    });
    otherClassStudent = await createUserInClass({
      role: "student",
      class_id: otherClassId,
      name: `PR Base Other ${RUN_PREFIX}`,
      email: `e2e-prbase-other-${SAFE_ID}@pawtograder.net`
    });

    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR Base ${RUN_PREFIX}`,
      assignment_slug: `e2e-pr-base-${SAFE_ID}`
    });
    assignmentId = a.id;
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: UPSTREAM,
        upstream_base_branch: "main",
        pr_identification: "base_branch"
      })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    // Create a confirmed, active pr-mode submission for the owner.
    const { data: subId, error } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: owner.private_profile_id,
      p_pr_repo: UPSTREAM,
      p_pr_number: PR_NUMBER,
      p_base_sha: BASE_SHA,
      p_head_sha: HEAD_SHA,
      p_pr_state: "open",
      p_auto_confirm: true
    });
    expect(error).toBeNull();
    expect(typeof subId).toBe("number");
    submissionId = subId!;

    const { data: sub } = await supabase
      .from("submissions")
      .select("base_sha, assignment_id")
      .eq("id", submissionId)
      .single();
    expect(sub?.base_sha).toBe(BASE_SHA);
  });

  // Whether the first fetch produced a cached base. True under E2E_MOCK_GITHUB
  // (an empty base is cached) and on a real-clone success. False only if a
  // real-clone of BASE_SHA failed (a synthetic sha that won't exist in the
  // fixture repo) — in which case the function returns { files: {}, error } and
  // intentionally does NOT cache the failure.
  let baseWasCached = false;

  test("owner can fetch base files; a successful fetch is cached content-addressed", async () => {
    // No cache row before the first fetch.
    expect(await countCacheRows(UPSTREAM, BASE_SHA)).toBe(0);

    const ownerClient = await createAuthenticatedClient(owner);
    const { data, error } = await ownerClient.functions.invoke<GetPrBaseFilesResponse>("get-pr-base-files", {
      body: { submission_id: submissionId }
    });
    // The function returns 200 even when the upstream clone fails (it degrades
    // to { files: {}, error }), so there is no SDK-level error.
    expect(error).toBeNull();
    // `files` is always an object (possibly empty under E2E_MOCK_GITHUB).
    expect(data?.files).toBeDefined();
    expect(typeof data?.files).toBe("object");

    baseWasCached = !data?.error;
    if (baseWasCached) {
      // A successful (incl. mock-empty) fetch writes exactly one row for this
      // immutable (upstream_repo, base_sha) — the cache is content-addressed.
      expect(await countCacheRows(UPSTREAM, BASE_SHA)).toBe(1);
    } else {
      // A failed clone is not cached, so it can be retried.
      expect(await countCacheRows(UPSTREAM, BASE_SHA)).toBe(0);
    }
  });

  test("a second call never duplicates the row and never rewrites it (write-once / immutable)", async () => {
    const before = baseWasCached ? await readCacheRow(UPSTREAM, BASE_SHA) : null;
    if (baseWasCached) {
      expect(before?.fetched_at).toBeDefined();
    }

    const ownerClient = await createAuthenticatedClient(owner);
    const { data, error } = await ownerClient.functions.invoke<GetPrBaseFilesResponse>("get-pr-base-files", {
      body: { submission_id: submissionId }
    });
    expect(error).toBeNull();
    expect(data?.files).toBeDefined();

    if (baseWasCached) {
      // Still exactly one row, and it was NOT rewritten: a cache HIT serves from
      // Postgres, so there is one GitHub fetch per (upstream_repo, base_sha) ever.
      expect(await countCacheRows(UPSTREAM, BASE_SHA)).toBe(1);
      const after = await readCacheRow(UPSTREAM, BASE_SHA);
      expect(after?.fetched_at).toBe(before?.fetched_at);
    } else {
      // Still uncached (the clone keeps failing) — but the call never errors at
      // the SDK level and never writes a bogus row.
      expect(await countCacheRows(UPSTREAM, BASE_SHA)).toBe(0);
    }
  });

  test("RLS: a student who does not own the submission is denied", async () => {
    const nonOwnerClient = await createAuthenticatedClient(nonOwner);
    const { data, error } = await nonOwnerClient.functions.invoke<GetPrBaseFilesResponse>("get-pr-base-files", {
      body: { submission_id: submissionId }
    });
    // The function throws a SecurityError (401) -> the SDK surfaces an error and
    // no base files are returned to the unauthorized caller.
    expect(error).not.toBeNull();
    expect(data?.files).toBeUndefined();
  });

  test("RLS: a student in another class is denied", async () => {
    const otherClient = await createAuthenticatedClient(otherClassStudent);
    const { data, error } = await otherClient.functions.invoke<GetPrBaseFilesResponse>("get-pr-base-files", {
      body: { submission_id: submissionId }
    });
    // assertUserIsInCourse fails for a non-enrolled caller -> SecurityError.
    expect(error).not.toBeNull();
    expect(data?.files).toBeUndefined();
  });

  test("clients cannot read pr_base_tree_cache directly (service-role only)", async () => {
    const ownerClient = await createAuthenticatedClient(owner);
    // RLS-enabled with no client policy + grants revoked => no rows (and/or a
    // permission error). Either way the client gets nothing back.
    const { data } = await (
      ownerClient as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (c: string, v: string) => Promise<{ data: unknown[] | null }>;
          };
        };
      }
    )
      .from("pr_base_tree_cache")
      .select("upstream_repo")
      .eq("upstream_repo", UPSTREAM);
    expect(data ?? []).toHaveLength(0);
  });
});
