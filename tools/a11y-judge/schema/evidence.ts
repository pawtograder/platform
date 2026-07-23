/**
 * Evidence bundle schema + canonical content hashing for the a11y-judge kit.
 *
 * EXTRACTABLE CORE: this file may import ONLY `zod` and node builtins. It must
 * never import from `app/`, `tests/`, `lib/`, `components/`, or use the `@/*`
 * alias, so the whole `tools/a11y-judge/` tree can be lifted into a standalone
 * package by copying it + adding a package.json.
 *
 * The content hash is the "unit of science" for the judge: two collection runs
 * that produce semantically identical evidence must hash identically so cached
 * LLM verdicts are never re-billed. To achieve that the hash is computed over a
 * canonical projection of the bundle:
 *   - object keys are recursively sorted,
 *   - `collectedAt` and any `*Timestamp` field are stripped (wall-clock noise),
 *   - the self-referential `contentHash` field is stripped,
 *   - numeric fields named x/y/w/h/width/height are quantized to a 4px grid
 *     (`Math.round(v / 4) * 4`) to absorb sub-pixel layout jitter,
 * then sha256'd together with the sorted list of attachment sha256 digests.
 */
import { createHash } from "crypto";
import { z } from "zod";

/** Fields (by key name) that carry layout coordinates and get quantized. */
const QUANTIZED_KEYS = new Set(["x", "y", "w", "h", "width", "height"]);
/** The 4px grid used to quantize coordinates before hashing. */
const QUANT_GRID = 4;

/** A single measured tab stop — ported from the audit spec's AuditStop shape. */
export const AuditStopSchema = z.object({
  n: z.number(),
  tag: z.string(),
  id: z.string().nullable(),
  role: z.string().nullable(),
  ariaLabel: z.string().nullable(),
  name: z.string(),
  testId: z.string().nullable(),
  href: z.string().nullable(),
  container: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  visible: z.boolean(),
  followsPrevious: z.boolean().nullable()
});
export type AuditStop = z.infer<typeof AuditStopSchema>;

/** Rectangle used for focus-indicator crops. */
export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
});
export type Rect = z.infer<typeof RectSchema>;

/**
 * WCAG 2.4.3 tab-order probe: the ordered keyboard-focus walk plus whether the
 * walk wrapped around (two consecutive body hits) or was truncated at maxStops.
 */
export const TabOrderProbeSchema = z.object({
  type: z.literal("tab-order"),
  id: z.string(),
  maxStops: z.number(),
  wrappedAround: z.boolean(),
  truncated: z.boolean(),
  stops: z.array(AuditStopSchema)
});
export type TabOrderProbe = z.infer<typeof TabOrderProbeSchema>;

/**
 * WCAG 2.4.7 focus-indicator probe: per-stop computed styles read WHILE
 * keyboard focus is live (see focusIndicator.ts header for the Zag/Chakra
 * async-re-render gotcha). Each stop references a focused crop + a reference
 * crop (same rect from the pristine pre-tab screenshot) via attachment ids.
 */
export const FocusIndicatorStopSchema = z.object({
  n: z.number(),
  tag: z.string(),
  role: z.string().nullable(),
  name: z.string(),
  testId: z.string().nullable(),
  outline: z.string(),
  boxShadow: z.string(),
  borderColor: z.string(),
  focusVisibleAttr: z.boolean(),
  rect: RectSchema,
  focusedAttachmentId: z.string().nullable(),
  referenceAttachmentId: z.string().nullable()
});
export type FocusIndicatorStop = z.infer<typeof FocusIndicatorStopSchema>;

export const FocusIndicatorProbeSchema = z.object({
  type: z.literal("focus-indicator"),
  id: z.string(),
  stops: z.array(FocusIndicatorStopSchema)
});
export type FocusIndicatorProbe = z.infer<typeof FocusIndicatorProbeSchema>;

/**
 * Generic escape hatch so Wave-2 collectors (readingOrder, nameRoleValue,
 * liveRegions, errorFlows) can ship probes before dedicated schema types exist.
 */
export const RawJsonProbeSchema = z.object({
  type: z.literal("raw-json"),
  id: z.string(),
  label: z.string(),
  data: z.unknown()
});
export type RawJsonProbe = z.infer<typeof RawJsonProbeSchema>;

export const ProbeSchema = z.discriminatedUnion("type", [
  TabOrderProbeSchema,
  FocusIndicatorProbeSchema,
  RawJsonProbeSchema
]);
export type Probe = z.infer<typeof ProbeSchema>;

export const AttachmentSchema = z.object({
  file: z.string(),
  sha256: z.string(),
  mime: z.string(),
  role: z.string(),
  probeId: z.string().nullable()
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const PageMetaSchema = z.object({
  id: z.string(),
  route: z.string(),
  title: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  browser: z.string()
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

export const CollectorInfoSchema = z.object({
  name: z.string(),
  version: z.string()
});
export type CollectorInfo = z.infer<typeof CollectorInfoSchema>;

export const EvidenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  page: PageMetaSchema,
  criterion: z.string(),
  collector: CollectorInfoSchema,
  /** ISO string; EXCLUDED from the content hash. */
  collectedAt: z.string(),
  probes: z.array(ProbeSchema),
  attachments: z.array(AttachmentSchema),
  contentHash: z.string()
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

/** Keys stripped entirely from the canonical projection before hashing. */
function isStrippedKey(key: string): boolean {
  return key === "collectedAt" || key === "contentHash" || /timestamp$/i.test(key);
}

/**
 * Recursively project a value into its canonical form: object keys sorted,
 * noise keys stripped, coordinate numbers quantized to the 4px grid. `keyName`
 * is the name of the property this value was read from (drives quantization).
 */
function canonicalize(value: unknown, keyName?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (isStrippedKey(key)) continue;
      out[key] = canonicalize(source[key], key);
    }
    return out;
  }
  if (typeof value === "number" && keyName !== undefined && QUANTIZED_KEYS.has(keyName)) {
    return Math.round(value / QUANT_GRID) * QUANT_GRID;
  }
  return value;
}

/**
 * Canonical JSON string for a bundle (or any sub-value): recursively
 * sorted keys, timestamps + contentHash stripped, coordinates quantized.
 * Exported for unit testing.
 */
export function canonicalizeForHash(bundle: unknown): string {
  return JSON.stringify(canonicalize(bundle));
}

/**
 * sha256 over the canonical bundle string concatenated with the sorted
 * attachment sha256 digests. Exported for unit testing.
 */
export function computeContentHash(bundle: unknown, attachmentHashes: readonly string[]): string {
  const canonical = canonicalizeForHash(bundle);
  const sortedAttachments = [...attachmentHashes].sort();
  const hash = createHash("sha256");
  hash.update(canonical);
  hash.update("\n");
  hash.update(sortedAttachments.join(","));
  return hash.digest("hex");
}
