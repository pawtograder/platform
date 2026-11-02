/**
 * Tests for lib/surveyAutosaveQueue.ts, the debounced autosave behind the student survey page.
 *
 * What it must guarantee: writes reach the server one at a time and in order, every write carries
 * the newest answers, and no single write can block the ones behind it (or Complete, which waits
 * for the queue) for longer than its time limit.
 */
import { runWithTimeout, SaveTimeoutError, SurveyAutosaveQueue } from "@/lib/surveyAutosaveQueue";

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

/** A fake transport: each write waits until the test settles it. */
function fakeServer() {
  const writes: { value: string; signal: AbortSignal; done: Deferred }[] = [];
  const save = jest.fn((value: string, { signal }: { signal: AbortSignal }) => {
    const done = deferred();
    writes.push({ value, signal, done });
    return done.promise;
  });
  return { writes, save };
}

// Lets promise callbacks run between timer steps.
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
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

describe("SurveyAutosaveQueue", () => {
  const makeQueue = (save: (value: string, attempt: { signal: AbortSignal }) => Promise<void>, canSave = () => true) =>
    new SurveyAutosaveQueue<string>({ save, canSave, debounceMs: 1_000, timeoutMs: 10_000 });

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

  test("holds a newer snapshot until the older write finishes", async () => {
    const server = fakeServer();
    const queue = makeQueue(server.save);

    queue.schedule("older");
    jest.advanceTimersByTime(1_000);
    queue.schedule("newer");
    jest.advanceTimersByTime(1_000);
    // One write at a time: "newer" waits behind "older".
    expect(server.writes.map((write) => write.value)).toEqual(["older"]);

    server.writes[0].done.resolve();
    await settle();
    expect(server.writes.map((write) => write.value)).toEqual(["older", "newer"]);
  });

  test("sends only the newest of several snapshots queued behind a slow write", async () => {
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

  test("gives up on a write that never settles and sends the newer snapshot", async () => {
    const server = fakeServer();
    const onError = jest.fn();
    const queue = new SurveyAutosaveQueue<string>({
      save: server.save,
      canSave: () => true,
      debounceMs: 1_000,
      timeoutMs: 10_000,
      onError
    });

    queue.schedule("stuck");
    jest.advanceTimersByTime(1_000);
    queue.schedule("next");
    jest.advanceTimersByTime(1_000);
    expect(server.writes).toHaveLength(1);

    jest.advanceTimersByTime(9_000);
    await settle();
    expect(server.writes[0].signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(SaveTimeoutError));
    expect(server.writes.map((write) => write.value)).toEqual(["stuck", "next"]);
  });

  test("whenIdle settles once a stuck write times out", async () => {
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
    expect(server.writes.map((write) => write.value)).toEqual(["typed"]);
    jest.advanceTimersByTime(1_000);
    expect(server.writes).toHaveLength(1);
  });
});
