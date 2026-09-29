/**
 * Maps a Supabase response to the privacy kinds of its values (bug reporter spec, package 2).
 *
 * - PostgREST (`/rest/v1/<relation>`): response keys map to `relation.column` through the URL's
 *   `select=`, following aliases (`mentor:profiles(...)`), FK hints (`profiles!fk_name(...)`,
 *   `!inner`), and nested embeds; `*` maps every other key to a column of the current relation.
 * - RPC (`/rest/v1/rpc/<fn>`): through `RPCS`; a `{ $table }` result is walked as rows, honoring
 *   `select=` when the call has one.
 * - Edge functions (`/functions/v1/<slug>`): through `EDGE_FUNCTIONS`, the union of every wrapper in
 *   `lib/edgeFunctions.ts` that invokes the slug.
 *
 * Only non-`none` values come out. Keys and paths with no classification are reported in
 * `unclassified` rather than guessed.
 */
import { COLUMNS, EDGE_FUNCTIONS, RPCS } from "./privacy";
import edgeWrappers from "./generated/edgeFunctionWrappers.json";
import relationshipsJson from "./generated/relationships.json";
import {
  formatJsonPath,
  isPiiKind,
  isTableRef,
  type EdgeWrappersJson,
  type JsonPathMap,
  type JsonPathSegment,
  type PiiKind,
  type RelationshipsJson,
  type TableRef
} from "./privacyTypes";

export type TaintKind = Exclude<PiiKind, "none">;

/** One classified value. `source` names where the kind came from ("profiles.name", "rpc:fn $.x"). */
export type ClassifiedValue = { value: string; kind: TaintKind; source: string };

export type ClassifyResult = {
  /** False when the URL is not a PostgREST, RPC, or edge-function URL. */
  handled: boolean;
  values: ClassifiedValue[];
  /** Keys ("table.column") or paths ("rpc:fn $.x") that have no classification. */
  unclassified: string[];
};

export type SelectItem = {
  /** Response key: the alias, else the column or relation name (or the last `->` segment). */
  key: string;
  /** Column or relation name, without hints or JSON path. */
  name: string;
  hints: string[];
  /** Present for embeds. */
  children?: SelectTree;
};

export type SelectTree = { star: boolean; items: SelectItem[] };

const RELATIONS = relationshipsJson as RelationshipsJson;
const WRAPPERS_BY_SLUG = edgeWrappers as EdgeWrappersJson;

// --- select= parsing ----------------------------------------------------------------------------

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1");

/** Parses a PostgREST `select` value, e.g. `*,mentor:profiles!fk(name),users!inner(email)`. */
export function parseSelect(select: string): SelectTree {
  const tree: SelectTree = { star: false, items: [] };
  for (const part of splitTopLevel(select.replace(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ""))) {
    if (part === "*") {
      tree.star = true;
      continue;
    }
    const open = part.indexOf("(");
    const head = open >= 0 ? part.slice(0, open) : part;
    const inner = open >= 0 ? part.slice(open + 1, part.lastIndexOf(")")) : undefined;
    // [alias:]name[!hint...][->json->>path][::cast]
    const aliased = head.match(/^([^:!]+):(?!:)(.*)$/);
    const alias = aliased ? unquote(aliased[1]) : undefined;
    const rest = (aliased ? aliased[2] : head).replace(/::[\w\s[\]]+$/, "");
    const [target, ...hints] = rest.split("!");
    const jsonPath = target.split(/->>?/);
    const name = unquote(jsonPath[0]);
    const key = alias ?? (jsonPath.length > 1 ? unquote(jsonPath[jsonPath.length - 1]) : name);
    const item: SelectItem = { key, name, hints: hints.map(unquote) };
    if (inner !== undefined) item.children = parseSelect(inner);
    tree.items.push(item);
  }
  return tree;
}

/**
 * The relation an embed reads from. An embed names a relation directly (hints only disambiguate
 * which FK); otherwise it names an FK constraint or FK column of the parent, resolved through the
 * generated relationships.
 */
export function resolveEmbed(parent: string, item: SelectItem): string | null {
  if (RELATIONS[item.name]) return item.name;
  const fks = RELATIONS[parent]?.fks ?? [];
  for (const ref of [item.name, ...item.hints]) {
    const matches = fks.filter((fk) => fk.name === ref || (fk.columns.length === 1 && fk.columns[0] === ref));
    // A table FK is also listed against every view built on the referenced table; prefer the table.
    const match = matches.find((fk) => RELATIONS[fk.ref]?.kind === "table") ?? matches[0];
    if (match) return match.ref;
  }
  return null;
}

// --- walking ------------------------------------------------------------------------------------

class Collector {
  values: ClassifiedValue[] = [];
  private missing = new Set<string>();
  unclassified(key: string) {
    this.missing.add(key);
  }
  get unclassifiedKeys() {
    return [...this.missing];
  }
  /** Emits every string (and, for grades and handles, number) at or beneath `v`. */
  leaves(v: unknown, kind: PiiKind, source: string) {
    if (kind === "none" || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (v.length > 0) this.values.push({ value: v, kind, source });
    } else if (typeof v === "number") {
      if (kind === "grade" || kind === "handle") this.values.push({ value: String(v), kind, source });
    } else if (Array.isArray(v)) {
      for (const x of v) this.leaves(x, kind, source);
    } else if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) this.leaves(x, kind, source);
    }
  }
}

