/**
 * Batch-mode judging via the Message Batches API (50% off full sweeps). Shares
 * the request builder + post-validation + merge logic with client.ts; `parse()`
 * is not available for batches, so we zod-parse the returned JSON text ourselves.
 *
 * EXTRACTABLE CORE: imports only `@anthropic-ai/sdk`, the local schema, and the
 * shared client helpers.
 *
 * custom_id constraints (≤64 chars, [a-zA-Z0-9_-]) rule out using the 64-hex
 * cache key + a chunk suffix, so requests get opaque ids (`r<n>`) mapped back to
 * (cacheKey, chunkIndex) locally. Results arrive in any order → keyed by custom_id.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EvidenceBundle } from "../schema/evidence";
import type { Verdict } from "../schema/verdict";
import {
  addUsage,
  attachOutputFormat,
  buildRequestChunks,
  emptyUsage,
  extractMessageText,
  mergeChunkVerdicts,
  parseVerdictText,
  postValidateVerdict,
  usageFromResponse,
  type JudgeResult,
  type RejectedFinding
} from "./client";

export interface BatchJob {
  cacheKey: string;
  bundle: EvidenceBundle;
  /** Directory containing the bundle's manifest.json and attachment files. */
  evidenceDir: string;
  rubricText: string;
}

export type BatchOutcome = { status: "ok"; result: JudgeResult } | { status: "error"; message: string };

export interface JudgeBundlesBatchArgs {
  client: Anthropic;
  jobs: BatchJob[];
  /** Poll interval while waiting for the batch to end (ms). */
  pollIntervalMs?: number;
  /** Safety cap on total polling wait (ms); default 24h. */
  maxWaitMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run every (job × chunk) request through one batch, then reassemble per job:
 * post-validate each chunk verdict, merge worst-verdict-wins, sum usage. Returns
 * a map keyed by `cacheKey`. Failed jobs get `{ status: "error", message }`.
 */
export async function judgeBundlesBatch(args: JudgeBundlesBatchArgs): Promise<Map<string, BatchOutcome>> {
  const { client, jobs } = args;
  const pollIntervalMs = args.pollIntervalMs ?? 10_000;
  const maxWaitMs = args.maxWaitMs ?? 24 * 60 * 60 * 1000;
  const out = new Map<string, BatchOutcome>();
  if (jobs.length === 0) return out;

  const requests: Anthropic.Messages.Batches.BatchCreateParams["requests"] = [];
  const idToLocation = new Map<string, { cacheKey: string; chunkIndex: number }>();
  const chunkCountByKey = new Map<string, number>();
  let n = 0;

  for (const job of jobs) {
    const chunks = buildRequestChunks(job.bundle, job.evidenceDir, job.rubricText);
    chunkCountByKey.set(job.cacheKey, chunks.length);
    for (const chunk of chunks) {
      const customId = `r${n++}`;
      idToLocation.set(customId, { cacheKey: job.cacheKey, chunkIndex: chunk.chunkIndex });
      requests.push({ custom_id: customId, params: attachOutputFormat(chunk.params) });
    }
  }

  const batch = await client.messages.batches.create({ requests });

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const status = await client.messages.batches.retrieve(batch.id);
    if (status.processing_status === "ended") break;
    if (Date.now() > deadline) {
      for (const job of jobs)
        out.set(job.cacheKey, { status: "error", message: `batch ${batch.id} did not end within maxWaitMs` });
      return out;
    }
    await sleep(pollIntervalMs);
  }

  // Index responses: cacheKey -> chunkIndex -> message | error.
  const byKey = new Map<string, Map<number, { message?: Anthropic.Messages.Message; error?: string }>>();
  for await (const response of await client.messages.batches.results(batch.id)) {
    const loc = idToLocation.get(response.custom_id);
    if (!loc) continue;
    const inner = byKey.get(loc.cacheKey) ?? byKey.set(loc.cacheKey, new Map()).get(loc.cacheKey)!;
    if (response.result.type === "succeeded") {
      inner.set(loc.chunkIndex, { message: response.result.message });
    } else {
      inner.set(loc.chunkIndex, { error: `batch request ${response.custom_id}: ${response.result.type}` });
    }
  }

  for (const job of jobs) {
    try {
      const inner = byKey.get(job.cacheKey);
      const chunkCount = chunkCountByKey.get(job.cacheKey) ?? 0;
      if (!inner || chunkCount === 0) throw new Error("no batch results for job");

      let usage = emptyUsage();
      const rawVerdicts: Verdict[] = [];
      const cleanedVerdicts: Verdict[] = [];
      const rejectedFindings: RejectedFinding[] = [];

      for (let ci = 0; ci < chunkCount; ci++) {
        const entry = inner.get(ci);
        if (!entry || !entry.message) throw new Error(entry?.error ?? `missing chunk ${ci}`);
        usage = addUsage(usage, usageFromResponse(entry.message.usage));
        const verdict = parseVerdictText(extractMessageText(entry.message));
        rawVerdicts.push(verdict);
        const { verdict: cleaned, rejectedFindings: rejects } = postValidateVerdict(verdict, job.bundle);
        cleanedVerdicts.push(cleaned);
        rejectedFindings.push(...rejects);
      }

      const verdict = mergeChunkVerdicts(cleanedVerdicts, job.bundle.criterion);
      out.set(job.cacheKey, { status: "ok", result: { verdict, rejectedFindings, usage, raw: rawVerdicts } });
    } catch (e) {
      out.set(job.cacheKey, { status: "error", message: (e as Error).message });
    }
  }

  return out;
}
