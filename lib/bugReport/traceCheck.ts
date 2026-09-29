/**
 * Checks over the taint trace's output (spec package 2a): the flows the E2E trace observed
 * (`generated/privacy.observed.json`) and the components it saw render PII
 * (`generated/pii-sinks.json`).
 *
 * - Every observed flow must have a classification other than `none` in `privacy.ts`.
 * - No PII may render inside `data-report-unmask`.
 *
 * Shared by the Playwright trace fixture (strict mode), `scripts/bugReport/checkTrace.ts`, and the
 * Jest test over the committed files.
 */
import * as privacy from "./privacy";
import edgeWrappers from "./generated/edgeFunctionWrappers.json";
import {
  formatJsonPath,
  isPiiKind,
  isTableRef,
  parseJsonPath,
  type EdgeWrappersJson,
  type JsonPathMap,
  type PiiKind,
  type RpcClassification
} from "./privacyTypes";

export type ObservedKind = Exclude<PiiKind, "none">;

/**
 * One flow of a canary into the browser.
 *
 * `source` says how it arrived: `rest:<relation>`, `rpc:<function>`, `edge:<wrapper or slug>`,
 * `realtime:<table>`, `rsc:<route>` (a server component payload), or `api:<path>`.
 * `key` says where in the payload: `table.column` for rows, a JSONPath (`$.a[*].b`) for RPC and edge
 * results, and `?<name>` when the trace could not tell which column a server payload property is.
 */
export type ObservedFlow = {
  source: string;
  key: string;
  /** The kind of the canary seen there */
  kind: ObservedKind;
  /** Route pattern of the page where the flow was first seen (lowest in sort order across the run) */
  firstSeenIn: string;
  /** Spec file and title of the test that saw it there */
  test: string;
};

/** Route pattern → component → kinds rendered. See `sinkComponentKey` for how unmasked sinks are named. */
export type PiiSinks = Record<string, Record<string, ObservedKind[]>>;

export type Classification = {
  COLUMNS: Readonly<Record<string, PiiKind>>;
  RPCS: Readonly<Record<string, RpcClassification>>;
  EDGE_FUNCTIONS: Readonly<Record<string, JsonPathMap>>;
};

export const CURRENT_CLASSIFICATION: Classification = {
  COLUMNS: privacy.COLUMNS,
  RPCS: privacy.RPCS,
  EDGE_FUNCTIONS: privacy.EDGE_FUNCTIONS
};

const WRAPPERS_BY_SLUG = edgeWrappers as EdgeWrappersJson;

/** Marker in a sink's component key for text inside `[data-report-unmask]`. */
export const UNMASK_MARKER = "[data-report-unmask by ";

/**
 * The component key a sink is recorded under: the nearest `data-sentry-component`, with the
 * component carrying `data-report-unmask` appended when the text is unmasked, e.g.
 * `PersonName [data-report-unmask by StudentCard]`.
 */
export function sinkComponentKey(component: string, unmaskedBy: string | null): string {
  return unmaskedBy === null ? component : `${component} ${UNMASK_MARKER}${unmaskedBy}]`;
}

function lookupJsonPath(map: JsonPathMap, key: string, c: Classification): PiiKind | undefined {
  let segments;
  try {
    segments = parseJsonPath(key);
  } catch {
    return undefined;
  }
  for (let n = segments.length; n >= 0; n--) {
    const here = map[formatJsonPath(segments.slice(0, n))];
    if (here === undefined) continue;
    if (isPiiKind(here)) return here;
    if (isTableRef(here)) {
      // Rows of a table: the first object key below the reference names the column.
      const column = segments.slice(n).find((s): s is { key: string } => "key" in s);
      return column ? c.COLUMNS[`${here.$table}.${column.key}`] : undefined;
    }
  }
  return undefined;
}

function edgeMap(name: string, c: Classification): JsonPathMap | undefined {
  if (c.EDGE_FUNCTIONS[name]) return c.EDGE_FUNCTIONS[name];
  const wrappers = WRAPPERS_BY_SLUG[name];
  if (!wrappers) return undefined;
  const merged: Record<string, JsonPathMap[string]> = {};
  for (const w of wrappers) {
    for (const [p, v] of Object.entries(c.EDGE_FUNCTIONS[w] ?? {})) {
      if (merged[p] === undefined || merged[p] === "none") merged[p] = v;
    }
  }
  return merged;
}

/**
 * The classification `privacy.ts` gives a flow, or undefined when it has none. Row keys
 * (`table.column`) resolve through COLUMNS whatever the source; JSONPath keys resolve through the
 * RPC's or edge function's map, most specific covering path first.
 */
export function classificationOf(
  source: string,
  key: string,
  c: Classification = CURRENT_CLASSIFICATION
): PiiKind | undefined {
  if (key.startsWith("?")) return undefined;
  if (!key.startsWith("$")) return c.COLUMNS[key];
  const [type, ...rest] = source.split(":");
  const name = rest.join(":");
  if (type === "rpc") {
    const rpc = c.RPCS[name];
    if (rpc === undefined) return undefined;
    if (isPiiKind(rpc)) return rpc;
    if (isTableRef(rpc)) return lookupJsonPath({ $: rpc }, key, c);
    return lookupJsonPath(rpc, key, c);
  }
  if (type === "edge") {
    const map = edgeMap(name, c);
    return map ? lookupJsonPath(map, key, c) : undefined;
  }
  return undefined;
}

