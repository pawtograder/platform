/**
 * The redaction Web Worker. `redactBuffer` (./index.ts) starts it on the first report and keeps
 * it for re-runs (click-to-redact, keep-last-N changes). Each message is one pass over a copy
 * of the frozen buffer; the structured clone of `postMessage` is that copy.
 */
import type { FrozenBuffer } from "../types";
import { redactOwnedBuffer } from "./redact";
import type { RedactOptions } from "./types";

export type WorkerRequest = { id: number; buffer: FrozenBuffer; opts: RedactOptions };
export type WorkerResponse =
  | { id: number; ok: true; result: Awaited<ReturnType<typeof redactOwnedBuffer>> }
  | { id: number; ok: false; error: string };

// Typed by hand: the project compiles with the DOM lib, which conflicts with the webworker one.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

const failure = (id: number, err: unknown): WorkerResponse => ({
  id,
  ok: false,
  error: err instanceof Error ? err.message : String(err)
});

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, buffer, opts } = event.data;
  let response: WorkerResponse;
  try {
    response = { id, ok: true, result: await redactOwnedBuffer(buffer, opts) };
  } catch (err) {
    response = failure(id, err);
  }
  try {
    scope.postMessage(response);
  } catch (err) {
    // A result that can't be sent still answers the pass, so `redactBuffer` doesn't wait forever.
    scope.postMessage(failure(id, err));
  }
};
