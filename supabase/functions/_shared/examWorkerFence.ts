/**
 * The exam worker's ownership boundary (#1158): every call that disposes of a queue message or
 * writes match results while a message is held. Each SQL function locks the message row while its
 * read_ct is still the caller's, so it happens wholly before another reader's claim or not at all
 * (20261122130000_pgmq_public_set_vt_if_claimed.sql). Batch status writes go through
 * exam_worker_set_batch_status the same way (exam-async-worker/index.ts, setBatchStatus).
 *
 * Plain TS with a narrow client type, like examWorkerLease.ts, so a test can drive it with a fake
 * client, and the database spec (tests/e2e/exam-worker-batch-status-db.spec.ts) calls the functions
 * with these same argument builders, so a name that does not match the SQL fails a test.
 *
 * There is no fallback for a database without these functions. A fallback would have to write
 * without the claim check, which is exactly the guarantee this boundary exists for. Instead the
 * worker checks exam_worker_contract_version before it claims anything (contractStatus below), and
 * a worker deployed before its migration leaves the queue alone until the migration lands.
 */

/** The version of the SQL functions this worker needs. Matches exam_worker_contract_version(). */
export const CONTRACT_VERSION = 3;

/** A message as this reader claimed it: pgmq's id and the read_ct its read produced. */
export type Claim = { msgId: number; readCt: number };

type RpcError = { code?: string; message: string };
/** The part of the Supabase client this module uses. */
export type FenceClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

/** A database error from one of these functions, with its code (EX409 from the link guard, for one). */
export class FenceRpcError extends Error {
  constructor(
    readonly fn: string,
    readonly code: string | undefined,
    message: string
  ) {
    super(`${fn} failed: ${message}`);
    this.name = "FenceRpcError";
  }
}

async function call(client: FenceClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new FenceRpcError(fn, error.code, error.message);
  return data;
}

function unexpected(fn: string, data: unknown): never {
  throw new Error(`${fn}: unexpected reply ${JSON.stringify(data)}`);
}

function oneOf<T extends string>(fn: string, data: unknown, allowed: readonly T[]): T {
  if (typeof data === "string" && (allowed as readonly string[]).includes(data)) return data as T;
  return unexpected(fn, data);
}

// ---------------------------------------------------------------------------------------------
// Readiness: is the database's side of this boundary deployed?
// ---------------------------------------------------------------------------------------------

export type ContractStatus = { ready: true } | { ready: false; reason: string };

/**
 * PGRST202 (the function does not exist, or PostgREST has not loaded it yet) and an older version
 * mean "not deployed yet": the caller must not claim messages. Any other error is thrown, so a
 * database outage is reported as one rather than as a missing migration.
 */
export async function contractStatus(client: FenceClient): Promise<ContractStatus> {
  const { data, error } = await client.rpc("exam_worker_contract_version", {});
  if (error) {
    if (error.code === "PGRST202") return { ready: false, reason: "exam_worker_contract_version is not deployed" };
    throw new FenceRpcError("exam_worker_contract_version", error.code, error.message);
  }
  if (typeof data !== "number") return unexpected("exam_worker_contract_version", data);
  if (data < CONTRACT_VERSION) {
    return { ready: false, reason: `database contract v${data}, this worker needs v${CONTRACT_VERSION}` };
  }
  return { ready: true };
}

// ---------------------------------------------------------------------------------------------
// Disposition: acknowledge, re-queue, give up
// ---------------------------------------------------------------------------------------------

export const ackArgs = (claim: Claim) => ({ p_msg_id: claim.msgId, p_read_ct: claim.readCt });

/** Archive a handled message, only while this reader still holds it. */
export async function ack(client: FenceClient, claim: Claim): Promise<"acked" | "not_owner"> {
  return oneOf("exam_worker_ack", await call(client, "exam_worker_ack", ackArgs(claim)), [
    "acked",
    "not_owner"
  ] as const);
}

export const requeueArgs = (claim: Claim, message: unknown, delaySeconds: number, countWait: boolean) => ({
  p_msg_id: claim.msgId,
  p_read_ct: claim.readCt,
  p_message: message,
  p_delay: delaySeconds,
  p_count_wait: countWait
});

/**
 * Replace the held message with `message`, visible `delaySeconds` from now, and archive the original,
 * in one transaction. `countWait` stamps ocr_wait_from on the replacement (see ocrWait.ts).
 */
