#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * RecoverEmptyRejections.ts - re-ingest push-direct submissions that were wrongly rejected as
 * "identical to the starter code".
 *
 * Why this exists: the push-direct path (github-repo-webhook, repo-only assignments) decides
 * emptiness by hashing only the files matched by the autograder's `submissionFiles` globs and
 * comparing that against `assignment_handout_file_hashes`. When those globs do not cover the files
 * students actually edit (e.g. the template default of java/arr/py/md on a TypeScript project), every
 * real push hashes to the same README-only set as the handout and is retained as an inactive,
 * fileless rejection with an `empty_submission` workflow_run_error. Fixing pawtograder.yml fixes
 * future pushes, but the rejected rows stay rejected: a webhook redelivery treats an existing
 * `empty_submission` row as final, and it skips any push that is no longer the branch head.
 *
 * What it does, for one assignment:
 *   1. Finds every push-direct submission (run_number = run_attempt = 0) carrying an
 *      `empty_submission` rejection, grouped by submitter and ordered by ordinal (= push order).
 *   2. Re-evaluates each against the CURRENT `submissionFiles` and handout hashes. Fix the config
 *      before running this. Every recorded handout revision is rehashed under the current globs
 *      (the grader-repo push only reseeds the latest one); with --apply, stale rows are rewritten.
 *   3. With --apply, re-ingests each non-empty one into the SAME submission row, so its ordinal,
 *      created_at (the original push time) and grading review are preserved, then clears
 *      is_empty_submission and deletes the rejection marker. Genuinely empty pushes stay rejected.
 *   4. With --apply, makes each affected submitter's newest gradeable push the active one, which is
 *      what the webhook would have done had the pushes been accepted. This also replaces a rejected,
 *      fileless row that someone activated by hand, and a fileless "grade anyway" stub. The swap
 *      runs in one transaction (submission_set_active_service), so the review-assignment trigger
 *      follows it to the new row.
 *
 * Deadlines are not re-checked: the webhook applies its deadline gate before inserting, so every
 * row this script touches was already on time when it was pushed.
 *
 * Safe to re-run. The rejection marker is removed only after ingestion succeeds, and files left by
 * an interrupted run are cleared before re-ingesting, so a second run picks up where the first
 * stopped.
 *
 * Usage:
 *   # Dry run (default): report what would be recovered, write nothing
 *   deno run --allow-env --allow-net --allow-read --env-file=.env.prod \
 *     supabase/functions/scripts/RecoverEmptyRejections.ts <assignment_id>
 *
 *   # Try one repository first
 *   deno run ... RecoverEmptyRejections.ts <assignment_id> --repo <owner>/<repo> --apply
 *
 *   # Everything
 *   deno run ... RecoverEmptyRejections.ts <assignment_id> --apply
 *
 * Environment Variables:
 *   SUPABASE_URL: Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY: Supabase service role key
 *   GITHUB_APP_ID: GitHub App ID
 *   GITHUB_PRIVATE_KEY_STRING: GitHub App private key
 *
 * Afterwards, backfill the code-symbol index for the recovered rows:
 *   npx tsx scripts/ReindexSubmissions.ts --assignment <assignment_id>
 */

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import micromatch from "npm:micromatch";
import { Buffer } from "node:buffer";
import { Open as openZip } from "npm:unzipper";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { PawtograderConfig } from "../_shared/PawtograderYml.d.ts";
import { cloneRepository } from "../_shared/GitHubWrapper.ts";
import {
  computeCombinedHashFromFileHashes,
  computeHandoutFileHashesForCommit,
  describeHandoutSeedResult,
  HandoutHashCaches,
  seedHandoutFileHashes,
  sha256Hex
} from "../_shared/handoutFileHashes.ts";
import {
  ingestSubmissionFilesFromZip,
  SubmissionFileTooLargeError,
  SubmissionTooLargeError
} from "../_shared/SubmissionIngestion.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";

/* eslint-disable no-console */

/** Mirrors REJECTION_ERROR_TYPES in github-repo-webhook: rows carrying these are never promoted. */
const REJECTION_ERROR_TYPES = new Set(["file_too_large", "submission_too_large", "empty_submission", "after_due_date"]);

type Submission = Pick<
  Database["public"]["Tables"]["submissions"]["Row"],
  | "id"
  | "class_id"
  | "profile_id"
  | "assignment_group_id"
  | "repository"
  | "sha"
  | "ordinal"
  | "is_active"
  | "is_not_graded"
  | "created_at"
>;

/** PostgREST caps every response at max_rows (1000), silently. Page anything that can exceed it. */
const PAGE_SIZE = 1000;

type Outcome = "recovered" | "would_recover" | "still_empty" | "unknown" | "too_large" | "error";

