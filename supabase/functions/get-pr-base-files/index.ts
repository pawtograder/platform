/**
 * Returns the upstream BASE tree (text files) for a pr-mode submission so the
 * Files view can render an inline base->head diff. `head` is the snapshot
 * already in `submission_files`; this supplies the other side of the diff.
 *
 * The base at a submission's (upstream_repo, base_sha) is a specific immutable
 * git commit shared by everyone submitting against that upstream PR, so the
 * result is cached CONTENT-ADDRESSED + WRITE-ONCE in `pr_base_tree_cache`:
 *   - cache hit  -> served from Postgres, zero GitHub calls
 *   - cache miss -> cloneRepository (which goes through the shared GitHub
 *                   rate-limiter + circuit-breaker) exactly once, then upsert
 *                   ON CONFLICT DO NOTHING (the row is never invalidated).
 *
 * Request:  { submission_id: number }
 * Response: { files: { "path": "contents", ... } } | { files: {}, error }
 *
 * Authorization (mirrors pr-link-confirm): caller must be enrolled in the
 * submission's class, and either staff (instructor/grader) or the submission's
 * owner (the student, or a member of the owning group). Reject otherwise.
 *
 * Resilient by design: a non-pr submission, a missing upstream/base_sha, or a
 * clone failure all return `{ files: {} }` (with an `error` string on failure)
 * so the UI degrades to the GitHub compare link rather than erroring.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cloneRepository, END_TO_END_REPO_PREFIX, getRepoToCloneConsideringE2E } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInCourse, SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { collectTextFilesFromZipBuffer } from "../_shared/SubmissionIngestion.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

type RequestBody = { submission_id: number };

export type GetPrBaseFilesResponse = {
  files: Record<string, string>;
  error?: string;
};

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<GetPrBaseFilesResponse> {
  const { submission_id }: RequestBody = await req.json();
  scope?.setTag("function", "get-pr-base-files");
  if (!submission_id) {
    throw new UserVisibleError("submission_id is required");
  }
  scope?.setTag("submission_id", String(submission_id));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Resolve the submission and its assignment's upstream repo / base sha.
  const { data: submission } = await adminSupabase
    .from("submissions")
    .select("id, class_id, assignment_id, profile_id, assignment_group_id, base_sha")
    .eq("id", submission_id)
    .maybeSingle();
  if (!submission) {
    throw new UserVisibleError("Submission not found");
  }

  // Authorize: enrolled in the class, and staff OR the submission's owner.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  const { enrollment } = await assertUserIsInCourse(submission.class_id, authHeader);
  const isStaff = enrollment.role === "instructor" || enrollment.role === "grader";
  if (!isStaff) {
    let isOwner = false;
    if (submission.profile_id) {
      isOwner = enrollment.private_profile_id === submission.profile_id;
    } else if (submission.assignment_group_id) {
      const { data: membership } = await adminSupabase
        .from("assignment_groups_members")
        .select("id")
        .eq("assignment_group_id", submission.assignment_group_id)
        .eq("profile_id", enrollment.private_profile_id)
        .maybeSingle();
      isOwner = !!membership;
    }
    if (!isOwner) {
      throw new SecurityError("You can only view your own submission");
    }
  }

  // Resolve the assignment's upstream repo separately (the submissions ->
  // assignments embed is ambiguous: assignment_id also FKs a view).
  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("upstream_repo")
    .eq("id", submission.assignment_id)
    .maybeSingle();

  const upstreamRepo = assignment?.upstream_repo ?? null;
  const baseSha = submission.base_sha;
  // Not a pr submission (or not yet snapshotted): nothing to diff against.
  if (!upstreamRepo || !baseSha) {
    return { files: {} };
  }
  scope?.setTag("upstream_repo", upstreamRepo);
  scope?.setTag("base_sha", baseSha);

  // The pr_base_tree_cache table is created in 20260607000000_pr_base_tree_cache
  // and is not in the generated Database types yet, so reach it through an
  // untyped client handle. Flagged for type regen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cacheTable = (adminSupabase as any).from("pr_base_tree_cache");

  // Cache check: content-addressed by the immutable (upstream_repo, base_sha).
  const { data: cached } = await cacheTable
    .select("files")
    .eq("upstream_repo", upstreamRepo)
    .eq("base_sha", baseSha)
    .maybeSingle();
  if (cached) {
    scope?.setTag("cache", "hit");
    return { files: (cached.files ?? {}) as Record<string, string> };
  }
  scope?.setTag("cache", "miss");

  // E2E fast path: under E2E_MOCK_GITHUB the upstream isn't a real GitHub repo,
  // so don't clone. Cache an empty base and let the UI degrade to the compare
  // link (parallels PrSubmissionFiles.ts's E2E_MOCK_GITHUB head fast path).
  const e2eMock = Deno.env.get("E2E_MOCK_GITHUB") === "true" && upstreamRepo.startsWith(END_TO_END_REPO_PREFIX);

  let files: Record<string, string> = {};
  if (!e2eMock) {
    try {
      // cloneRepository goes through getOctoKit's shared throttle (the GitHub
      // rate-limiter) + circuit-breaker. getRepoToCloneConsideringE2E resolves
      // `<real>--<suffix>` E2E repos to the real fixture repo so E2E real-clone
      // runs work.
      const zipBuffer = await cloneRepository(getRepoToCloneConsideringE2E(upstreamRepo), baseSha, scope);
      files = await collectTextFilesFromZipBuffer(zipBuffer);
    } catch (e) {
      // Degrade gracefully: surface the error so the caller falls back to the
      // GitHub compare link instead of failing the whole Files view. Do NOT
      // cache a failed fetch (so a transient clone failure can be retried).
      Sentry.captureException(e, scope);
      return { files: {}, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Write-once: the keyed commit is immutable, so a concurrent writer that beat
  // us is fine — ignore the conflict and return what we fetched.
  const { error: upsertError } = await cacheTable.upsert(
    { upstream_repo: upstreamRepo, base_sha: baseSha, files },
    { onConflict: "upstream_repo,base_sha", ignoreDuplicates: true }
  );
  if (upsertError) {
    // The fetch succeeded; a cache-write failure shouldn't fail the request.
    Sentry.captureException(upsertError, scope);
  }

  return { files };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
