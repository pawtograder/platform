/**
 * Agent runner (a11y-judge v2, Wave 2) — spawns `claude -p` over the standing
 * OAuth session, wired to an AtBridge, and collects the run into a Trajectory
 * plus a post-validated AgentVerdict.
 *
 * Invocation mirrors judge/cliBackend.ts conventions (stream-json instead of
 * json so assistant narration is captured as trajectory notes; MCP tools only;
 * structured output via --json-schema with $schema stripped).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { JUDGE_MODEL } from "../judge/client";
import {
  AGENT_VERDICT_JSON_SCHEMA,
  AgentVerdictOutputSchema,
  computeTrajectoryHash,
  parseBarriersJson,
  postValidateAgentVerdict,
  TRAJECTORY_SCHEMA_VERSION,
  type AgentVerdict,
  type AgentVerdictOutput,
  type AssistantNote,
  type Barrier,
  type Trajectory
} from "../schema/trajectory";
import { MCP_SERVER_NAME } from "./toolSurface";
import type { AtBridge } from "./bridge";
import type { TaskDefinition } from "./tasks";

/** Bump on any charter/prompt change — verdict dirs record it, like R1. */
export const AGENT_PROMPT_VERSION = "a1.1";
export const AGENT_MODEL = JUDGE_MODEL;
const MAX_TURNS = 200;
const TIMEOUT_MS = 20 * 60 * 1000;

export const AGENT_CHARTER = [
  "You are a blind screen-reader user testing a course-management web app. You perceive the page ONLY through",
  "what the screen reader announces (the tool results) and interact ONLY through the provided screen-reader and",
  "keyboard tools. You cannot see the screen, use a mouse, or inspect the page in any other way.",
  "",
  "Work like an experienced screen-reader user: orient yourself first (headings/landmarks), navigate",
  "structurally instead of pressing `next` hundreds of times, use `readNext` to listen through content, enter",
  "focus mode (`interact`) before typing, and re-orient after anything that sounds like a page change.",
  "",
  "Tool results include `checkableState`: the TRUE checked state of the radio/checkbox under the cursor, read",
  "live. The simulator has a known limitation: it does not announce checkable state changes and re-reads can",
  "report stale state — trust `checkableState` for radios/checkboxes, and do NOT report missing checked/",
  "unchecked announcements as app barriers (that is the simulator, not the app).",
  "",
  'A phrase marked "(announced N×)" means the simulator re-spoke a persisting status message N times for what',
  "is a SINGLE announcement to a real screen reader — treat it as announced once, and do NOT report the",
  "repetition as an app barrier (simulator artifact, verified against DOM ground truth).",
  "",
  "Attempt the task honestly. If you hit friction a sighted user would not have — unlabeled controls, focus",
  "jumping somewhere unexpected, actions with no announced result, content you cannot reach — note it precisely",
  "(which step, what you heard, what you expected). If you cannot complete the task through the screen reader",
  "and keyboard alone, that is a `blocked` outcome and itself the key finding: describe the barrier, do not",
  "invent a workaround the interaction channel does not offer.",
  "",
  "When done (or blocked), emit the structured verdict: outcome, taskAnswer (the exact answer for read-tasks,",
  '"n/a" for write-tasks), a narrative of the journey (at most 8 sentences), and barriers with WCAG mapping in',
  "the barriersJson field (a JSON array encoded as a string). Cite each barrier's evidenceRefs as the tool-step",
  "numbers where you experienced it (steps are numbered from 0 in the order you called tools); cited steps must",
  "exist."
].join("\n");

export function buildAgentPrompt(task: TaskDefinition): string {
  return [
    AGENT_CHARTER,
    "",
    "# Your task",
    task.prompt,
    "",
    "# Starting point",
    "The page is already open and settled. Begin by orienting yourself.",
    `Finish within ${MAX_TURNS} turns; prefer structural navigation and batched reads.`
  ].join("\n");
}

/** stream-json events we consume (loose: the CLI adds fields freely). */
const StreamEventSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  message: z
    .looseObject({
      content: z
        .array(
          z.looseObject({
            type: z.string(),
            text: z.string().optional(),
            name: z.string().optional(),
            input: z.unknown().optional()
          })
        )
        .optional()
    })
    .optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional()
});

export interface ParsedStream {
  assistantTexts: string[];
  resultEnvelope: z.infer<typeof StreamEventSchema> | null;
  /** Raw inputs of every StructuredOutput tool call the model attempted. */
  structuredAttempts: unknown[];
}

/** Pure: fold stream-json stdout lines into assistant notes + final envelope. */
export function parseStreamJson(stdout: string): ParsedStream {
  const assistantTexts: string[] = [];
  const structuredAttempts: unknown[] = [];
  let resultEnvelope: ParsedStream["resultEnvelope"] = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial/garbage line
    }
    const event = StreamEventSchema.safeParse(parsed);
    if (!event.success) continue;
    if (event.data.type === "assistant") {
      for (const block of event.data.message?.content ?? []) {
        if (block.type === "text" && block.text) assistantTexts.push(block.text);
        if (block.type === "tool_use" && block.name === "StructuredOutput") structuredAttempts.push(block.input);
      }
    } else if (event.data.type === "result") {
      resultEnvelope = event.data;
    }
  }
  return { assistantTexts, resultEnvelope, structuredAttempts };
}