function parseArgs(argv: string[]) {
  const opts: { assignmentId?: number; apply: boolean; repo?: string } = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--repo") opts.repo = argv[++i];
    else if (opts.assignmentId === undefined && /^\d+$/.test(arg)) opts.assignmentId = Number(arg);
    else throw new Error(`Unrecognized argument: ${arg}`);
  }
  if (opts.assignmentId === undefined) {
    throw new Error("Usage: RecoverEmptyRejections.ts <assignment_id> [--repo owner/name] [--apply]");
  }
  return opts as { assignmentId: number; apply: boolean; repo?: string };
}

/** Submitter key, scoped exactly like the one-active-submission unique indexes. */
function submitterKey(s: Pick<Submission, "assignment_group_id" | "profile_id">): string {
  return s.assignment_group_id ? `group:${s.assignment_group_id}` : `profile:${s.profile_id}`;
}

/**
 * Every row of a query, one page at a time. `page` must build a fresh query per call (a postgrest
 * builder is mutable) with a total order, so pages neither overlap nor skip rows.
 */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE_SIZE) return out;
  }
}

async function chunkedIn<T>(ids: number[], fetch: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await fetch(ids.slice(i, i + 100))));
  return out;
}

/** Map of submission id -> rejection error_type, for the rows that carry one. */
async function loadRejections(supabase: SupabaseClient<Database>, ids: number[]): Promise<Map<number, string>> {
  const rows = await chunkedIn(ids, (chunk) =>
    fetchAll((from, to) =>
      supabase
        .from("workflow_run_error")
        .select("id, submission_id, data")
        .in("submission_id", chunk)
        .order("id")
        .range(from, to)
    )
  );
  const out = new Map<number, string>();
  for (const r of rows) {
    const t = (r.data as { error_type?: string } | null)?.error_type;
    if (r.submission_id && t && REJECTION_ERROR_TYPES.has(t)) out.set(r.submission_id, t);
  }
  return out;
}

/**
 * The emptiness hash exactly as ingestSubmissionFilesFromZip computes it (zipball top directory
 * stripped, per-file sha256, narrowed to the submissionFiles globs), without writing anything.
 * Returns null when the narrowed set is empty, which ingestion reports as "not empty".
 */
async function narrowedHash(zipBuffer: Buffer, matcher: (p: string) => boolean): Promise<string | null> {
  const zip = await openZip.buffer(zipBuffer);
  const hashes: Record<string, string> = {};
  for (const f of zip.files as { path: string; type: string; buffer: () => Promise<Buffer> }[]) {
    if (f.type !== "File") continue;
    const rel = f.path.split("/").slice(1).join("/");
    if (rel === "" || !matcher(rel)) continue;
    hashes[rel] = sha256Hex(await f.buffer());
  }
  return Object.keys(hashes).length === 0 ? null : computeCombinedHashFromFileHashes(hashes);
}

/** Remove a submission's files (storage blobs first, since the rows are the only record of the keys). */
async function clearFiles(supabase: SupabaseClient<Database>, submissionId: number) {
  const bins = await fetchAll((from, to) =>
    supabase
      .from("submission_files")
      .select("id, storage_key")
      .eq("submission_id", submissionId)
      .eq("is_binary", true)
      .order("id")
      .range(from, to)
  );
  const keys = bins.map((b) => b.storage_key).filter((k): k is string => !!k);
  // Storage remove takes at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += PAGE_SIZE) {
    const { error } = await supabase.storage.from("submission-files").remove(keys.slice(i, i + PAGE_SIZE));
    if (error) throw error;
  }
  const { error } = await supabase.from("submission_files").delete().eq("submission_id", submissionId);
  if (error) throw error;
}

async function recoverOne(
  supabase: SupabaseClient<Database>,
  sub: Submission,
  ctx: {
    assignmentId: number;
    matcher: (p: string) => boolean;
    handoutHashes: Set<string>;
    apply: boolean;
  }
): Promise<Outcome> {
  const scope = new Sentry.Scope();
  scope.setTag("script", "RecoverEmptyRejections");
  scope.setTag("submission_id", String(sub.id));
  const zipBuffer = await cloneRepository(sub.repository!, sub.sha!, scope);

  if (!ctx.apply) {
    const hash = await narrowedHash(zipBuffer, ctx.matcher);
    return hash !== null && ctx.handoutHashes.has(hash) ? "still_empty" : "would_recover";
  }

  // Leftovers from an interrupted run would collide with the re-ingest.
  await clearFiles(supabase, sub.id);
  let isEmpty: boolean | null;
  try {
    ({ isEmpty } = await ingestSubmissionFilesFromZip({
      adminSupabase: supabase,
      zipBuffer,
      submissionId: sub.id,
      classId: sub.class_id,
      profileId: sub.profile_id,
      groupId: sub.assignment_group_id,
      detectEmptyForAssignmentId: ctx.assignmentId,
      emptyHashFilter: ctx.matcher,
      scope
    }));
  } catch (e) {
    // Ingestion rolls back its own partial writes on failure. The row keeps its empty_submission
    // marker; an oversized repo is reported for a human rather than re-labelled here.
    if (e instanceof SubmissionTooLargeError || e instanceof SubmissionFileTooLargeError) return "too_large";
    throw e;
  }
  if (isEmpty !== false) {
    // Still identical to the handout (or the lookup failed): back to a fileless rejection.
    await clearFiles(supabase, sub.id);
    return isEmpty === true ? "still_empty" : "unknown";
  }

  const { error: flagErr } = await supabase.from("submissions").update({ is_empty_submission: false }).eq("id", sub.id);
  if (flagErr) throw flagErr;
  // Last, so an interruption before this point leaves the row a recognisable rejection that the
  // next run picks up again.
  const { error: markerErr } = await supabase
    .from("workflow_run_error")
    .delete()
    .eq("submission_id", sub.id)
    .eq("data->>error_type", "empty_submission");
  if (markerErr) throw markerErr;
  return "recovered";
}

