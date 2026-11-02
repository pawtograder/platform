/**
 * Debounced, serialized autosave for a student's survey response, used by
 * `app/course/[course_id]/surveys/[survey_id]/page.tsx`.
 *
 * It keeps one slot: the newest snapshot of the answers that the server has not confirmed. At most
 * one write is in flight, so writes reach the server in the order the student made them, and every
 * write carries the newest snapshot, so an older snapshot is never sent after a newer one.
 *
 * Every write has a time limit. A request that never settles used to hold up the whole chain, and
 * Complete waits for that chain, so one stuck request blocked every later save and the submission.
 */

export type SaveAttempt = {
  /** Aborted when the attempt runs past `timeoutMs`. */
  signal: AbortSignal;
};

export type SurveyAutosaveQueueOptions<T> = {
  /** Writes one snapshot. Should pass `signal` on to fetch, so a timed-out request is cancelled. */
  save: (value: T, attempt: SaveAttempt) => Promise<void>;
  /**
   * Checked when a snapshot's turn comes, not when it is scheduled: Complete may have started, or
   * the response may have been submitted, while it waited. False drops the snapshot.
   */
  canSave: () => boolean;
  debounceMs: number;
  timeoutMs: number;
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

export class SurveyAutosaveQueue<T> {
  private readonly options: SurveyAutosaveQueueOptions<T>;
  /** The newest snapshot the server has not confirmed, with the edit count it was taken at. */
  private latest: { value: T; version: number } | null = null;
  private version = 0;
  private inFlight: Promise<void> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  constructor(options: SurveyAutosaveQueueOptions<T>) {
    this.options = options;
  }

  /** Records the newest answers and (re)starts the debounce. */
  schedule(value: T): void {
    this.version += 1;
    this.latest = { value, version: this.version };
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.run();
    }, this.options.debounceMs);
  }

  /** Sends the pending snapshot now instead of at the end of the debounce. */
  flush(): void {
    this.clearDebounce();
    this.run();
  }

  /** Stops starting writes (Complete is under way). A write already in flight carries on. */
  pause(): void {
    this.paused = true;
    this.clearDebounce();
  }

  resume(): void {
    this.paused = false;
  }

  /** Forgets the pending snapshot. After a successful Complete it is older than what was submitted. */
  discardPending(): void {
    this.latest = null;
    this.clearDebounce();
  }

  /** Whether there are answers the server has not confirmed, written or not. */
  hasUnsavedChanges(): boolean {
    return this.latest !== null;
  }

  /**
   * Settles once no write is in flight. Each write is bounded by `timeoutMs`, so this cannot hang.
   * Call {@link pause} first if nothing new may start afterwards.
   */
  async whenIdle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private run(): void {
    if (this.paused || this.inFlight || !this.latest) return;
    if (!this.options.canSave()) {
      this.latest = null;
      return;
    }
    const snapshot = this.latest;
    const write = runWithTimeout((signal) => this.options.save(snapshot.value, { signal }), this.options.timeoutMs)
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        // A failed write is dropped like a successful one; only a newer snapshot is still owed.
        if (this.latest?.version === snapshot.version) this.latest = null;
        this.inFlight = null;
        // A newer snapshot that arrived while this one was on the wire goes next, unless the
        // student is still typing and its debounce will send it.
        if (this.latest && !this.debounceTimer) this.run();
      });
    this.inFlight = write;
  }
}
