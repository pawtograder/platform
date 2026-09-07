/**
 * Per-step wall-clock instrumentation for a multi-step GitHub operation, emitted as ONE structured
 * log line per operation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Khoury production, 2026-09-07: 58 `create_repo` messages were processed by github-async-worker.
 * Per-message duration derived from pgmq (`archived_at - (vt - 300s)`, since `pgmq.read` stamps
 * `vt = read_time + sleep_seconds` and `archive` preserves it):
 *
 *     min 235.0s   p50 279.5s   p90 294.7s   max 304.0s   avg 277.6s
 *     86% of all 58 landed in a 40-second band between 260s and 300s
 *
 * In the SAME batches on the SAME pods, `sync_student_team` had p50 1.0s and `sync_staff_team`
 * p50 0.5s. So repo creation took ~4.7 minutes each and nothing in the code said where it went.
 *
 * What had already been ruled out before this module was written (do not re-litigate these from the
 * timings alone — they were checked against the incident logs directly):
 *
 *   1. Retry backoff. `retryWithBackoff` logs "...retrying in Nms (attempt X/Y)" on every retry.
 *      There are ZERO such lines in the incident window, so no ladder fired — including the worst
 *      one (get_head_sha at maxRetries 5 / baseDelayMs 3000 = 93s of sleep).
 *   2. The create-content rate limiter. Redis-backed, {reservoir 40, maxConcurrent 40, refresh
 *      40/60_000}; only 4 messages ran concurrently, so nothing queued on it. Its `schedule()` wait
 *      also happens OUTSIDE createRepo, so it is not visible here by construction.
 *   3. `waitForRepoReady` timing out: it is hard-capped at 30 attempts x 2000ms = 60s and throws a
 *      distinct UserVisibleError on timeout, which does not appear in the logs.
 *   4. The template generate call: logged at 04:01:00.673, response at 04:01:05.569 — ~5 SECONDS.
 *
 * That left ~275s per message inside a stretch of code with no instrumentation at all. This module
 * is that instrumentation. It is DIAGNOSTIC ONLY: it must not change any behavior, control flow,
 * retry parameter, or timeout.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * - ONE log line per operation, not one per step. 58 repos x ~10 steps of individual lines is
 *   unreadable and expensive to ship. Per-step lines exist but are off unless
 *   PAWTOGRADER_STEP_TIMINGS_DEBUG=1.
 * - The instrumentation can never throw and can never change what the instrumented code returns or
 *   throws. Every public method swallows its own internal failures, and `time()` re-throws the
 *   ORIGINAL error untouched after recording the elapsed time of the step that failed. A failure is
 *   exactly when the breakdown is most valuable, so partial timings must still be reported.
 * - No npm:/https: imports. This module is unit-tested from Jest (tests/unit) as well as running
 *   under Deno in the edge functions, so it stays dependency-free and takes its clock, logger, and
 *   env reader by injection (same pattern as _shared/SentryContext.ts and emailTransportConfig.ts).
 *   Sentry wiring lives in the caller, which already imports Sentry, and is passed in as a sink.
 */

/** Reads one environment variable. Injectable for tests. */
export type StepTimingsEnvReader = (key: string) => string | undefined;

// Reached through `globalThis` rather than naming `Deno` directly, and that is load-bearing for the
// WEB build, not a style choice. tsconfig.json excludes `supabase/`, but a file it excludes is still
// pulled into the program when an INCLUDED file imports it — and `tests/unit/*.test.ts` sits under
// the root `**/*.ts` include and imports this module. So a bare `Deno.env.get` here fails
// `next build` with "Cannot find name 'Deno'" even though `deno check` is perfectly happy, which is
// exactly how it reached CI unnoticed. Note the irony: keeping this module dependency-free (so Jest
// can exercise it) is what puts it in the Next program at all; the sibling modules that reference
// `Deno` freely all carry `npm:`/`jsr:` specifiers that make TypeScript skip them.
type DenoEnvGlobal = { Deno?: { env?: { get?: (key: string) => string | undefined } } };

const denoEnv: StepTimingsEnvReader = (key) => {
  try {
    // Absent under Jest, and `Deno.env.get` throws without --allow-env. Either way the debug toggle
    // is a nice-to-have; never let reading it break the operation being measured.
    return (globalThis as DenoEnvGlobal).Deno?.env?.get?.(key);
  } catch {
    return undefined;
  }
};

/**
 * Grep for this to pull every timing line out of the pod logs, e.g.
 *   kubectl logs ... | grep -F '[step-timings]' | sed 's/^.*\[step-timings\] //' | jq -s '...'
 * The prefix is deliberately stable and machine-parseable: the rest of the line is exactly one JSON
 * object, so the whole incident can be aggregated with jq without a log-parsing rule.
 */