/**
 * Make the submitter's newest gradeable push active. Gradeable = no rejection marker and not
 * #NOT-GRADED. Only real pushes (a sha) qualify: a "grade anyway" stub from
 * create_manual_submission_internal is fileless but always has the highest ordinal, so counting it
 * would leave exactly the students this incident stranded graded on nothing.
 */
async function reconcileActive(
  supabase: SupabaseClient<Database>,
  assignmentId: number,
  sample: Submission,
  apply: boolean,
  /** Dry run only: ids that --apply would recover, treated as no longer rejected. */
  assumeRecovered: Set<number>
): Promise<string> {
  const rows = await fetchAll((from, to) => {
    const q = supabase
      .from("submissions")
      .select("id, ordinal, is_active, is_not_graded, sha")
      .eq("assignment_id", assignmentId);
    const scoped = sample.assignment_group_id
      ? q.eq("assignment_group_id", sample.assignment_group_id)
      : q.eq("profile_id", sample.profile_id!).is("assignment_group_id", null);
    return scoped.order("ordinal", { ascending: false }).order("id", { ascending: false }).range(from, to);
  });
  const rejections = await loadRejections(
    supabase,
    rows.map((r) => r.id)
  );
  for (const id of assumeRecovered) rejections.delete(id);
  const current = rows.find((r) => r.is_active);
  const desired = rows.find((r) => r.sha && !r.is_not_graded && !rejections.has(r.id));

  const describe = (r?: { id: number; ordinal: number; sha: string | null }) =>
    r ? `#${r.ordinal} (${r.id}${rejections.has(r.id) ? ", rejected" : ""}${r.sha ? "" : ", manual stub"})` : "none";
  if (!desired) return `no gradeable push; active stays ${describe(current)}`;
  if (current?.id === desired.id) return `active already ${describe(desired)}`;
  const change = `active ${describe(current)} -> ${describe(desired)}`;
  if (!apply) return `would set ${change}`;

  // One transaction: two PostgREST updates would commit the demote alone, and the deferred
  // review-assignment trigger would then move the reviews to whatever row it falls back to.
  const { error } = await supabase.rpc("submission_set_active_service", { p_submission_id: desired.id });
  if (error) throw new Error(`set active failed, ${change}: ${error.message}`);
  return `set ${change}`;
}

/**
 * The handout hashes to compare against, keyed by handout commit, recomputed under the CURRENT
 * globs. The grader-repo push that follows a config fix reseeds only latest_template_sha, so rows
 * for older handout revisions still hold hashes over the old globs; a student on one of those
 * revisions who changed nothing would then match no row and be "recovered". With --apply, stale
 * rows are rewritten so the ingestion's own lookup sees the same values.
 */