/**
 * Pure: recover a verdict when the CLI exhausted its structured-output
 * retries. The observed corruption drops exactly one property from the
 * StructuredOutput params (the post-long-string slot), so the last attempt
 * plus defaults for the droppable fields usually reconstructs the verdict.
 * Never invents content: only barriersJson/evidenceGaps get defaults, and the
 * caller marks the result `salvaged` so reports show barriers may be lost.
 */
export function salvageStructuredOutput(structuredAttempts: unknown[]): AgentVerdictOutput | null {
  for (let i = structuredAttempts.length - 1; i >= 0; i--) {
    const attempt = structuredAttempts[i];
    if (typeof attempt !== "object" || attempt === null) continue;
    const patched = { barriersJson: "[]", evidenceGaps: [], ...(attempt as Record<string, unknown>) };
    const parsed = AgentVerdictOutputSchema.safeParse(patched);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export interface AgentRunArgs {
  task: TaskDefinition;
  bridge: AtBridge;
  sampleIndex: number;
  browser: string;
  route: string;
  claudeBin?: string;
}

export interface AgentRunResult {
  trajectory: Trajectory;
  verdict: AgentVerdict | null;
  rejectedBarriers: Barrier[];
  isError: boolean;
  errorText?: string;
  /**
   * Verdict was reconstructed from the model's last StructuredOutput attempt
   * after the CLI exhausted its retries — barriers may have been lost.
   */
  salvaged?: boolean;
  /** Set when barriersJson arrived but failed JSON/zod validation. */
  barriersParseError?: string;
  /** Result envelope subtype (e.g. success, error_max_turns) for triage. */
  resultSubtype?: string;
  numTurns?: number;
  costUsd?: number;
  /** Full stream-json stdout — persisted by the host for triage/paper. */
  rawStdout: string;
}

export function buildClaudeArgs(mcpConfigPath: string): string[] {
  return [
    "-p",
    "--model",
    AGENT_MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    AGENT_VERDICT_JSON_SCHEMA,
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}__*`,
    "--max-turns",
    String(MAX_TURNS)
  ];
}

/** Run one (task, sample). The bridge must already be started. */
export async function runAgent(args: AgentRunArgs): Promise<AgentRunResult> {
  const startedTimestamp = new Date().toISOString();
  const cfgPath = join(mkdtempSync(join(tmpdir(), "a11y-agent-")), "mcp-config.json");
  writeFileSync(cfgPath, args.bridge.mcpConfig());

  const child = spawn(args.claudeBin ?? "claude", buildClaudeArgs(cfgPath), {
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.write(buildAgentPrompt(args.task));
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  const exitCode: number | null = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);

  const { assistantTexts, resultEnvelope, structuredAttempts } = parseStreamJson(stdout);
  const stepCountAtNote = args.bridge.steps.length;
  const assistantNotes: AssistantNote[] = assistantTexts.map((text) => ({
    role: "assistant_note",
    afterStepIndex: stepCountAtNote - 1,
    text
  }));

  const meta = {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    pageId: args.task.pageId,
    taskId: args.task.id,
    route: args.route,
    model: AGENT_MODEL,
    promptVersion: AGENT_PROMPT_VERSION,
    sampleIndex: args.sampleIndex,
    browser: args.browser,
    startedTimestamp,
    endedTimestamp: new Date().toISOString()
  };
  const body = { meta, steps: [...args.bridge.steps], assistantNotes };
  const trajectory: Trajectory = { ...body, contentHash: computeTrajectoryHash(body) };

  const structured = AgentVerdictOutputSchema.safeParse(resultEnvelope?.structured_output);
  let output: AgentVerdictOutput | null = structured.success ? structured.data : null;
  let salvaged = false;
  if (!output && resultEnvelope?.subtype === "error_max_structured_output_retries") {
    output = salvageStructuredOutput(structuredAttempts);
    salvaged = output !== null;
  }
  if (!output || (resultEnvelope?.is_error && !salvaged) || (exitCode !== 0 && !salvaged)) {
    return {
      trajectory,
      verdict: output ? toDomainVerdict(output).verdict : null,
      rejectedBarriers: [],
      isError: true,
      errorText:
        resultEnvelope?.result ??
        (exitCode !== 0
          ? `claude exited ${exitCode} (subtype=${resultEnvelope?.subtype ?? "none"}): ${stderr.slice(0, 800)}`
          : `no structured_output in result (subtype=${resultEnvelope?.subtype ?? "none"})`),
      resultSubtype: resultEnvelope?.subtype,
      numTurns: resultEnvelope?.num_turns,
      costUsd: resultEnvelope?.total_cost_usd,
      rawStdout: stdout
    };
  }

  const domain = toDomainVerdict(output);
  const validated = postValidateAgentVerdict(domain.verdict, trajectory);
  return {
    trajectory,
    verdict: validated.verdict,
    rejectedBarriers: validated.rejectedBarriers,
    isError: false,
    salvaged: salvaged || undefined,
    barriersParseError: domain.parseError,
    resultSubtype: resultEnvelope?.subtype,
    numTurns: resultEnvelope?.num_turns,
    costUsd: resultEnvelope?.total_cost_usd,
    rawStdout: stdout
  };
}

/** Wire → domain: parse barriersJson (failures recorded, never thrown). */
function toDomainVerdict(output: z.infer<typeof AgentVerdictOutputSchema>): {
  verdict: AgentVerdict;
  parseError?: string;
} {
  const { barriersJson, ...rest } = output;
  const { barriers, parseError } = parseBarriersJson(barriersJson);
  return { verdict: { ...rest, barriers }, parseError };
}
