/**
 * The LLM judge call: turn one (page, criterion) evidence bundle into a
 * structured {@link Verdict}, then post-validate the verdict OUTSIDE the model
 * to strip hallucinated citations.
 *
 * EXTRACTABLE CORE: imports only `@anthropic-ai/sdk`, `zod` (via the schemas),
 * and node builtins. No app/test imports, no `@/*` alias.
 *
 * Authoritative Anthropic API usage (do not "modernize" from memory):
 *   - `client.messages.parse({ model, max_tokens, thinking: {type:"adaptive"},
 *     output_config: { effort, format: zodOutputFormat(VerdictSchema) }, system,
 *     messages })`. `response.parsed_output` may be null → we fall back to
 *     manually parsing the response text, and throw if that also fails.
 *   - System is two text blocks, stable-prefix-first: the charter, then the
 *     per-criterion rubric carrying `cache_control: {type:"ephemeral"}`. Opus 4.8
 *     needs a 4096-token cacheable prefix; a shorter charter+rubric silently
 *     won't cache (observe `usage.cache_read_input_tokens` on the 2nd call).
 *   - Images are base64 user-content blocks placed BEFORE the text block that
 *     describes them, ≤15 per call. Larger bundles are chunked into multiple
 *     calls and merged worst-verdict-wins.
 *   - No temperature/top_p/top_k (removed on Opus 4.8, 400s). No assistant prefill.
 */
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Attachment, EvidenceBundle } from "../schema/evidence";
import { VerdictSchema, type Finding, type Verdict, type VerdictValue } from "../schema/verdict";

/** Bump only when the shared charter changes; rubric edits invalidate per-criterion. */
export const PROMPT_VERSION = "r1.0";
export const JUDGE_MODEL = "claude-opus-4-8";
export const MAX_TOKENS = 16000;
/** Anthropic caps vision at 15 images per request; 2.4.7 bundles can exceed it. */
export const MAX_IMAGES_PER_CALL = 15;

/** The stable system prefix shared by every criterion (charter). */
export const JUDGE_CHARTER = [
  "You are a rigorous WCAG 2.1 Level AA accessibility auditor acting as an automated judge.",
  "You are given, per (page, criterion), a frozen evidence bundle: structured probe JSON plus labeled screenshots. A criterion-specific rubric follows this charter — apply it literally.",
  "",
  "Output contract:",
  '- `verdict` is exactly one of "pass", "fail", "needs_human". "needs_human" is honest abstention when the static evidence genuinely cannot decide (see the rubric\'s needs_human triggers) — it is NOT a soft fail and NOT a hedge you reach for to avoid committing.',
  '- `confidence` is "low" | "medium" | "high".',
  '- `findings` is the list of concrete problems. Each finding: a one-sentence `summary`; a `severity` enum from "1" (cosmetic) to "5" (blocks the task for the affected users), per the rubric\'s severity guidance; `evidenceRefs`; an `elementPointer`; and a `suggestedFix`.',
  "- `evidenceGaps` lists what the evidence could not show. `requestedProbes` lists specific additional probes that would let you decide.",
  "",
  "Evidence-citation rules (these are checked mechanically after you answer; violations are discarded):",
  "- Every entry in a finding's `evidenceRefs` MUST be either a probe `id` or an attachment file name exactly as given in the bundle. Do not invent ids.",
  "- `elementPointer.testId` and `elementPointer.selector`, when present, MUST be copied verbatim from the probe JSON. Do not paraphrase, guess, or construct selectors.",
  "- A pass verdict has no findings. A fail verdict must have at least one finding that cites the evidence proving the failure.",
  "",
  "Judge only from the supplied evidence. Do not assume behavior the probes and screenshots do not show. Read the screenshots together with the computed-style numbers — the numbers say what is declared, the pixels say what is perceivable."
].join("\n");

/** Where a rejected finding came from and why post-validation dropped it. */
export interface RejectedFinding {
  finding: Finding;
  reason: string;
}

/** Token accounting, summed across chunk calls for one bundle sample. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface JudgeResult {
  verdict: Verdict;
  rejectedFindings: RejectedFinding[];
  usage: UsageTotals;
  /** The raw per-chunk verdicts before post-validation/merge (debugging + hallucination audit). */
  raw: Verdict[];
}

/** One API call's worth of request parameters (no output format attached yet). */
export interface ChunkRequest {
  chunkIndex: number;
  imageCount: number;
  params: Anthropic.Messages.MessageCreateParamsNonStreaming;
}

