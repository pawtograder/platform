/**
 * Debounced, serialized autosave for a student's survey response, used by
 * `app/course/[course_id]/surveys/[survey_id]/page.tsx`.
 *
 * It keeps one slot: the newest snapshot of the answers that the server has not confirmed. One save
 * request is in flight at a time, so the answers reach the server in the order the student gave
 * them, and every request carries the newest snapshot, so an older snapshot is never sent after a
 * newer one. The exception is the page being hidden or unloaded while a request is in flight: the
 * newest snapshot then goes out at once, and again afterwards if the page is still there (see
 * `sendAheadOnLeave`).
 *
 * Every request has a time limit. A request that never settles used to hold up the whole chain, and
 * Complete waits for that chain, so one stuck request blocked every later save and the submission.
 *
 * A snapshot whose request failed is kept and retried with capped exponential backoff, a few times. Then the queue
 * waits for the next edit or for {@link SurveyAutosaveQueue.retryNow} (the page calls it on the
 * browser's `online` event). While the browser is offline it does not count down retries at all:
 * it waits for `online`. The answers are only ever kept in memory and in the database.
 */

export type SaveAttempt = {
  /** Aborted when the attempt runs past `timeoutMs`. */
  signal: AbortSignal;
  /** The page is being hidden or unloaded: send the request so that it outlives the page. */
  keepalive: boolean;
};

/**
 * What the student is told about their answers.
 *
 * - `idle`: nothing has changed since the page loaded.
 * - `saving`: answers are waiting for the debounce or on the wire.
 * - `saved`: the server has every answer.
 * - `retrying`: a save failed and another attempt is scheduled or running.
 * - `offline`: a save failed while the browser is offline; the next attempt goes out on `online`.
 * - `failed`: the retries are used up; the next edit or {@link SurveyAutosaveQueue.retryNow} tries again.
 */
export type AutosaveStatus = "idle" | "saving" | "saved" | "retrying" | "offline" | "failed";

export type RetryPolicy = {
  /** Delay before the first retry. Each later retry waits twice as long as the one before. */
  baseDelayMs: number;
  /** Cap on any one delay. */
  maxDelayMs: number;
  /** Retries after the first failure, before the queue waits for an edit or `online`. */
  maxRetries: number;
};

export type SurveyAutosaveQueueOptions<T> = {
  /** Saves one snapshot. Should pass `signal` on to fetch, so a timed-out request is canceled. */
  save: (value: T, attempt: SaveAttempt) => Promise<void>;
  /**
   * Checked when a snapshot's turn comes, not when it is scheduled: Complete may have started, or
   * the response may have been submitted, while it waited. False drops the snapshot.
   */
  canSave: () => boolean;
  debounceMs: number;
  timeoutMs: number;
  retry: RetryPolicy;
  /** Whether the browser thinks it has a network. Defaults to always online. */
  isOnline?: () => boolean;
  onStatusChange?: (status: AutosaveStatus) => void;
  onError?: (error: unknown) => void;
};

