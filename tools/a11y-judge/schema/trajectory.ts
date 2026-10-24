/**
 * Trajectory + AgentVerdict schemas — the artifacts of an agentic SR-driving
 * run (a11y-judge v2). A trajectory is to the agent what an evidence bundle is
 * to the static judge: the frozen, content-hashed unit of science. Steps are
 * recorded HOST-SIDE at the MCP tool handler (the agent cannot misreport them).
 *
 * Hash stability: wall-clock fields are named `*Timestamp` on purpose — the
 * shared canonicalizer (schema/evidence.ts) strips /timestamp$/i keys, so
 * trajectory content hashes are stable across runs with identical behavior.
 *
 * AgentVerdictSchema imports zod/v4 (same structured-outputs rules as
 * verdict.ts: enums for bounded fields only, no refinements, optionals fine).
 */
import * as z from "zod/v4";
import { createHash } from "crypto";
import { canonicalizeForHash } from "./evidence";
import { ConfidenceSchema, FindingSchema } from "./verdict";

export const TRAJECTORY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Trajectory (host-recorded; plain types — never sent to the model as schema)
// ---------------------------------------------------------------------------

export interface TrajectoryStep {
  index: number;
  /** AtHarness command name (mcp tool name minus the mcp__at__ prefix). */
  tool: string;
  argsJson: string;
  /** Filtered observation JSON returned to the agent. */
  resultJson: string;
  /** Unfiltered spoken phrases for auditability (noise included). */
  rawSpoken: string[];
  startedTimestamp: string;
  endedTimestamp: string;
}

/** Assistant-visible text captured from the stream (excluded from replay). */
export interface AssistantNote {
  role: "assistant_note";
  afterStepIndex: number;
  text: string;
}

export interface TrajectoryMeta {
  schemaVersion: number;
  pageId: string;
  taskId: string;
  route: string;
  model: string;
  promptVersion: string;
  sampleIndex: number;
  browser: string;
  startedTimestamp: string;
  endedTimestamp: string;
}

export interface Trajectory {
  meta: TrajectoryMeta;
  steps: TrajectoryStep[];
  assistantNotes: AssistantNote[];
  contentHash: string;
}

/** sha256 over the canonicalized trajectory (timestamps stripped by the shared canonicalizer). */
export function computeTrajectoryHash(trajectory: Omit<Trajectory, "contentHash">): string {
  return createHash("sha256").update(canonicalizeForHash(trajectory)).digest("hex");
}

// ---------------------------------------------------------------------------
// AgentVerdict (the agent's structured output — via --json-schema)
// ---------------------------------------------------------------------------

/**
 * completed              — task done, no accessibility barriers worth reporting
 * completed_with_barriers — task done, but an SR/keyboard user hit real friction
 * blocked                — the task could not be completed through SR + keyboard
 */
export const TaskOutcomeSchema = z.enum(["completed", "completed_with_barriers", "blocked"]);
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;

/** A Finding plus the WCAG SC it maps to; evidenceRefs cite trajectory step indices. */
export const BarrierSchema = FindingSchema.extend({
  /** e.g. "2.4.3", "4.1.2" — best-effort mapping, "unknown" allowed. */
  wcagCriterion: z.string()
});
export type Barrier = z.infer<typeof BarrierSchema>;

/**
 * WIRE format for --json-schema. `barriers` is deliberately a JSON-encoded
 * STRING, not a nested array-of-objects: after long sessions (~100 turns) the
 * CLI's StructuredOutput parameter encoding repeatedly lost the one
 * array-of-objects property ("must have required property 'barriers'", 5/5
 * retries, two live runs), while every flat/string field survived. Short
 * sessions handle nested arrays fine (spike s4-structured-array.ts), so this
 * is robustness engineering, not a schema-capability limit. The host parses
 * and zod-validates the string into Barrier[] (parse failures are recorded,
 * never silently dropped).
 */
export const AgentVerdictOutputSchema = z.object({
  taskId: z.string(),
  outcome: TaskOutcomeSchema,
  /**
   * REQUIRED for read-tasks: the answer the task asked for (e.g. the grade
   * value). Compared host-side against seed-derived ground truth — task success
   * is never self-reported. Write "n/a" for pure write-tasks.
   */
  taskAnswer: z.string(),
  confidence: ConfidenceSchema,
  barriersJson: z
    .string()
    .describe(
      'JSON array string of barrier objects: [{"summary":string,"severity":"1"-"5","evidenceRefs":[step numbers as strings],"elementPointer":{"ariaName"?:string},"suggestedFix":string,"wcagCriterion":string}]. Use "[]" if none.'
    ),
  /** What the agent wished it could perceive/do — harness-hardening feedback. */
  evidenceGaps: z.array(z.string()),
  /**
   * Narrative of the journey from the SR user's perspective (keep it tight).
   * LAST on purpose: the CLI's parameter parsing repeatedly corrupts the
   * property that FOLLOWS a long string value (observed dropping `barriers`,
   * then `barriersJson`, always the post-narrative slot, 5/5 retries each) —
   * with the long field last there is no following property to lose.
   */
  narrative: z.string()
});
export type AgentVerdictOutput = z.infer<typeof AgentVerdictOutputSchema>;

/** Domain shape used by predicates/reports: barriers parsed into objects. */
export interface AgentVerdict extends Omit<AgentVerdictOutput, "barriersJson"> {
  barriers: Barrier[];
}

/** Parse + validate the wire barriersJson. Failures are reported, not thrown. */
export function parseBarriersJson(barriersJson: string): { barriers: Barrier[]; parseError?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(barriersJson);
  } catch (e) {
    return { barriers: [], parseError: `barriersJson is not valid JSON: ${(e as Error).message}` };
  }
  const parsed = z.array(BarrierSchema).safeParse(raw);
  if (!parsed.success) {
    return { barriers: [], parseError: `barriersJson failed validation: ${parsed.error.message.slice(0, 400)}` };
  }
  return { barriers: parsed.data };
}

/** --json-schema payload ($schema stripped: the CLI validator rejects it). */
export const AGENT_VERDICT_JSON_SCHEMA = JSON.stringify(
  Object.fromEntries(Object.entries(z.toJSONSchema(AgentVerdictOutputSchema)).filter(([key]) => key !== "$schema"))
);

/**
 * Reject barriers whose evidenceRefs cite step indices that don't exist in the
 * trajectory (pattern-copy of judge/client.ts postValidateVerdict — hallucinated
 * citations are rejected and counted, never silently kept).
 */
export function postValidateAgentVerdict(
  verdict: AgentVerdict,
  trajectory: Pick<Trajectory, "steps">
): { verdict: AgentVerdict; rejectedBarriers: Barrier[] } {
  const validIndices = new Set(trajectory.steps.map((s) => String(s.index)));
  const kept: Barrier[] = [];
  const rejected: Barrier[] = [];
  for (const barrier of verdict.barriers) {
    const refsOk =
      barrier.evidenceRefs.length > 0 &&
      barrier.evidenceRefs.every((ref) => validIndices.has(ref.replace(/^step[- ]?/i, "")));
    (refsOk ? kept : rejected).push(barrier);
  }
  return { verdict: { ...verdict, barriers: kept }, rejectedBarriers: rejected };
}
