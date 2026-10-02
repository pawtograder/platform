/**
 * The whole redaction pass on a buffer the caller owns: trim to `keepLastMs`, build the detector
 * chain, walk. Runs inside the worker (`./worker.ts`); `redactBuffer` runs it on the main
 * thread only where there is no `Worker` (Jest).
 */
import type { FrozenBuffer } from "../types";
import { buildDetectorChain } from "./detectors";
import type { Detector, RedactionResult, RedactOptions } from "./types";
import { keepLast, walkBuffer } from "./walker";

/** Package 4's slot: the worker sets this once the model has loaded. */
let modelDetector: Detector | undefined;

export function setModelDetector(detector: Detector | undefined): void {
  modelDetector = detector;
}

/** Redacts `owned` in place (after trimming) and returns it. Never pass the recorder's own buffer. */
export async function redactOwnedBuffer(owned: FrozenBuffer, opts: RedactOptions): Promise<RedactionResult> {
  const started = now();
  const buffer = keepLast(owned, opts.keepLastMs);
  // The visit list holds the same URLs as `urls`, unredacted; trimming was its only use.
  delete buffer.visits;
  const chain = buildDetectorChain(opts, modelDetector);
  const walked = await walkBuffer(buffer, chain);
  return {
    buffer,
    remaining: walked.remaining,
    stats: { textNodes: walked.textNodes, redactedSpans: walked.redactedSpans, ms: Math.round(now() - started) }
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