export const STEP_TIMINGS_LOG_PREFIX = "[step-timings]";

/** Per-step lines. Off by default — see the "ONE log line per operation" constraint above. */
export const STEP_TIMINGS_DEBUG_LOG_PREFIX = "[step-timings-debug]";
export const STEP_TIMINGS_DEBUG_ENV_VAR = "PAWTOGRADER_STEP_TIMINGS_DEBUG";

export type StepTimingsMeta = Record<string, string | number | boolean>;

export type StepTimingsSnapshot = {
  /** Operation name, e.g. "create_repo". Low cardinality — safe as a Sentry tag. */
  op: string;
  /** Wall-clock ms from construction to `finish()`. */
  total_ms: number;
  /** Step name -> total ms spent in that step (summed if the step ran more than once). */
  steps: Record<string, number>;
  /** Step name -> call count, but ONLY for steps that ran more than once (e.g. the repair path). */
  repeated: Record<string, number>;
  /** Named counters, e.g. wait_for_repo_ready poll attempts. */
  counts: Record<string, number>;
  /** Sum of `steps`. */
  accounted_ms: number;
  /**
   * total_ms - accounted_ms. THE most important field for the 2026-09-07 investigation: if the
   * unexplained ~275s shows up here rather than in a named step, the time is being spent between
   * the instrumented calls (or inside a limiter/queue wrapper we have not named yet), not in any
   * single GitHub request.
   */
  unaccounted_ms: number;
  /** Name of the step with the largest total, or null if no step was recorded. */
  slowest_step: string | null;
  slowest_ms: number;
  /**
   * True when an error escaped the whole operation (see `noteEscapingError`).
   *
   * NOT "some step threw". Most steps in this path throw as a matter of routine: `waitForRepoReady`
   * polls a freshly generated repo and normally collects several 404/409s before the ref appears,
   * the duplicate-repository path is entered BY catching a 422, and `finalizeRepo` treats
   * patch_repo_settings / enable_actions / the ruleset as non-essential and logs-and-continues. An
   * earlier version flagged all of those, so a completely healthy create_repo emitted a snapshot
   * labelled as failed — which is worse than no signal when the whole point is to read 58 of these
   * lines looking for a latency outlier.
   */
  error_escaped: boolean;
  /**
   * The timed step the escaping error came from, when it is attributable — i.e. the error object
   * that escaped is the SAME object a timed step threw. Null when nothing escaped, and also null
   * when the escaping error was raised outside any timed step (e.g. `waitForRepoReady`'s
   * "did not become ready" UserVisibleError, which is thrown after its loop rather than by one of
   * the timed requests inside it; `error_escaped` is still true, and the
   * `wait_for_repo_ready_attempts` counter tells that story instead).
   */
  failed_step: string | null;
  /**
   * True when this snapshot was taken mid-operation rather than at `finish()`. Handled-failure
   * Sentry captures attach one of these, since Sentry applies scope data at CAPTURE time and those
   * captures happen long before the operation ends.
   */
  partial: boolean;
  /** Caller-supplied low-cardinality context (org, creation_method, ...). */
  meta: StepTimingsMeta;
};

/** Receives the finished snapshot. Used by the caller to push timings into Sentry. */
export type StepTimingsSink = (snapshot: StepTimingsSnapshot) => void;

