/**
 * VerdictSchema — the structured output the LLM judge emits per (page, criterion)
 * evidence bundle.
 *
 * EXTRACTABLE CORE: this file imports ONLY `zod`. It is passed to
 * `zodOutputFormat()` from `@anthropic-ai/sdk/helpers/zod`, which is built
 * against `zod/v4` — so we import the v4 entrypoint (`zod` 3.25+ ships it) to
 * keep the schema type-compatible with the helper.
 *
 * Structured-outputs compatibility rules (enforced by hand here — there is no
 * runtime guard):
 *   - enums only for the bounded fields (verdict/confidence/severity),
 *   - no numeric min/max, no string minLength/maxLength, no `.refine()`,
 *   - optional properties are fine (they are simply omitted from `required`).
 * Violating these makes `zodOutputFormat` emit a schema the API rejects.
 */
import * as z from "zod/v4";

/** pass | fail | needs_human — `needs_human` is honest abstention, not a soft fail. */
export const VerdictValueSchema = z.enum(["pass", "fail", "needs_human"]);
export type VerdictValue = z.infer<typeof VerdictValueSchema>;

/** Judge's self-reported confidence in the verdict. */
export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** 1 (cosmetic) .. 5 (blocks task completion). Enum, not a number, for structured outputs. */
export const SeveritySchema = z.enum(["1", "2", "3", "4", "5"]);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Where a finding points. All fields optional — the judge supplies whichever it
 * can resolve from the probes. `testId`/`selector` are post-validated against the
 * serialized probe JSON (see judge/client.ts) to reject hallucinated pointers.
 */
export const ElementPointerSchema = z.object({
  selector: z.string().optional(),
  testId: z.string().optional(),
  ariaName: z.string().optional()
});
export type ElementPointer = z.infer<typeof ElementPointerSchema>;

export const FindingSchema = z.object({
  summary: z.string(),
  severity: SeveritySchema,
  /** Probe ids or attachment file names that back this finding. Post-validated. */
  evidenceRefs: z.array(z.string()),
  elementPointer: ElementPointerSchema,
  suggestedFix: z.string()
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictSchema = z.object({
  criterion: z.string(),
  verdict: VerdictValueSchema,
  confidence: ConfidenceSchema,
  rationale: z.string(),
  findings: z.array(FindingSchema),
  /** What the evidence could not show — collector-hardening feedback. */
  evidenceGaps: z.array(z.string()),
  /** Additional probes that would let the judge decide — round-2 material. */
  requestedProbes: z.array(z.string())
});
export type Verdict = z.infer<typeof VerdictSchema>;
