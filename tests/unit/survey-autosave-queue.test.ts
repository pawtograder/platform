/**
 * Tests for lib/surveyAutosaveQueue.ts, the debounced autosave behind the student survey page.
 *
 * What it must guarantee: save requests reach the server one at a time and in order, every request
 * carries the newest answers, and no single request can block the ones behind it (or Complete, which
 * waits for the queue) for longer than its time limit. A failed save is retried with capped backoff,
 * a few times, and while offline it waits for the network instead; the status says which.
 */
import {
  retryDelayMs,
  runWithTimeout,
  SaveTimeoutError,
  SurveyAutosaveQueue,
  type AutosaveStatus,
  type SaveAttempt,
  type SurveyAutosaveQueueOptions
} from "@/lib/surveyAutosaveQueue";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake transport: each request waits until the test settles it. */
function fakeServer() {
  const writes: { value: string; signal: AbortSignal; keepalive: boolean; done: Deferred }[] = [];
  const save = jest.fn((value: string, { signal, keepalive }: SaveAttempt) => {
    const done = deferred();
    writes.push({ value, signal, keepalive, done });
    return done.promise;
  });
  return { writes, save };
}

// Lets promise callbacks run between timer steps.
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("runWithTimeout", () => {
  test("aborts the signal and rejects once the time limit passes", async () => {
    let seenSignal: AbortSignal | undefined;
    const result = runWithTimeout((signal) => {
      seenSignal = signal;
      return new Promise<void>(() => {});
    }, 10_000);
    const outcome = result.then(
      () => "resolved",
      (error) => error
    );

    jest.advanceTimersByTime(9_999);
    await settle();
    expect(seenSignal?.aborted).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(outcome).resolves.toBeInstanceOf(SaveTimeoutError);
    expect(seenSignal?.aborted).toBe(true);
  });

  test("passes through a result that arrives in time", async () => {
    await expect(runWithTimeout(async () => "saved", 10_000)).resolves.toBe("saved");
  });
});

const retry = { baseDelayMs: 1_000, maxDelayMs: 8_000, maxRetries: 4 };

describe("retryDelayMs", () => {
  test("doubles from the base delay and stops at the cap", () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(attempt, retry))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000
    ]);
  });
});