export async function requeue(
  client: FenceClient,
  claim: Claim,
  message: unknown,
  delaySeconds: number,
  countWait: boolean
): Promise<"requeued" | "not_owner"> {
  return oneOf(
    "exam_worker_requeue",
    await call(client, "exam_worker_requeue", requeueArgs(claim, message, delaySeconds, countWait)),
    ["requeued", "not_owner"] as const
  );
}

export type GiveUp = {
  /** The batch to error, or null when the message has no usable envelope. */
  batchId: number | null;
  /** The states the batch may be errored from (batchTransitions.ts). */
  from: readonly string[];
  error: string;
  errorType: string;
  /** The message body as read, recorded in both dead-letter records. */
  envelope: unknown;
};

export const giveUpArgs = (claim: Claim, g: GiveUp) => ({
  p_msg_id: claim.msgId,
  p_read_ct: claim.readCt,
  p_batch_id: g.batchId,
  p_from: [...g.from],
  p_error: g.error,
  p_error_type: g.errorType,
  p_envelope: g.envelope ?? null
});

export type GiveUpOutcome = "given_up" | "given_up:no_dlq_message" | "given_up:no_audit_row" | "not_owner";

/**
 * Error the batch, record the failure, archive the message: all of it or none of it. Throws (and so
 * leaves the message to come back) only when both dead-letter records failed.
 */
export async function giveUp(client: FenceClient, claim: Claim, g: GiveUp): Promise<GiveUpOutcome> {
  return oneOf("exam_worker_give_up", await call(client, "exam_worker_give_up", giveUpArgs(claim, g)), [
    "given_up",
    "given_up:no_dlq_message",
    "given_up:no_audit_row",
    "not_owner"
  ] as const);
}

// ---------------------------------------------------------------------------------------------
// Match-phase writes: only while the message is held and the batch is still 'matching'
// ---------------------------------------------------------------------------------------------

export type MatchWriteOutcome = "not_owner" | "state_changed";

export type LinkOutcome =
  | { outcome: "applied"; rows: unknown }
  | { outcome: "not_owner" }
  | { outcome: "state_changed" }
  // The batch's pages changed since this reader grouped them, and no other match message for the
  // batch is queued: this message is the only way the batch finishes matching.
  | { outcome: "pages_changed" };

export const linkArgs = (claim: Claim, batchId: number, groups: { exam_index: number; page_ids: number[] }[]) => ({
  p_msg_id: claim.msgId,
  p_read_ct: claim.readCt,
  p_batch_id: batchId,
  p_groups: groups
});

/** exam_link_scan_groups behind the claim and phase check. Its own errors (EX409) are thrown. */
export async function linkScanGroups(
  client: FenceClient,
  claim: Claim,
  batchId: number,
  groups: { exam_index: number; page_ids: number[] }[]
): Promise<LinkOutcome> {
  const data = await call(client, "exam_worker_link_scan_groups", linkArgs(claim, batchId, groups));
  const outcome = (data as { outcome?: unknown } | null)?.outcome;
  if (outcome === "applied") return { outcome, rows: (data as { rows?: unknown }).rows ?? [] };
  if (outcome === "not_owner") return { outcome };
  if (outcome === "state_changed") return { outcome };
  if (outcome === "pages_changed") return { outcome };
  return unexpected("exam_worker_link_scan_groups", data);
}

export type Suggestion = {
  detectedName: string | null;
  detectedSisId: string | null;
  matchedProfileId: string | null;
  confidence: number;
  /** The pages the identity was read from: the write is refused unless the exam still holds exactly these. */
  pageIds: number[];
};

export const suggestionArgs = (claim: Claim, batchId: number, scannedId: number, s: Suggestion) => ({
  p_msg_id: claim.msgId,
  p_read_ct: claim.readCt,
  p_batch_id: batchId,
  p_scanned_id: scannedId,
  p_detected_name: s.detectedName,
  p_detected_sis_id: s.detectedSisId,
  p_matched_profile_id: s.matchedProfileId,
  p_match_confidence: s.confidence,
  p_page_ids: s.pageIds
});

/**
 * The worker's suggestion for one scanned exam. "skipped" means the row is decided, holds a staff
 * member's pick, or is not in this batch: nothing to do, not an error.
 */
export async function setMatchSuggestion(
  client: FenceClient,
  claim: Claim,
  batchId: number,
  scannedId: number,
  s: Suggestion
): Promise<"applied" | "skipped" | MatchWriteOutcome> {
  return oneOf(
    "exam_worker_set_match_suggestion",
    await call(client, "exam_worker_set_match_suggestion", suggestionArgs(claim, batchId, scannedId, s)),
    ["applied", "skipped", "not_owner", "state_changed"] as const
  );
}
