/**
 * Retry helper for streaming CLI calls that can fail mid-stream from
 * transient causes the user can't act on (Supabase edge runtime CPU/wall
 * limits killing isolates, Kong gateway timeouts, undici socket resets
 * during a long chunked response).
 *
 * Used by `pawtograder assessment export` for per-assignment + gradebook
 * stream consumers. The retry happens at the whole-call boundary because
 * once we've yielded NDJSON records to the consumer we can't restart
 * mid-stream — the orchestrator buffers records into in-memory arrays and
 * only writes to disk after the stream completes, so a failed attempt is
 * safely thrown away and the call is re-issued from scratch.
 *
 * Tokens are derived from the per-run salt the CLI sends with every call,
 * so a retried call yields exactly the same data as the original (no
 * duplicate-token risk).
 */

const TRANSIENT_ERROR_PATTERNS = [
  /terminated/i, // undici socket reset (Supabase edge CPU/wall-clock kill mid-stream)
  /ECONNRESET/i,
  /socket hang up/i,
  /fetch failed/i,
  /UND_ERR_SOCKET/i,
  /\b504\b/, // Gateway Timeout from Kong / load balancer
  /\b503\b/, // BOOT_ERROR / WORKER_LIMIT from edge runtime
  /CPU time exceeded/i,
  /WORKER_LIMIT/i,
  /stream ended without \{end\}/i // edge isolate killed before handler finished
];

/**
 * Walk the error chain (`message` and `.cause` recursively) looking for any
 * level whose message looks like a transient streaming failure. Walks the
 * chain because undici wraps the underlying socket reset as `cause` and the
 * top-level message is often a generic "fetch failed" or TypeError that
 * would not match a string-only check.
 */
export function isTransientStreamError(err: unknown): boolean {
  for (let cur: unknown = err; cur != null; ) {
    const message = cur instanceof Error ? cur.message : String(cur);
    if (TRANSIENT_ERROR_PATTERNS.some((re) => re.test(message))) return true;
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : null;
  }
  return false;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Called on each retry with (attempt number, the error, the delay in ms). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/**
 * Retry an async operation on transient streaming errors with exponential
 * backoff. Non-transient errors (auth, validation, count mismatches, etc.)
 * are thrown immediately without retry — those won't recover by retrying
 * and would just delay surfacing the real problem.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransientStreamError(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      opts.onRetry?.(attempt, err, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable — the loop either returns or throws — but TS needs the line.
  throw lastErr;
}