export class SaveTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The save did not finish within ${timeoutMs} ms.`);
    this.name = "SaveTimeoutError";
  }
}

/**
 * Runs `operation` with an AbortSignal that fires after `timeoutMs`, and rejects with
 * {@link SaveTimeoutError} at that point even if `operation` ignores the signal.
 */
export function runWithTimeout<R>(operation: (signal: AbortSignal) => Promise<R>, timeoutMs: number): Promise<R> {
  const controller = new AbortController();
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new SaveTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    let settled: Promise<R>;
    try {
      settled = operation(controller.signal);
    } catch (error) {
      settled = Promise.reject(error);
    }
    settled.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** The delay before retry number `retry` (1 for the first retry): doubling from the base, capped. */
export function retryDelayMs(retry: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** (retry - 1), policy.maxDelayMs);
}

type SaveRequest = { done: Promise<void>; version: number; keepalive: boolean };

export class SurveyAutosaveQueue<T> {
  private readonly options: SurveyAutosaveQueueOptions<T>;
  /** The newest snapshot the server has not confirmed, with the edit count it was taken at. */
  private latest: { value: T; version: number } | null = null;
  private version = 0;
  private inFlight: SaveRequest | null = null;
  /**
   * A request {@link flush} sent on leave while `inFlight` was still running. Nothing else starts
   * until both are done, and its success does not count as saved: see {@link sendAheadOnLeave}.
   */
  private sentOnLeave: SaveRequest | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Failed attempts in a row since the last success, edit or retryNow(): what the backoff counts. */
  private failures = 0;
  /** A save failed and none has succeeded since. Keeps the warning up across new edits. */
  private unresolvedFailure = false;
  private status: AutosaveStatus = "idle";
  private paused = false;
  private disposed = false;
  /** Set by a flush on leave; the next request that starts carries it. */
  private keepaliveRequested = false;

  constructor(options: SurveyAutosaveQueueOptions<T>) {
    this.options = options;
  }

  getStatus(): AutosaveStatus {
    return this.status;
  }

  /** Records the newest answers and (re)starts the debounce. A new edit also restarts the retries. */
  schedule(value: T): void {
    if (this.disposed) return;
    this.version += 1;
    this.latest = { value, version: this.version };
    this.clearTimers();
    this.failures = 0;
    this.setStatus(this.pendingStatus());
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.run();
    }, this.options.debounceMs);
  }

  /**
   * Sends the pending snapshot now instead of at the end of the debounce or retry delay. With
   * `keepalive` (the page is being hidden or unloaded) the request is asked to outlive the page,
   * and it goes out even if a request is already in flight: see {@link sendAheadOnLeave}.
   */
  flush(options: { keepalive?: boolean } = {}): void {
    if (options.keepalive && this.latest) this.keepaliveRequested = true;
    this.clearTimers();
    if (options.keepalive && (this.inFlight || this.sentOnLeave)) this.sendAheadOnLeave();
    else this.run();
  }

  /** The network is back, or the student asked: try the pending snapshot now, with fresh retries. */
  retryNow(): void {
    if (!this.latest || this.debounceTimer) return;
    this.failures = 0;
    this.flush();
  }

  /** The browser went offline: say so if there is anything the server does not have yet. */
  noteOffline(): void {
    if (this.latest) this.setStatus("offline");
  }

  /**
   * Stops starting requests: Complete is under way, or the page is waiting to learn whether one
   * landed. A request already in flight carries on.
   */
  pause(): void {
    this.paused = true;
    this.clearTimers();
  }

  resume(): void {
    this.paused = false;
  }

  /** Forgets the pending snapshot. After a successful Complete it is older than what was submitted. */
  discardPending(): void {
    this.latest = null;
    this.keepaliveRequested = false;
    this.failures = 0;
    this.unresolvedFailure = false;
    this.clearTimers();
    this.setStatus("idle");
  }

  /**
   * The page is going away. A request in flight, and the snapshot owed after it, still go out once;
   * nothing is retried and no status is reported after this.
   */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  /** Whether there are answers the server has not confirmed, written or not. */
  hasUnsavedChanges(): boolean {
    return this.latest !== null;
  }

  /**
   * Settles once no request is in flight. Each one is bounded by `timeoutMs`, so this cannot hang.
   * Call {@link pause} first if nothing new may start afterwards.
   */
  async whenIdle(): Promise<void> {
    while (this.inFlight || this.sentOnLeave) await (this.inFlight ?? this.sentOnLeave)?.done;
  }

  private isOnline(): boolean {
    return this.options.isOnline?.() ?? true;
  }

  private failureStatus(): AutosaveStatus {
    return this.isOnline() ? "retrying" : "offline";
  }

  /**
   * The status while answers are waiting or on the wire. After a failure the warning stays up until
   * a save succeeds, rather than flipping to "saving" at every pause in typing while the network
   * is still down.
   */
  private pendingStatus(): AutosaveStatus {
    return this.unresolvedFailure || !this.isOnline() ? this.failureStatus() : "saving";
  }

  private setStatus(status: AutosaveStatus): void {
    if (this.disposed || status === this.status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * The page is being hidden or unloaded while a request is in flight. An unloading page never
   * sees that request finish, so the snapshot waiting behind it would never be sent. Send it now,
   * with keepalive, unless a keepalive request in flight already carries it.
   *
   * The two requests may reach the database in either order, so this one does not count as
   * saved. If the page stays open, the snapshot stays pending and goes out once more after both
   * are done, which keeps the newest answers last.
   */
  private sendAheadOnLeave(): void {
    const snapshot = this.latest;
    if (this.paused || this.sentOnLeave || !snapshot) return;
    if (this.inFlight?.keepalive && this.inFlight.version === snapshot.version) return;
    // A refused snapshot is dropped by run() once nothing is in flight.
    if (!this.options.canSave()) return;
    const done = runWithTimeout(
      (signal) => this.options.save(snapshot.value, { signal, keepalive: true }),
      this.options.timeoutMs
    ).then(
      () => {},
      (error) => this.options.onError?.(error)
    );
    this.sentOnLeave = {
      version: snapshot.version,
      keepalive: true,
      done: done.finally(() => {
        this.sentOnLeave = null;
        this.afterWrite();
      })
    };
  }

  private run(): void {
    if (this.paused || this.inFlight || this.sentOnLeave || !this.latest) return;
    if (!this.options.canSave()) {
      this.latest = null;
      this.keepaliveRequested = false;
      this.failures = 0;
      this.unresolvedFailure = false;
      this.setStatus("idle");
      return;
    }
    const snapshot = this.latest;
    const keepalive = this.keepaliveRequested;
    this.keepaliveRequested = false;
    this.setStatus(this.pendingStatus());
    const write = runWithTimeout(
      (signal) => this.options.save(snapshot.value, { signal, keepalive }),
      this.options.timeoutMs
    ).then(
      () => this.succeeded(snapshot.version),
      (error) => this.failed(error)
    );
    this.inFlight = {
      version: snapshot.version,
      keepalive,
      done: write.finally(() => {
        this.inFlight = null;
        this.afterWrite();
      })
    };
  }

  private succeeded(version: number): void {
    this.failures = 0;
    this.unresolvedFailure = false;
    if (this.latest?.version === version) {
      this.latest = null;
      this.keepaliveRequested = false;
      this.setStatus("saved");
    } else {
      this.setStatus("saving");
    }
  }

  private failed(error: unknown): void {
    this.options.onError?.(error);
    // The snapshot stays in `latest` (or a newer one has replaced it), so a retry sends the newest.
    this.failures += 1;
    this.unresolvedFailure = true;
    this.setStatus(this.failureStatus());
  }

  private afterWrite(): void {
    // Called as each request finishes. Nothing new starts until both slots are free.
    if (this.inFlight || this.sentOnLeave) return;
    if (this.paused || (this.disposed && this.unresolvedFailure)) return;
    if (!this.latest || this.debounceTimer) return;
    if (!this.unresolvedFailure) {
      // A newer snapshot arrived while this request was on the wire: it goes next.
      this.run();
      return;
    }
    // Offline: retrying now would fail the same way. The page calls retryNow() on `online`.
    if (!this.isOnline()) return;
    if (this.failures > this.options.retry.maxRetries) {
      this.setStatus("failed");
      return;
    }
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.run();
      },
      retryDelayMs(this.failures, this.options.retry)
    );
  }
}
