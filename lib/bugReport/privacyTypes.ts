/**
 * Types for the privacy classification in `privacy.ts` (spec §4.3), kept apart so the generator and
 * the postprocess script can import them without loading the whole classification.
 */

export type PiiKind = "name" | "email" | "handle" | "grade" | "free_text" | "none";

export const PII_KINDS: readonly PiiKind[] = ["name", "email", "handle", "grade", "free_text", "none"];

/**
 * Marks a value as one row (an object) or several rows (an array of objects) of a public table or
 * view; its keys are classified through that relation's `COLUMNS` entries. Used for SETOF RPCs and
 * for Json results that embed whole rows (e.g. `to_jsonb(p.*)`).
 */
export type TableRef = { readonly $table: string };

/**
 * JSONPath (subset: `$`, `.key`, `[*]`) to kind. The most specific path that covers a value decides
 * its kind, and a path to an object or array covers everything beneath it. `none` must be explicit:
 * a value no path covers is reported as unclassified, never treated as `none`.
 */
export type JsonPathMap = Readonly<Record<string, PiiKind | TableRef>>;

/**
 * An RPC's result: a kind for scalar returns and arrays of scalars, a `TableRef` for rows of a
 * table (SETOF or a single row), or a JSONPath map for Json and `RETURNS TABLE(...)` results.
 */
export type RpcClassification = PiiKind | TableRef | JsonPathMap;

export function isTableRef(v: unknown): v is TableRef {
  return typeof v === "object" && v !== null && typeof (v as { $table?: unknown }).$table === "string";
}

export function isPiiKind(v: unknown): v is PiiKind {
  return typeof v === "string" && (PII_KINDS as readonly string[]).includes(v);
}

/** One path segment: an object key, or `*` for every array element. */
export type JsonPathSegment = { key: string } | { any: true };

const SEGMENT = /\.([^.[\]]+)|\[\*\]/y;

/** Parses the JSONPath subset. Throws on anything outside `$`, `.key`, `[*]`. */
export function parseJsonPath(path: string): JsonPathSegment[] {
  if (!path.startsWith("$")) throw new Error(`JSONPath must start with $: ${path}`);
  const segments: JsonPathSegment[] = [];
  SEGMENT.lastIndex = 1;
  while (SEGMENT.lastIndex < path.length) {
    const start = SEGMENT.lastIndex;
    const m = SEGMENT.exec(path);
    if (!m) throw new Error(`unsupported JSONPath syntax at offset ${start}: ${path}`);
    segments.push(m[1] !== undefined ? { key: m[1] } : { any: true });
  }
  return segments;
}

/** Canonical text of a concrete path, with array indexes written as `[*]`, for lookups in a JsonPathMap. */
export function formatJsonPath(segments: readonly JsonPathSegment[]): string {
  return "$" + segments.map((s) => ("key" in s ? `.${s.key}` : "[*]")).join("");
}