function walkRows(out: Collector, relation: string, rows: unknown, select: SelectTree | null) {
  if (Array.isArray(rows)) {
    for (const r of rows) walkRows(out, relation, r, select);
    return;
  }
  if (rows === null || typeof rows !== "object") return;
  const star = select === null || select.star;
  const byKey = new Map((select?.items ?? []).map((i) => [i.key, i]));
  for (const [key, value] of Object.entries(rows as Record<string, unknown>)) {
    const item = byKey.get(key);
    if (item?.children) {
      const target = resolveEmbed(relation, item);
      if (!target) out.unclassified(`${relation}.${key} (embed)`);
      else walkRows(out, target, value, item.children);
      continue;
    }
    const column = item ? item.name : star ? key : undefined;
    if (column === "count" && typeof value === "number") continue;
    const colKey = `${relation}.${column ?? key}`;
    const kind = column !== undefined ? COLUMNS[colKey] : undefined;
    if (kind === undefined) {
      if (value !== null) out.unclassified(colKey);
      continue;
    }
    out.leaves(value, kind, colKey);
  }
}

/** Walks `body` against a JSONPath map; the most specific matching path decides each value's kind. */
function walkJsonPathMap(
  out: Collector,
  map: JsonPathMap,
  body: unknown,
  source: string,
  select: SelectTree | null = null
) {
  const visit = (node: unknown, path: JsonPathSegment[], inherited: PiiKind | undefined) => {
    const p = formatJsonPath(path);
    const here: PiiKind | TableRef | undefined = map[p];
    if (isTableRef(here)) {
      walkRows(out, here.$table, node, select);
      return;
    }
    const kind = isPiiKind(here) ? here : inherited;
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, [...path, { any: true }], kind);
    } else if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) visit(v, [...path, { key: k }], kind);
    } else if (kind === undefined) {
      out.unclassified(`${source} ${p}`);
    } else {
      out.leaves(node, kind, `${source} ${p}`);
    }
  };
  visit(body, [], undefined);
}

function edgeFunctionMap(slug: string): JsonPathMap | undefined {
  const wrappers = WRAPPERS_BY_SLUG[slug];
  if (!wrappers) return undefined;
  const merged: Record<string, PiiKind | TableRef> = {};
  for (const w of wrappers) {
    for (const [p, v] of Object.entries(EDGE_FUNCTIONS[w] ?? {})) {
      // Wrappers sharing a slug may classify one path differently; the first PII kind wins over none.
      if (merged[p] === undefined || merged[p] === "none") merged[p] = v;
    }
  }
  return merged;
}

/**
 * Classifies a Supabase response body. `url` may be absolute or relative; `method` is accepted for
 * the ingest wrapper's convenience (every method that returns a body is classified the same way).
 */
export function classifyResponse(url: string, method: string, body: unknown): ClassifyResult {
  const out = new Collector();
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return { handled: false, values: [], unclassified: [] };
  }
  const selectParam = parsed.searchParams.get("select");
  const select = selectParam ? parseSelect(selectParam) : null;
  const path = parsed.pathname;
  let m: RegExpMatchArray | null;
  if (method.toUpperCase() === "HEAD" || method.toUpperCase() === "OPTIONS") {
    return { handled: false, values: [], unclassified: [] };
  } else if ((m = path.match(/\/rest\/v1\/rpc\/([^/]+)\/?$/))) {
    const fn = decodeURIComponent(m[1]);
    const c = RPCS[fn];
    if (c === undefined) out.unclassified(`rpc:${fn}`);
    else if (isTableRef(c)) walkRows(out, c.$table, body, select);
    else if (isPiiKind(c)) out.leaves(body, c, `rpc:${fn}`);
    else walkJsonPathMap(out, c, body, `rpc:${fn}`, select);
  } else if ((m = path.match(/\/rest\/v1\/([^/]+)\/?$/))) {
    const relation = decodeURIComponent(m[1]);
    if (!RELATIONS[relation]) out.unclassified(relation);
    else walkRows(out, relation, body, select);
  } else if ((m = path.match(/\/functions\/v1\/([^/]+)/))) {
    const slug = decodeURIComponent(m[1]);
    const map = edgeFunctionMap(slug);
    if (!map) out.unclassified(`edge:${slug}`);
    else walkJsonPathMap(out, map, body, `edge:${slug}`);
  } else {
    return { handled: false, values: [], unclassified: [] };
  }
  return { handled: true, values: out.values, unclassified: out.unclassifiedKeys };
}

/** Classifies rows of a known relation (TableController `initialData`, realtime `postgres_changes`). */
export function classifyRows(relation: string, rows: unknown): Omit<ClassifyResult, "handled"> {
  const out = new Collector();
  walkRows(out, relation, rows, null);
  return { values: out.values, unclassified: out.unclassifiedKeys };
}