export type StepTimingsOptions = {
  /** Clock. Injectable so tests are deterministic. Defaults to Date.now. */
  now?: () => number;
  /** Where the single summary line goes. Defaults to console.log. */
  log?: (line: string) => void;
  /** Env reader for the debug toggle. */
  readEnv?: StepTimingsEnvReader;
  /** Force per-step debug lines on/off, bypassing the env var. Tests use this. */
  debug?: boolean;
  /** Initial low-cardinality context. */
  meta?: StepTimingsMeta;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Coarse duration bucket, for use as a Sentry TAG. Tags are indexed and want low cardinality, so
 * the raw millisecond total belongs in a context (see StepTimingsSnapshot) and only the bucket
 * belongs in a tag. Boundaries are chosen around the measured incident: the 240-300s bucket is the
 * one 86% of the 2026-09-07 create_repo messages fell into.
 */
export function bucketDurationMs(ms: number): string {
  if (!isFiniteNumber(ms) || ms < 0) return "unknown";
  if (ms < 1_000) return "0-1s";
  if (ms < 5_000) return "1-5s";
  if (ms < 15_000) return "5-15s";
  if (ms < 60_000) return "15-60s";
  if (ms < 120_000) return "60-120s";
  if (ms < 240_000) return "120-240s";
  if (ms < 300_000) return "240-300s";
  return "300s+";
}

/**
 * Accumulates per-step elapsed times for one operation and emits a single structured line.
 *
 * Every method is failure-proof: internal bookkeeping runs inside try/catch, so a bug in this class
 * cannot take down repo creation. `time()` is the one method that touches caller control flow, and
 * it does so only by re-throwing the caller's own error.
 */
export class StepTimings {
  readonly op: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly debugEnabled: boolean;
  private readonly startedAt: number;
  private readonly stepOrder: string[] = [];
  private readonly stepMs = new Map<string, number>();
  private readonly stepCalls = new Map<string, number>();
  private readonly counters = new Map<string, number>();
  private readonly meta: StepTimingsMeta;
  private failedStep: string | null = null;
  private errorEscaped = false;
  /**
   * The most recent throw seen by `time()`, kept ONLY so an escaping error can be attributed back
   * to the step that raised it, by object identity. Holding the error itself is deliberate: matching
   * on identity is what distinguishes "this 404 was caught and retried" from "this 404 is the error
   * that killed the job".
   */
  private lastThrow: { step: string; error: unknown } | null = null;
  private finished = false;

  constructor(op: string, options: StepTimingsOptions = {}) {
    this.op = op;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line: string) => console.log(line));
    this.meta = { ...(options.meta ?? {}) };
    let debug = options.debug;
    if (debug === undefined) {
      const raw = (options.readEnv ?? denoEnv)(STEP_TIMINGS_DEBUG_ENV_VAR);
      debug = raw?.trim() === "1" || raw?.trim().toLowerCase() === "true";
    }
    this.debugEnabled = debug === true;
    this.startedAt = this.readClock();
  }

  /**
   * Run `fn`, record how long it took under `step`, and return/throw EXACTLY what `fn` did.
   *
   * On throw the elapsed time is still recorded and the original error is re-thrown unmodified —
   * the instrumentation must never mask, wrap, or delay an error, and a failed run is precisely
   * when the breakdown of the steps that DID complete matters.
   *
   * A throw here does NOT mark the operation as failed. It only remembers the error so that, IF the
   * same error later escapes the whole operation, `noteEscapingError` can attribute it to this
   * step. Callers in this codebase catch and recover from most step failures on purpose (poll
   * misses, the duplicate-repo path, the non-essential finalize settings), and flagging those would
   * label every healthy run as broken.
   */
  async time<T>(step: string, fn: () => Promise<T> | T): Promise<T> {
    const started = this.readClock();
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      this.add(step, this.readClock() - started);
      this.rememberThrow(step, error);
      throw error;
    }
    this.add(step, this.readClock() - started);
    return result;
  }

  /** Manually add elapsed ms to a step. Same accumulation semantics as `time()`. */
  add(step: string, elapsedMs: number): void {
    try {
      const ms = isFiniteNumber(elapsedMs) && elapsedMs > 0 ? Math.round(elapsedMs) : 0;
      if (!this.stepMs.has(step)) {
        this.stepOrder.push(step);
        this.stepMs.set(step, 0);
        this.stepCalls.set(step, 0);
      }
      this.stepMs.set(step, (this.stepMs.get(step) ?? 0) + ms);
      this.stepCalls.set(step, (this.stepCalls.get(step) ?? 0) + 1);
      if (this.debugEnabled) {
        this.log(`${STEP_TIMINGS_DEBUG_LOG_PREFIX} op=${this.op} step=${step} ms=${ms}`);
      }
    } catch {
      /* instrumentation must never throw */
    }
  }

  /**
   * Bump a named counter. Used for `wait_for_repo_ready_attempts`: the poll loop is capped at 30
   * attempts x 2000ms, so the attempt COUNT alone decides whether that loop contributed ~0s or the
   * full ~60s, and the elapsed time for the step cannot distinguish "returned on attempt 1 after a
   * slow request" from "polled 29 times".
   */
  count(name: string, delta = 1): void {
    try {
      if (!isFiniteNumber(delta)) return;
      this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
    } catch {
      /* instrumentation must never throw */
    }
  }

  /** Attach low-cardinality context (org, creation_method, whether the repair path ran, ...). */
  setMeta(key: string, value: string | number | boolean): void {
    try {
      this.meta[key] = value;
    } catch {
      /* instrumentation must never throw */
    }
  }

  /**
   * Record that `error` escaped the whole operation. Call from the operation wrapper's `catch`
   * (before re-throwing) — that is the only place that knows an error was NOT recovered from.
   *
   * Attribution is by object identity against the last throw a timed step produced, so a recovered
   * poll miss can never be mistaken for the fatal error, and an error re-thrown by the caller (e.g.
   * `throw createErr` after inspecting it) is still attributed to the step that originally raised
   * it. Idempotent: the first escaping error wins.
   */
  noteEscapingError(error: unknown): void {
    try {
      if (this.errorEscaped) return;
      this.errorEscaped = true;
      if (this.lastThrow && this.lastThrow.error === error) {
        this.failedStep = this.lastThrow.step;
      }
    } catch {
      /* instrumentation must never throw */
    }
  }

  /**
   * Current view of the timings. Safe to call at any point, including mid-operation: it only READS
   * the accumulators, so taking a partial snapshot for a handled-failure Sentry capture cannot
   * double-count a step, truncate the final line, or interfere with `finish()`.
   */
  snapshot(): StepTimingsSnapshot {
    const steps: Record<string, number> = {};
    const repeated: Record<string, number> = {};
    let accounted = 0;
    let slowestStep: string | null = null;
    let slowestMs = 0;
    for (const name of this.stepOrder) {
      const ms = this.stepMs.get(name) ?? 0;
      steps[name] = ms;
      accounted += ms;
      const calls = this.stepCalls.get(name) ?? 0;
      if (calls > 1) repeated[name] = calls;
      if (slowestStep === null || ms > slowestMs) {
        slowestStep = name;
        slowestMs = ms;
      }
    }
    const counts: Record<string, number> = {};
    for (const [name, value] of this.counters) counts[name] = value;
    const total = Math.max(0, Math.round(this.readClock() - this.startedAt));
    return {
      op: this.op,
      total_ms: total,
      steps,
      repeated,
      counts,
      accounted_ms: accounted,
      unaccounted_ms: total - accounted,
      slowest_step: slowestStep,
      slowest_ms: slowestMs,
      error_escaped: this.errorEscaped,
      failed_step: this.failedStep,
      // `finish()` flips `finished` BEFORE taking its snapshot, so the final line is never marked
      // partial and every mid-operation snapshot is.
      partial: !this.finished,
      meta: { ...this.meta }
    };
  }

  /**
   * Emit the single summary line and hand the snapshot to `sink` (used to attach it to the Sentry
   * scope). Call from a `finally` so it runs on both the success and the throw path.
   *
   * Idempotent: a second call is a no-op, so a nested `finally` cannot double-log. A throwing sink
   * is swallowed — pushing timings into Sentry is strictly best-effort and must not convert a
   * successful repo creation into a failure, nor replace a real error with a reporting error.
   */
  finish(sink?: StepTimingsSink): StepTimingsSnapshot | undefined {
    try {
      if (this.finished) return undefined;
      this.finished = true;
      const snapshot = this.snapshot();
      try {
        this.log(`${STEP_TIMINGS_LOG_PREFIX} ${JSON.stringify(snapshot)}`);
      } catch {
        /* a logger or serializer failure must not break the operation */
      }
      if (sink) {
        try {
          sink(snapshot);
        } catch {
          /* best-effort Sentry attachment */
        }
      }
      return snapshot;
    } catch {
      return undefined;
    }
  }

  private rememberThrow(step: string, error: unknown): void {
    try {
      this.lastThrow = { step, error };
    } catch {
      /* instrumentation must never throw */
    }
  }

  private readClock(): number {
    try {
      const value = this.now();
      return isFiniteNumber(value) ? value : 0;
    } catch {
      return 0;
    }
  }
}

