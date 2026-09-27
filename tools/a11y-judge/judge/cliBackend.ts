/**
 * `claude -p` judging backend — runs the judge over a standing Claude Code
 * OAuth session instead of an ANTHROPIC_API_KEY.
 *
 * Differences from the SDK backend (client.ts):
 * - Transport is the Claude Code CLI in print mode with `--json-schema`
 *   structured output; the parsed object arrives in the envelope's
 *   `structured_output` field (fallback: parse the `result` text).
 * - Screenshots are NOT base64-inlined. The prompt lists the attachment file
 *   names and the CLI's own Read tool loads them (cwd is set to the bundle
 *   dir, so plain file names resolve and stay inside the sandbox root).
 *   No 15-image chunking is needed — one invocation per bundle.
 * - Because the prompt framing differs from the SDK path, cache keys for this
 *   backend use `PROMPT_VERSION + CLI_PROMPT_SUFFIX` so the two backends never
 *   share cached verdicts.
 *
 * EXTRACTABLE CORE: imports only zod, node builtins, and sibling modules. The
 * `claude` binary must be on PATH with an authenticated session.
 */
import { execFileSync } from "child_process";
import { z } from "zod/v4";
import type { EvidenceBundle } from "../schema/evidence";
import { VerdictSchema, type Verdict } from "../schema/verdict";
import {
  JUDGE_CHARTER,
  JUDGE_MODEL,
  parseVerdictText,
  postValidateVerdict,
  type JudgeResult,
  type UsageTotals
} from "./client";

/** Appended to PROMPT_VERSION in cache keys so CLI and SDK verdicts never mix. */
export const CLI_PROMPT_SUFFIX = "+cli";
// 2.4.7 bundles can carry ~50 crop files; parallel Reads usually batch into few
// turns, but leave generous headroom so a serial reader never hits the cap.
const MAX_TURNS = 100;
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

// The CLI's schema validator doesn't load the 2020-12 meta-schema that zod v4
// declares via `$schema` — strip the key (the schema body is draft-07 compatible).
const VERDICT_JSON_SCHEMA = JSON.stringify(
  Object.fromEntries(Object.entries(z.toJSONSchema(VerdictSchema)).filter(([key]) => key !== "$schema"))
);

/** Minimal shape of the `claude -p --output-format json` envelope we consume. */
const CliEnvelopeSchema = z.looseObject({
  type: z.literal("result"),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional()
    })
    .optional(),
  total_cost_usd: z.number().optional()
});

export interface CliJudgeArgs {
  bundle: EvidenceBundle;
  /** Directory containing this bundle's manifest.json and attachment files. */
  evidenceDir: string;
  rubricText: string;
  /** Override the binary (tests). */
  claudeBin?: string;
}

/** Build the single user prompt for one bundle (charter + rubric are inlined). */
export function buildCliPrompt(bundle: EvidenceBundle, rubricText: string): string {
  const images = bundle.attachments.filter((a) => a.mime.startsWith("image/"));
  const legend = images.length
    ? images.map((att) => `- ${att.file}  (role=${att.role} probe=${att.probeId ?? "-"})`).join("\n")
    : "(this bundle has no screenshots)";

  return [
    JUDGE_CHARTER,
    "",
    "# Criterion rubric",
    rubricText,
    "",
    "# Page",
    `id: ${bundle.page.id}`,
    `route: ${bundle.page.route}`,
    `title: ${bundle.page.title}`,
    `viewport: ${bundle.page.viewport.width}x${bundle.page.viewport.height}`,
    `browser: ${bundle.page.browser}`,
    `criterion under test: ${bundle.criterion}`,
    "",
    "# Screenshots (files in the current directory — Read EACH ONE before deciding)",
    legend,
    "",
    "# Probes (JSON)",
    "```json",
    JSON.stringify(bundle.probes, null, 2),
    "```",
    "",
    "# Task",
    `Read every screenshot file listed above with the Read tool, then apply the rubric to the full evidence and return the verdict for criterion ${bundle.criterion} as structured output.`,
    "Use ONLY the Read tool, and only on the listed files. Cite every finding with evidenceRefs drawn from the probe ids or the attachment file names, and copy any testId/selector verbatim from the probe JSON."
  ].join("\n");
}

/** Parse the CLI JSON envelope into a validated Verdict + usage. Throws on failure. */
export function parseCliEnvelope(stdout: string): { verdict: Verdict; usage: UsageTotals } {
  const envelope = CliEnvelopeSchema.parse(JSON.parse(stdout));
  if (envelope.is_error) {
    throw new Error(`claude -p reported an error: ${(envelope.result ?? "").slice(0, 400)}`);
  }
  let verdict: Verdict;
  const structured = VerdictSchema.safeParse(envelope.structured_output);
  if (structured.success) {
    verdict = structured.data;
  } else {
    verdict = parseVerdictText(envelope.result ?? "");
  }
  return {
    verdict,
    usage: {
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: envelope.usage?.cache_read_input_tokens ?? 0
    }
  };
}

function invokeClaude(prompt: string, evidenceDir: string, claudeBin: string): string {
  return execFileSync(
    claudeBin,
    [
      "-p",
      "--model",
      JUDGE_MODEL,
      "--output-format",
      "json",
      "--json-schema",
      VERDICT_JSON_SCHEMA,
      "--allowedTools",
      "Read",
      "--max-turns",
      String(MAX_TURNS),
      "--strict-mcp-config"
    ],
    { input: prompt, cwd: evidenceDir, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf-8" }
  );
}

/**
 * Judge one bundle via `claude -p`. One invocation per bundle (the CLI reads
 * the screenshots itself); one retry on a malformed envelope/verdict.
 */
export async function judgeBundleViaCli(args: CliJudgeArgs): Promise<JudgeResult> {
  const claudeBin = args.claudeBin ?? "claude";
  const prompt = buildCliPrompt(args.bundle, args.rubricText);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let stdout: string;
    try {
      stdout = invokeClaude(prompt, args.evidenceDir, claudeBin);
    } catch (e) {
      // Spawn/timeout/non-zero exit: not a parse issue, retrying rarely helps.
      throw new Error(`claude -p invocation failed: ${(e as Error).message}`);
    }
    try {
      const { verdict, usage } = parseCliEnvelope(stdout);
      const validated = postValidateVerdict(verdict, args.bundle);
      return { verdict: validated.verdict, rejectedFindings: validated.rejectedFindings, usage, raw: [verdict] };
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw new Error(`claude -p returned an unusable verdict after 2 attempts: ${lastError?.message}`);
}