describe("SurveyAutosaveQueue", () => {
  const makeQueue = (
    save: (value: string, attempt: SaveAttempt) => Promise<void>,
    canSave = () => true,
    overrides: Partial<SurveyAutosaveQueueOptions<string>> = {}
  ) => new SurveyAutosaveQueue<string>({ save, canSave, debounceMs: 1_000, timeoutMs: 10_000, retry, ...overrides });

  test("writes only the last of a burst of edits, after the debounce", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("a");
    jest.advanceTimersByTime(500);
    queue.schedule("ab");
    jest.advanceTimersByTime(999);
    expect(server.save).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(server.writes.map((write) => write.value)).toEqual(["ab"]);
  });

  test("holds a newer snapshot until the older request finishes", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("older");
    jest.advanceTimersByTime(1_000);
    queue.schedule("newer");
    jest.advanceTimersByTime(1_000);
    // One request at a time: "newer" waits behind "older".
    expect(server.writes.map((write) => write.value)).toEqual(["older"]);

    server.writes[0].done.resolve();
    await settle();
    expect(server.writes.map((write) => write.value)).toEqual(["older", "newer"]);
  });

  test("sends only the newest of several snapshots queued behind a slow request", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("first");
    jest.advanceTimersByTime(1_000);
    queue.schedule("second");
    jest.advanceTimersByTime(1_000);
    queue.schedule("third");
    jest.advanceTimersByTime(1_000);

    server.writes[0].done.resolve();
    await settle();
    expect(server.writes.map((write) => write.value)).toEqual(["first", "third"]);
  });

  test("gives up on a request that never settles and sends the newer snapshot", async () => {
    const server = fakeServer();
    const onError = jest.fn();
    const queue = makeQueue(server.save, () => true, { onError });

    queue.schedule("stuck");
    jest.advanceTimersByTime(1_000);
    queue.schedule("next");
    jest.advanceTimersByTime(1_000);
    expect(server.writes).toHaveLength(1);

    jest.advanceTimersByTime(9_000);
    await settle();
    expect(server.writes[0].signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(SaveTimeoutError));
    // The timeout counts as a failure, so the newer snapshot goes out after the first retry delay.
    jest.advanceTimersByTime(1_000);
    expect(server.writes.map((write) => write.value)).toEqual(["stuck", "next"]);
  });

  test("whenIdle settles once a stuck request times out", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);
    queue.schedule("stuck");
    queue.flush();

    let idle = false;
    void queue.whenIdle().then(() => {
      idle = true;
    });
    jest.advanceTimersByTime(9_999);
    await settle();
    expect(idle).toBe(false);

    jest.advanceTimersByTime(1);
    await settle();
    expect(idle).toBe(true);
  });

  test("starts nothing while paused, and drops what canSave refuses", async () => {
    const server = fakeServer();
    let allowed = true;
    const queue = makeQueue(server.save, () => allowed);

    queue.schedule("while paused");
    queue.pause();
    jest.advanceTimersByTime(5_000);
    queue.flush();
    expect(server.save).not.toHaveBeenCalled();

    queue.resume();
    allowed = false;
    queue.flush();
    expect(server.save).not.toHaveBeenCalled();
    expect(queue.hasUnsavedChanges()).toBe(false);
  });

  test("flush sends the pending snapshot without waiting for the debounce", () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("typed");
    queue.flush();
    expect(server.writes.map((write) => [write.value, write.keepalive])).toEqual([["typed", false]]);
    jest.advanceTimersByTime(1_000);
    expect(server.writes).toHaveLength(1);
  });

  test("a flush on leave asks for keepalive", () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("typed before leaving");
    queue.flush({ keepalive: true });
    expect(server.writes.map((write) => [write.value, write.keepalive])).toEqual([["typed before leaving", true]]);
  });

  test("a flush on leave sends the newest answers at once, even behind a request in flight", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("older");
    jest.advanceTimersByTime(1_000);
    queue.schedule("typed before leaving");
    // An unloading page never sees the older request finish, so waiting for it would lose this.
    queue.flush({ keepalive: true });
    expect(server.writes.map((write) => [write.value, write.keepalive])).toEqual([
      ["older", false],
      ["typed before leaving", true]
    ]);

    // The page stayed open (a tab switch). The two requests could reach the database in either
    // order, so once both are done the newest answers go out once more, last.
    server.writes[0].done.resolve();
    await settle();
    expect(server.writes).toHaveLength(2);
    server.writes[1].done.resolve();
    await settle();
    expect(server.writes.map((write) => write.value)).toEqual([
      "older",
      "typed before leaving",
      "typed before leaving"
    ]);
    expect(queue.getStatus()).toBe("saving");
    server.writes[2].done.resolve();
    await settle();
    expect(queue.getStatus()).toBe("saved");

    // Later edits on a page that stayed open go out as ordinary requests again.
    queue.schedule("back on the page");
    jest.advanceTimersByTime(1_000);
    expect(server.writes[3]).toMatchObject({ value: "back on the page", keepalive: false });
  });

  test("a second flush on leave does not resend what a keepalive request already carries", () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("typed before leaving");
    // A reload fires both pagehide and visibilitychange.
    queue.flush({ keepalive: true });
    queue.flush({ keepalive: true });
    expect(server.writes).toHaveLength(1);
  });

  test("whenIdle also waits for the request sent on leave", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("older");
    jest.advanceTimersByTime(1_000);
    queue.schedule("typed before leaving");
    queue.flush({ keepalive: true });
    queue.pause();
    let idle = false;
    void queue.whenIdle().then(() => {
      idle = true;
    });

    server.writes[0].done.resolve();
    await settle();
    expect(idle).toBe(false);
    server.writes[1].done.resolve();
    await settle();
    expect(idle).toBe(true);
    // Paused for Complete: the repeat waits, and Complete's own upsert carries the newest answers.
    expect(server.writes).toHaveLength(2);
  });

  test("a flush on leave while Complete is under way sends nothing", () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("older");
    jest.advanceTimersByTime(1_000);
    queue.schedule("typed before Complete");
    queue.pause();
    queue.flush({ keepalive: true });
    expect(server.writes).toHaveLength(1);
  });

  test("a flush with nothing pending sends nothing", () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);
    queue.flush({ keepalive: true });
    expect(server.save).not.toHaveBeenCalled();
  });

  test("retries a failed save with growing delays, then waits for the next edit", async () => {
    const server = fakeServer();
    const statuses: AutosaveStatus[] = [];
    const queue = makeQueue(server.save, () => true, { onStatusChange: (status) => statuses.push(status) });
    const failLatest = async () => {
      server.writes[server.writes.length - 1].done.reject(new Error("HTTP 503"));
      await settle();
    };

    queue.schedule("answer");
    jest.advanceTimersByTime(1_000);
    await failLatest();
    // Retries 1 to 4 wait 1, 2, 4 and 8 s.
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      jest.advanceTimersByTime(delay - 1);
      const sent = server.writes.length;
      jest.advanceTimersByTime(1);
      expect(server.writes).toHaveLength(sent + 1);
      await failLatest();
    }
    expect(server.writes).toHaveLength(5);
    expect(queue.getStatus()).toBe("failed");

    // Out of retries: nothing more goes out on its own.
    jest.advanceTimersByTime(60_000);
    expect(server.writes).toHaveLength(5);

    // The next edit tries again, and a success clears the warning.
    queue.schedule("answer, edited");
    expect(queue.getStatus()).toBe("retrying");
    jest.advanceTimersByTime(1_000);
    expect(server.writes[5].value).toBe("answer, edited");
    server.writes[5].done.resolve();
    await settle();
    expect(queue.getStatus()).toBe("saved");
    expect(statuses).toEqual(["saving", "retrying", "failed", "retrying", "saved"]);
  });

  test("a retry sends the newest answers, not the snapshot that failed", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("first");
    jest.advanceTimersByTime(1_000);
    queue.schedule("first and second");
    server.writes[0].done.reject(new Error("HTTP 503"));
    await settle();
    // The debounce for the newer edit is still running, so it, not the retry, sends next.
    jest.advanceTimersByTime(1_000);
    expect(server.writes.map((write) => write.value)).toEqual(["first", "first and second"]);
  });

  test("offline, it waits for retryNow instead of counting down retries", async () => {
    const server = fakeServer();
    let online = true;
    const statuses: AutosaveStatus[] = [];
    const queue = makeQueue(server.save, () => true, {
      isOnline: () => online,
      onStatusChange: (status) => statuses.push(status)
    });

    online = false;
    queue.noteOffline();
    expect(statuses).toEqual([]);
    queue.schedule("typed offline");
    expect(queue.getStatus()).toBe("offline");
    jest.advanceTimersByTime(1_000);
    server.writes[0].done.reject(new TypeError("Failed to fetch"));
    await settle();
    // More edits while offline keep the same status instead of flickering through "saving".
    queue.schedule("typed offline, more");
    jest.advanceTimersByTime(1_000);
    server.writes[1].done.reject(new TypeError("Failed to fetch"));
    await settle();
    jest.advanceTimersByTime(120_000);
    expect(server.writes).toHaveLength(2);
    expect(statuses).toEqual(["offline"]);

    online = true;
    queue.retryNow();
    expect(server.writes.map((write) => write.value)).toEqual([
      "typed offline",
      "typed offline, more",
      "typed offline, more"
    ]);
    server.writes[2].done.resolve();
    await settle();
    expect(statuses).toEqual(["offline", "retrying", "saved"]);
  });

  test("reports offline when the network drops with answers still unsaved", () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);
    queue.noteOffline();
    expect(queue.getStatus()).toBe("idle");
    queue.schedule("typed");
    queue.noteOffline();
    expect(queue.getStatus()).toBe("offline");
  });

  test("does not retry once disposed", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);
    queue.schedule("typed");
    queue.flush();
    queue.dispose();
    server.writes[0].done.reject(new Error("HTTP 503"));
    await settle();
    jest.advanceTimersByTime(60_000);
    expect(server.writes).toHaveLength(1);
  });
});