/**
 * Time `fn` under `step` when `timings` is present, otherwise just run it.
 *
 * Lets the instrumented helpers take `timings` as an OPTIONAL trailing parameter, so exported
 * functions (applyBranchProtectionRuleset, called from several other edge functions) keep their
 * existing signatures and callers that do not care pay nothing.
 */
export function timeStep<T>(timings: StepTimings | undefined, step: string, fn: () => Promise<T> | T): Promise<T> | T {
  return timings ? timings.time(step, fn) : fn();
}

/** Bump a counter when timings are present. Mirrors `timeStep` for the optional-param pattern. */
export function countStep(timings: StepTimings | undefined, name: string, delta = 1): void {
  timings?.count(name, delta);
}

/**
 * The bits of `Sentry.Scope` this module writes to, described structurally so the module stays free
 * of `npm:` imports (see the header: that is what keeps it Jest-testable, and also what puts it in
 * the Next program, so it must type-check under BOTH toolchains). A real `Sentry.Scope` satisfies
 * this; so does a plain object in a test, which is how the isolation tests below can prove that
 * nothing leaks between two concurrently-running operations.
 */
export interface StepTimingsScope {
  setTag?: (key: string, value: string | number | boolean) => unknown;
  setContext?: (key: string, context: Record<string, unknown>) => unknown;
  // `level` is the literal "info", not `string`: Sentry.Scope#addBreadcrumb takes a `Breadcrumb`
  // whose level is a `SeverityLevel` union, and a widened `string` here makes Sentry.Scope fail to
  // satisfy this interface (parameters are checked contravariantly), which `deno check` catches as
  // TS2345 at the call site.
  addBreadcrumb?: (breadcrumb: {
    message: string;
    category: string;
    level: "info";
    data: Record<string, unknown>;
  }) => unknown;
}

