/**
 * `redactBuffer` in a browser: the pass runs in a worker, and a pass that never answers fails
 * after `REDACTION_TIMEOUT_MS` instead of holding up Submit.
 */
import type { FrozenBuffer } from "@/lib/bugReport/types";

class SilentWorker {
  static spawned: SilentWorker[] = [];
  onmessage: unknown = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  terminated = false;
  constructor() {
    SilentWorker.spawned.push(this);
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true;
  }
}

jest.mock("@/lib/bugReport/redaction/spawnWorker", () => ({
  spawnRedactionWorker: () => new SilentWorker()
}));

const buffer = { segments: [], urls: [] } as unknown as FrozenBuffer;

beforeEach(() => {
  (globalThis as { Worker?: unknown }).Worker = SilentWorker;
  SilentWorker.spawned = [];
  jest.useFakeTimers();
});

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker;
  jest.useRealTimers();
});

it("fails a pass the worker never answers, and starts a fresh worker for the next one", async () => {
  const { redactBuffer, REDACTION_TIMEOUT_MS } = await import("@/lib/bugReport/redaction");
  const pass = redactBuffer(buffer, { taintPatterns: [] });
  const outcome = pass.then(
    () => "resolved",
    (e: Error) => e.message
  );
  await jest.advanceTimersByTimeAsync(REDACTION_TIMEOUT_MS);
  await expect(outcome).resolves.toBe("Redaction timed out");
  expect(SilentWorker.spawned).toHaveLength(1);
  expect(SilentWorker.spawned[0].terminated).toBe(true);

  void redactBuffer(buffer, { taintPatterns: [] }).catch(() => {});
  await jest.advanceTimersByTimeAsync(0);
  expect(SilentWorker.spawned).toHaveLength(2);
});