export type TraceFailure = { kind: "unclassified" | "classified-none" | "unmasked"; message: string };

/** Fails every observed flow with no classification, or classified `none` although it carried PII. */
export function checkObserved(observed: readonly ObservedFlow[], c: Classification = CURRENT_CLASSIFICATION) {
  const failures: TraceFailure[] = [];
  for (const flow of observed) {
    const classified = classificationOf(flow.source, flow.key, c);
    if (classified !== undefined && classified !== "none") continue;
    const where = `on ${flow.firstSeenIn} (${flow.test})`;
    failures.push(
      classified === undefined
        ? {
            kind: "unclassified",
            message: `${flow.key} from ${flow.source} carried a ${flow.kind} canary ${where}, but privacy.ts has no classification for it`
          }
        : {
            kind: "classified-none",
            message: `${flow.key} from ${flow.source} carried a ${flow.kind} canary ${where}, but privacy.ts classifies it as none`
          }
    );
  }
  return failures;
}

/** Fails every component that rendered a canary inside `data-report-unmask`. */
export function checkSinks(sinks: PiiSinks) {
  const failures: TraceFailure[] = [];
  for (const [route, components] of Object.entries(sinks)) {
    for (const [component, kinds] of Object.entries(components)) {
      const at = component.indexOf(UNMASK_MARKER);
      if (at < 0 || kinds.length === 0) continue;
      const inner = component.slice(0, at).trim();
      const carrier = component.slice(at + UNMASK_MARKER.length, -1);
      failures.push({
        kind: "unmasked",
        message: `${carrier} carries data-report-unmask, and ${inner === carrier ? "it" : inner} rendered ${kinds.join(", ")} canaries inside it on ${route}`
      });
    }
  }
  return failures;
}

// --- normalization and merging, for stable diffs -----------------------------------------------

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One entry per (source, key, kind), keeping the lowest (route, test); sorted. */
export function normalizeObserved(flows: Iterable<ObservedFlow>): ObservedFlow[] {
  const byKey = new Map<string, ObservedFlow>();
  for (const f of flows) {
    const id = `${f.source}\u0000${f.key}\u0000${f.kind}`;
    const prev = byKey.get(id);
    if (
      !prev ||
      compare(f.firstSeenIn, prev.firstSeenIn) < 0 ||
      (f.firstSeenIn === prev.firstSeenIn && compare(f.test, prev.test) < 0)
    ) {
      byKey.set(id, { source: f.source, key: f.key, kind: f.kind, firstSeenIn: f.firstSeenIn, test: f.test });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => compare(a.source, b.source) || compare(a.key, b.key) || compare(a.kind, b.kind)
  );
}

/** Sorted routes, components, and kinds; empty entries dropped. */
export function normalizeSinks(...all: PiiSinks[]): PiiSinks {
  const merged = new Map<string, Map<string, Set<ObservedKind>>>();
  for (const sinks of all) {
    for (const [route, components] of Object.entries(sinks)) {
      const r = merged.get(route) ?? new Map();
      merged.set(route, r);
      for (const [component, kinds] of Object.entries(components)) {
        const set = r.get(component) ?? new Set();
        r.set(component, set);
        for (const k of kinds) set.add(k);
      }
    }
  }
  const out: PiiSinks = {};
  for (const route of [...merged.keys()].sort(compare)) {
    const components = merged.get(route)!;
    const r: Record<string, ObservedKind[]> = {};
    for (const component of [...components.keys()].sort(compare)) {
      const kinds = [...components.get(component)!].sort(compare);
      if (kinds.length > 0) r[component] = kinds;
    }
    if (Object.keys(r).length > 0) out[route] = r;
  }
  return out;
}

/** The JSON text written for a generated file: two-space indent, trailing newline. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Components that rendered free text or grades, which package 3 wraps in `<ReportBlock>`. */
export function blockCandidates(sinks: PiiSinks): { component: string; kinds: ObservedKind[]; routes: string[] }[] {
  const byComponent = new Map<string, { kinds: Set<ObservedKind>; routes: Set<string> }>();
  for (const [route, components] of Object.entries(sinks)) {
    for (const [component, kinds] of Object.entries(components)) {
      const wanted = kinds.filter((k) => k === "free_text" || k === "grade");
      if (wanted.length === 0) continue;
      const name = component.split(" [")[0];
      const entry = byComponent.get(name) ?? { kinds: new Set(), routes: new Set() };
      byComponent.set(name, entry);
      wanted.forEach((k) => entry.kinds.add(k));
      entry.routes.add(route);
    }
  }
  return [...byComponent]
    .sort(([a], [b]) => compare(a, b))
    .map(([component, { kinds, routes }]) => ({
      component,
      kinds: [...kinds].sort(compare),
      routes: [...routes].sort(compare)
    }));
}