/**
 * Attach a snapshot to ONE scope: full breakdown as context, a few indexed tags, and a breadcrumb.
 *
 * SCOPE ISOLATION — why everything here goes through the passed-in `scope` and nothing through the
 * module-level `Sentry.*` helpers. `processBatch` runs `drainConcurrency` (default 4) envelopes
 * concurrently under `Promise.allSettled` and hands the SAME Sentry.Scope to every
 * `processEnvelope`. `processEnvelope` then does `_scope.clone()` per envelope
 * (github-async-worker/index.ts:613, and Scope.clone() copies _tags/_contexts/_breadcrumbs by
 * value), so the scope OBJECT that reaches createRepo is already per-message and writing to it is
 * safe. `Sentry.addBreadcrumb()` is NOT: it writes to the ISOLATION scope
 * (@sentry/core breadcrumbs.js -> getIsolationScope().addBreadcrumb), which all four concurrent
 * messages share, so an earlier version of this code interleaved four repos' timing breadcrumbs
 * onto every event in the isolate. Hence `scope.addBreadcrumb(...)`, never `Sentry.addBreadcrumb`.
 *
 * TAG NAMESPACING — tag keys are prefixed with the operation name because a single create_repo
 * message runs TWO instrumented operations against the same envelope scope (createRepo, then
 * syncRepoPermissions). Unprefixed keys meant the second one silently overwrote the first one's
 * slowest step, bucket and counters, so an event could report `wait_for_repo_ready_attempts` from
 * createRepo next to sync_repo_permissions' totals. Two operations x a handful of keys keeps
 * cardinality trivial, and each operation's tags can now be filtered on independently.
 *
 * Tags vs context is deliberate: tags are indexed and want low cardinality, so only the slowest
 * step's NAME, a coarse duration BUCKET, the escaped/partial booleans, the failing step, and the
 * small integer counters go in tags. The full millisecond breakdown is a JSON blob and belongs in
 * `setContext`, where it is displayed but not indexed.
 *
 * Never throws: this is diagnostics attached to an operation that is often already failing.
 */
export function attachSnapshotToScope(snapshot: StepTimingsSnapshot, scope?: StepTimingsScope): void {
  if (!scope) return;
  try {
    const prefix = `step_timings_${snapshot.op}`;
    scope.setContext?.(prefix, snapshot as unknown as Record<string, unknown>);
    scope.setTag?.(`${prefix}_slowest_step`, snapshot.slowest_step ?? "none");
    scope.setTag?.(`${prefix}_total_bucket`, bucketDurationMs(snapshot.total_ms));
    // A partial snapshot is a mid-operation view, so its total and step list are incomplete by
    // construction. Tag it, or the two kinds of event are indistinguishable in Bugsink and someone
    // will read a partial total as an operation duration.
    scope.setTag?.(`${prefix}_partial`, String(snapshot.partial));
    scope.setTag?.(`${prefix}_error_escaped`, String(snapshot.error_escaped));
    if (snapshot.failed_step) {
      scope.setTag?.(`${prefix}_failed_step`, snapshot.failed_step);
    }
    // Counters are small integers (poll attempts, collaborator writes), so they are tag-safe and
    // are the fields we most want to filter on: `wait_for_repo_ready_attempts` alone distinguishes
    // "returned immediately" from "burned the full 30 x 2000ms = 60s poll budget".
    for (const [name, value] of Object.entries(snapshot.counts)) {
      scope.setTag?.(`${prefix}_${name}`, String(value));
    }
    scope.addBreadcrumb?.({
      message: `step timings ${snapshot.op}`,
      category: "timing",
      level: "info",
      data: snapshot as unknown as Record<string, unknown>
    });
  } catch {
    /* diagnostics must never break the operation they describe */
  }
}
