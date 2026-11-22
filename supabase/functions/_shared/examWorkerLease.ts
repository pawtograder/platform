/**
 * The exam worker's lease on the message it is running (#1158).
 *
 * The bodies are the worker's own, moved here so a test can drive them with a fake client: the
 * SQL side (pgmq_public.set_vt_if_claimed refuses a stale read_ct) is covered against a real
 * database in tests/e2e/exam-worker-batch-status-db.spec.ts, and examWorkerLease.test.ts pins
 * that the worker calls that function, with its read_ct, on the schedule described below.
 */

// While a message runs, its visibility is held at LEASE_SECONDS and renewed, so a worker that dies
// mid-message hands it back about LEASE_SECONDS later rather than READ_VISIBILITY_SECONDS later
// (#1158). While renewals succeed, a healthy message is not redelivered however long it runs, up to
// the worker's own lifetime. The read still claims for READ_VISIBILITY_SECONDS, and the message
// keeps that window until a set_vt_if_claimed call succeeds. So a worker deployed before its
// migration behaves as before, and so does a worker that dies before its first call succeeds.
export const LEASE_SECONDS = 30;
// Calls are chained, not on an interval: each starts LEASE_RENEW_MS after the previous one returns,
// so two never overlap, and each is abandoned after LEASE_RPC_TIMEOUT_MS. After a success the lease
// survives about five calls that fail at once, or two that hang until the timeout.
export const LEASE_RENEW_MS = 5_000;
export const LEASE_RPC_TIMEOUT_MS = 5_000;

// "held": the lease now ends the requested number of seconds from now. "released": this reader no
// longer holds the message. It was archived, or another reader claimed it after our lease lapsed,
// and the update is conditional on our read_ct, so that reader's claim was left alone. "failed": an
// error, a timeout or an unexpected reply. An abandoned call may still commit, so a failure is
// never taken to mean the lease is unchanged.
export type LeaseResult = "held" | "released" | "failed";

/** The claim the lease is conditional on: pgmq's message id and its read count at our read. */
export type LeasedMessage = { msg_id: number; read_ct: number };

/** The part of the Supabase client the lease uses. */
export type LeaseClient = {
  schema(name: "pgmq_public"): {
    rpc(
      fn: "set_vt_if_claimed",
      args: { queue_name: string; msg_id: number; read_ct: number; vt: number }
    ): { abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }> };
  };
};

// What went wrong, for the warning: PostgREST errors carry code and message; a throw is an Error.
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const { code, message } = e as { code?: unknown; message?: unknown };
    return [code, message].filter((x) => x !== undefined && x !== null && x !== "").join(" ") || JSON.stringify(e);
  }
  return String(e);
}

export async function setLease(
  client: LeaseClient,
  queue: string,
  msg: LeasedMessage,
  seconds: number,
  onFailure?: (reason: string) => void
): Promise<LeaseResult> {
  try {
    const { data, error } = await client
      .schema("pgmq_public")
      .rpc("set_vt_if_claimed", {
        queue_name: queue,
        msg_id: msg.msg_id,
        read_ct: msg.read_ct,
        vt: seconds
      })
      .abortSignal(AbortSignal.timeout(LEASE_RPC_TIMEOUT_MS));
    if (error || typeof data !== "boolean") {
      onFailure?.(error ? describe(error) : `unexpected reply ${JSON.stringify(data)}`);
      return "failed";
    }
    return data ? "held" : "released";
  } catch (e) {
    onFailure?.(describe(e));
    return "failed";
  }
}

// Holds the claimed message on a LEASE_SECONDS lease until the returned function is called or this
// reader no longer holds the message. Never throws. The chain runs even when the first call fails,
// because a call that timed out may have committed a lease that then needs renewing. "released" is
// not logged. After our own archive it is expected, and a takeover is logged by the reader that took
// the message. The returned function stops the chain and waits for any call in flight to return
// (at most LEASE_RPC_TIMEOUT_MS) before it resolves. Called with a number of seconds, it then sets
// the lease once more, to that. That is best effort: a call the client abandoned can still commit
// later, on a slow database, and leave the shorter lease in place. `renewMs` is for tests; the
// worker uses LEASE_RENEW_MS.
export async function holdLease(
  client: LeaseClient,
  queue: string,
  msg: LeasedMessage,
  { renewMs = LEASE_RENEW_MS }: { renewMs?: number } = {}
): Promise<(seconds?: number) => Promise<void>> {
  let stopped = false;
  let warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<LeaseResult> | undefined;
  const renew = async () => {
    let reason = "";
    inFlight = setLease(client, queue, msg, LEASE_SECONDS, (r) => (reason = r));
    const result = await inFlight;
    if (stopped || result === "released") return;
    if (result === "failed" && !warned) {
      warned = true;
      // Once per message, with the cause: a timeout, a PostgREST error (PGRST202 means the
      // migration is not applied yet), or a reply that is not a boolean.
      console.warn(`exam-async-worker lease: set_vt_if_claimed failed for msg ${msg.msg_id} (${reason}); retrying`);
    }
    timer = setTimeout(renew, renewMs);
  };
  await renew();
  return async (seconds?: number) => {
    stopped = true;
    clearTimeout(timer);
    // Wait for a call in flight in both forms, so no lease call is still open once this returns:
    // none overlaps the worker's next read, outlives runBatch, or keeps a timer alive after a
    // test. Bounded by LEASE_RPC_TIMEOUT_MS, and setLease never throws.
    await inFlight;
    if (seconds === undefined) return;
    await setLease(client, queue, msg, seconds);
  };
}
