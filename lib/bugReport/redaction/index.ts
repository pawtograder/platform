/**
 * Redaction of a frozen bug-report buffer before review and upload (spec package 3, §5).
 *
 * Import this module lazily, when a report is opened: it is the entry point of its own chunk,
 * and the worker it starts is another. `redactBuffer` runs the pass in a Web Worker kept for
 * the page's lifetime (click-to-redact re-runs it); `disposeRedactionWorker` ends it. Where
 * there is no `Worker` (Jest, jsdom) it runs on the main thread instead.
 */
import type { FrozenBuffer } from "../types";
import type { RedactionResult, RedactOptions } from "./types";
import type { WorkerRequest, WorkerResponse } from "./worker";

export type {
  Detector,
  RedactionResult,
  RedactionStats,
  RedactOptions,
  RemainingKind,
  RemainingString,
  Span,
  TaintSnapshot
} from "./types";
export { taintSnapshot } from "./taintSnapshot";

type Pending = { resolve: (r: RedactionResult) => void; reject: (e: Error) => void };

/**
 * A pass that hasn't answered by now is treated as stuck: the worker is ended and the pass
 * fails, so the report goes out without a replay instead of holding up Submit. A full 20 MB
 * buffer redacts in seconds.
 */
export const REDACTION_TIMEOUT_MS = 120_000;

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

function failAll(error: Error): void {
  for (const p of pending.values()) p.reject(error);
  pending.clear();
}

async function getWorker(): Promise<Worker> {
  if (worker) return worker;
  const { spawnRedactionWorker } = await import("./spawnWorker");
  if (worker) return worker;
  const w = spawnRedactionWorker();
  w.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const p = pending.get(response.id);
    if (!p) return;
    pending.delete(response.id);
    if (response.ok) p.resolve(response.result);
    else p.reject(new Error(`Redaction failed: ${response.error}`));
  };
  w.onerror = (event: ErrorEvent) => {
    // A worker that failed to load or crashed can't answer; start a fresh one next time.
    event.preventDefault();
    if (worker === w) worker = undefined;
    w.terminate();
    failAll(new Error(`Redaction worker error: ${event.message || "failed to load"}`));
  };
  // A reply that can't be read carries no id to settle, and a pass left pending holds up Submit.
  w.onmessageerror = () => {
    if (worker === w) worker = undefined;
    w.terminate();
    failAll(new Error("Redaction worker sent an unreadable reply"));
  };
  worker = w;
  return w;
}

function copy<T>(value: T): T {
  return typeof structuredClone === "function" ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Redacts a frozen buffer: trims it to `keepLastMs`, masks every detector hit, and lists the
 * strings left for review. `buffer` is not modified; the result holds a redacted copy.
 */
export async function redactBuffer(buffer: FrozenBuffer, opts: RedactOptions): Promise<RedactionResult> {
  if (typeof Worker === "undefined") {
    const { redactOwnedBuffer } = await import("./redact");
    return redactOwnedBuffer(copy(buffer), opts);
  }
  const w = await getWorker();
  return new Promise<RedactionResult>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      // The worker runs one pass at a time, so a stuck pass blocks every later one too.
      if (worker === w) worker = undefined;
      w.terminate();
      failAll(new Error("Redaction timed out"));
    }, REDACTION_TIMEOUT_MS);
    const settle =
      <T>(fn: (v: T) => void) =>
      (v: T) => {
        clearTimeout(timer);
        fn(v);
      };
    pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    const request: WorkerRequest = { id, buffer, opts };
    try {
      w.postMessage(request);
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Ends the worker, failing any pass still running. The next `redactBuffer` starts a new one. */
export function disposeRedactionWorker(): void {
  const w = worker;
  worker = undefined;
  w?.terminate();
  failAll(new Error("Redaction worker disposed"));
}