export interface JudgeBundleArgs {
  client: Anthropic;
  bundle: EvidenceBundle;
  /** Directory containing this bundle's manifest.json and attachment files. */
  evidenceDir: string;
  rubricText: string;
  promptVersion?: string;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens
  };
}

export function usageFromResponse(usage: Anthropic.Messages.Usage | undefined | null): UsageTotals {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0
  };
}

/** Severity of a verdict for worst-wins merges: fail > needs_human > pass. */
export function verdictRank(v: VerdictValue): number {
  return v === "fail" ? 2 : v === "needs_human" ? 1 : 0;
}

/** The worse (more severe) of two verdict values. */
export function worseVerdict(a: VerdictValue, b: VerdictValue): VerdictValue {
  return verdictRank(a) >= verdictRank(b) ? a : b;
}

function systemBlocks(rubricText: string): Anthropic.Messages.TextBlockParam[] {
  return [
    { type: "text", text: JUDGE_CHARTER },
    { type: "text", text: rubricText, cache_control: { type: "ephemeral" } }
  ];
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function imageBase64MediaType(mime: string): Anthropic.Messages.Base64ImageSource["media_type"] {
  return mime as Anthropic.Messages.Base64ImageSource["media_type"];
}

function buildUserContent(
  bundle: EvidenceBundle,
  images: Attachment[],
  evidenceDir: string,
  chunkIndex: number,
  chunkCount: number
): Anthropic.Messages.ContentBlockParam[] {
  const content: Anthropic.Messages.ContentBlockParam[] = [];

  for (const att of images) {
    const data = fs.readFileSync(path.join(evidenceDir, att.file)).toString("base64");
    content.push({
      type: "image",
      source: { type: "base64", media_type: imageBase64MediaType(att.mime), data }
    });
  }

  const legend = images.length
    ? images.map((att, i) => `[image ${i}] file=${att.file} role=${att.role} probe=${att.probeId ?? "-"}`).join("\n")
    : "(no screenshots in this chunk)";

  const chunkNote =
    chunkCount > 1
      ? `\nThis is screenshot chunk ${chunkIndex + 1} of ${chunkCount} for this bundle; the probe JSON below is complete, but only the screenshots listed above are shown in this call.\n`
      : "";

  const text = [
    `# Page`,
    `id: ${bundle.page.id}`,
    `route: ${bundle.page.route}`,
    `title: ${bundle.page.title}`,
    `viewport: ${bundle.page.viewport.width}x${bundle.page.viewport.height}`,
    `browser: ${bundle.page.browser}`,
    `criterion under test: ${bundle.criterion}`,
    chunkNote,
    `# Screenshots (shown above, in order)`,
    legend,
    ``,
    `# Probes (JSON)`,
    "```json",
    JSON.stringify(bundle.probes, null, 2),
    "```",
    ``,
    `# Task`,
    `Apply the rubric to the evidence above and return a verdict for criterion ${bundle.criterion}.`,
    `Cite every finding with evidenceRefs drawn from the probe ids or the attachment file names listed under Screenshots, and copy any testId/selector verbatim from the probe JSON.`
  ].join("\n");

  content.push({ type: "text", text });
  return content;
}

/**
 * Split a bundle into one request per ≤15-image chunk. A bundle with no images
 * (or ≤15) yields a single request. The probe JSON is repeated in every chunk so
 * each call has full structured context.
 */
export function buildRequestChunks(bundle: EvidenceBundle, evidenceDir: string, rubricText: string): ChunkRequest[] {
  const images = bundle.attachments.filter((a) => a.mime.startsWith("image/"));
  const groups = chunkArray(images, MAX_IMAGES_PER_CALL);
  const system = systemBlocks(rubricText);

  return groups.map((group, chunkIndex) => ({
    chunkIndex,
    imageCount: group.length,
    params: {
      model: JUDGE_MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system,
      messages: [{ role: "user", content: buildUserContent(bundle, group, evidenceDir, chunkIndex, groups.length) }]
    }
  }));
}

/** Attach the structured-output format to base params (shared by parse + batch paths). */
export function attachOutputFormat(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const base = (params.output_config ?? {}) as Anthropic.Messages.OutputConfig;
  return { ...params, output_config: { ...base, format: zodOutputFormat(VerdictSchema) } };
}

/** Concatenate the text blocks of a message response. */
export function extractMessageText(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Parse+validate a JSON verdict out of raw model text (strips code fences). Throws on failure. */
export function parseVerdictText(text: string): Verdict {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new Error(`verdict text was not valid JSON: ${(e as Error).message}\n${stripped.slice(0, 400)}`);
  }
  return VerdictSchema.parse(parsed);
}

/** Read a validated verdict from a parsed message, preferring `parsed_output`, else the text body. */
function readVerdict(message: Anthropic.Messages.Message & { parsed_output?: unknown }): Verdict {
  if (message.parsed_output != null) {
    const r = VerdictSchema.safeParse(message.parsed_output);
    if (r.success) return r.data;
  }
  return parseVerdictText(extractMessageText(message));
}

/**
 * Post-validate a verdict against its bundle, OUTSIDE the model. A finding is
 * rejected (moved to the sidecar) when any of its evidenceRefs is not a probe id
 * or attachment file, or when its elementPointer testId/selector does not occur
 * verbatim in the serialized probe JSON. Returns the cleaned verdict + rejects.
 */
export function postValidateVerdict(
  verdict: Verdict,
  bundle: EvidenceBundle
): {
  verdict: Verdict;
  rejectedFindings: RejectedFinding[];
} {
  const allowedRefs = new Set<string>([...bundle.probes.map((p) => p.id), ...bundle.attachments.map((a) => a.file)]);
  const probeJson = JSON.stringify(bundle.probes);

  const kept: Finding[] = [];
  const rejectedFindings: RejectedFinding[] = [];

  for (const finding of verdict.findings) {
    const reasons: string[] = [];
    const badRefs = finding.evidenceRefs.filter((ref) => !allowedRefs.has(ref));
    if (badRefs.length > 0) {
      reasons.push(`evidenceRefs not in manifest: ${JSON.stringify(badRefs)}`);
    }
    const { testId, selector } = finding.elementPointer;
    if (testId && !probeJson.includes(testId)) {
      reasons.push(`elementPointer.testId "${testId}" not found in probe JSON`);
    }
    if (selector && !probeJson.includes(selector)) {
      reasons.push(`elementPointer.selector "${selector}" not found in probe JSON`);
    }
    if (reasons.length > 0) {
      rejectedFindings.push({ finding, reason: reasons.join("; ") });
    } else {
      kept.push(finding);
    }
  }

  return { verdict: { ...verdict, findings: kept }, rejectedFindings };
}

/** Union of string arrays preserving first-seen order. */
function unionStrings(lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const s of list) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * Merge per-chunk verdicts for one bundle sample: verdict value is worst-wins
 * (fail > needs_human > pass); findings/gaps/probes are unioned; confidence and
 * rationale come from the first chunk that produced the winning verdict.
 */
export function mergeChunkVerdicts(verdicts: Verdict[], criterion: string): Verdict {
  if (verdicts.length === 1) return { ...verdicts[0], criterion };
  const mergedValue = verdicts.reduce<VerdictValue>((acc, v) => worseVerdict(acc, v.verdict), "pass");
  const representative = verdicts.find((v) => v.verdict === mergedValue) ?? verdicts[0];
  return {
    criterion,
    verdict: mergedValue,
    confidence: representative.confidence,
    rationale: verdicts.map((v, i) => `[chunk ${i + 1}] ${v.rationale}`).join("\n\n"),
    findings: verdicts.flatMap((v) => v.findings),
    evidenceGaps: unionStrings(verdicts.map((v) => v.evidenceGaps)),
    requestedProbes: unionStrings(verdicts.map((v) => v.requestedProbes))
  };
}

/**
 * Judge a single evidence bundle: build chunked requests, call `messages.parse`
 * per chunk, post-validate each verdict, and merge worst-verdict-wins.
 */
export async function judgeBundle(args: JudgeBundleArgs): Promise<JudgeResult> {
  const { client, bundle, evidenceDir, rubricText } = args;
  const chunks = buildRequestChunks(bundle, evidenceDir, rubricText);

  let usage = emptyUsage();
  const rawVerdicts: Verdict[] = [];
  const cleanedVerdicts: Verdict[] = [];
  const rejectedFindings: RejectedFinding[] = [];

  for (const chunk of chunks) {
    const message = (await client.messages.parse(attachOutputFormat(chunk.params))) as Anthropic.Messages.Message & {
      parsed_output?: unknown;
    };
    usage = addUsage(usage, usageFromResponse(message.usage));
    const rawVerdict = readVerdict(message);
    rawVerdicts.push(rawVerdict);
    const { verdict: cleaned, rejectedFindings: rejects } = postValidateVerdict(rawVerdict, bundle);
    cleanedVerdicts.push(cleaned);
    rejectedFindings.push(...rejects);
  }

  const verdict = mergeChunkVerdicts(cleanedVerdicts, bundle.criterion);
  return { verdict, rejectedFindings, usage, raw: rawVerdicts };
}