async function currentHandoutHashes(
  supabase: SupabaseClient<Database>,
  assignmentId: number,
  patterns: string[],
  apply: boolean
): Promise<Set<string>> {
  const { data: assignment, error: assignmentErr } = await supabase
    .from("assignments")
    .select("template_repo, class_id")
    .eq("id", assignmentId)
    .single();
  if (assignmentErr) throw assignmentErr;
  if (!assignment.template_repo) throw new Error(`Assignment ${assignmentId} has no template_repo`);

  const stored = await fetchAll((from, to) =>
    supabase
      .from("assignment_handout_file_hashes")
      .select("id, sha, combined_hash")
      .eq("assignment_id", assignmentId)
      .order("id")
      .range(from, to)
  );
  if (stored.length === 0) {
    throw new Error(`Assignment ${assignmentId} has no handout hashes; every push would look non-empty`);
  }

  const scope = new Sentry.Scope();
  scope.setTag("script", "RecoverEmptyRejections");
  const caches: HandoutHashCaches = { commitTree: new Map(), blobHash: new Map() };
  const out = new Set<string>();
  for (const row of stored) {
    const { combined_hash } = await computeHandoutFileHashesForCommit({
      templateRepo: assignment.template_repo,
      commitSha: row.sha,
      expectedFiles: patterns,
      scope,
      caches
    });
    out.add(combined_hash);
    if (combined_hash === row.combined_hash) continue;
    if (!apply) {
      console.log(`Handout ${row.sha.slice(0, 7)}: stored hash is stale for the current globs; --apply rewrites it`);
      continue;
    }
    const result = await seedHandoutFileHashes({
      adminSupabase: supabase,
      assignmentId,
      classId: assignment.class_id,
      templateRepo: assignment.template_repo,
      commitSha: row.sha,
      scope,
      caches
    });
    if (!result.seeded) {
      throw new Error(`Reseeding handout ${row.sha} failed: ${describeHandoutSeedResult(result)}`);
    }
    console.log(`Handout ${row.sha.slice(0, 7)}: rewrote stale hash for the current globs`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(Deno.args);
  const supabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );

  const { data: graderRow, error: graderErr } = await supabase
    .from("autograder")
    .select("config")
    .eq("id", opts.assignmentId)
    .single();
  if (graderErr) throw graderErr;
  const sf = (graderRow.config as unknown as PawtograderConfig | null)?.submissionFiles;
  const patterns = sf ? [...(sf.files ?? []), ...(sf.testFiles ?? [])] : [];
  if (patterns.length === 0) {
    throw new Error(`Assignment ${opts.assignmentId} has no submissionFiles; nothing to re-evaluate against`);
  }
  const compiled = micromatch.matcher(patterns);
  const matcher = (p: string) => compiled(p);

  const handoutHashes = await currentHandoutHashes(supabase, opts.assignmentId, patterns, opts.apply);

  const subs = await fetchAll((from, to) => {
    const q = supabase
      .from("submissions")
      .select(
        "id, class_id, profile_id, assignment_group_id, repository, sha, ordinal, is_active, is_not_graded, created_at"
      )
      .eq("assignment_id", opts.assignmentId)
      .eq("run_number", 0)
      .eq("run_attempt", 0)
      .not("repository", "is", null);
    return (opts.repo ? q.eq("repository", opts.repo) : q)
      .order("ordinal", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  });
  const rejections = await loadRejections(
    supabase,
    subs.map((s) => s.id)
  );
  const candidates = subs.filter((s) => rejections.get(s.id) === "empty_submission");

  const bySubmitter = new Map<string, Submission[]>();
  for (const s of candidates) {
    const k = submitterKey(s);
    bySubmitter.set(k, [...(bySubmitter.get(k) ?? []), s]);
  }

  console.log(
    `${opts.apply ? "APPLY" : "DRY RUN"}: assignment ${opts.assignmentId}, globs [${patterns.join(", ")}], ` +
      `${handoutHashes.size} handout hash(es), ${candidates.length} empty rejection(s) across ${bySubmitter.size} submitter(s)`
  );

  const tally: Record<Outcome, number> = {
    recovered: 0,
    would_recover: 0,
    still_empty: 0,
    unknown: 0,
    too_large: 0,
    error: 0
  };
  for (const [key, rows] of bySubmitter) {
    console.log(`\n${rows[0].repository} (${key})`);
    let anyRecovered = false;
    const wouldRecover = new Set<number>();
    // Oldest first, so an interruption leaves history recovered as a prefix.
    for (const sub of rows) {
      let outcome: Outcome;
      try {
        outcome = await recoverOne(supabase, sub, { ...opts, handoutHashes, matcher });
      } catch (e) {
        outcome = "error";
        console.error(`  #${sub.ordinal} ${sub.id} ${sub.sha!.slice(0, 7)}: ${e instanceof Error ? e.message : e}`);
      }
      tally[outcome]++;
      if (outcome === "recovered" || outcome === "would_recover") anyRecovered = true;
      if (outcome === "would_recover") wouldRecover.add(sub.id);
      console.log(`  #${sub.ordinal} ${sub.id} ${sub.sha!.slice(0, 7)} pushed ${sub.created_at}: ${outcome}`);
    }
    // Also run when nothing was recovered but a rejected row is active (activated by hand).
    if (anyRecovered || rows.some((r) => r.is_active)) {
      try {
        console.log(`  ${await reconcileActive(supabase, opts.assignmentId, rows[0], opts.apply, wouldRecover)}`);
      } catch (e) {
        tally.error++;
        console.error(`  activation: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  console.log(`\nSummary: ${JSON.stringify(tally)}`);
  if (tally.error > 0) Deno.exit(1);
}

await main();
