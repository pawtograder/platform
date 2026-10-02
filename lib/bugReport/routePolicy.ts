/**
 * Which routes the bug-report recorder may record, and at what level.
 *
 * Off unless listed: a route missing from ROUTE_POLICY is never recorded, even with the
 * course flag on. Pages that show a whole class (gradebook, submission review, rubric
 * grading, roster, groups) are `structure` at most. A server-rendered page that doesn't
 * hydrate a TableController may be listed only with `ssrTaint: true`, and must then render
 * `<ReportTaint>` so its server-rendered values reach the taint set;
 * `tests/unit/bugReport/routePolicy.test.ts` enforces both rules.
 *
 * A pathname is resolved to the real page Next.js would render (from generated/appRoutes.json,
 * written by scripts/bugReport/generateAppRoutes.ts) before the policy is consulted, so listing
 * `/discussion/[root_id]` doesn't also record its static sibling `/discussion/new`.
 *
 * This module stays free of rrweb and Sentry imports: the recorder mount reads it on every
 * navigation to decide whether to load the recorder chunk at all.
 */
import APP_ROUTES from "./generated/appRoutes.json";

/** `full`: masked text plus the `data-report-unmask` allowlist. `structure`: every text node masked. */
export type RecordingLevel = "full" | "structure";

export type RoutePolicyEntry = {
  /** Next.js app-router pattern, e.g. "/course/[course_id]/assignments/[assignment_id]" */
  pattern: string;
  level: RecordingLevel;
  /** Required true for server-rendered pages that don't hydrate a TableController */
  ssrTaint?: boolean;
};

export const ROUTE_POLICY: readonly RoutePolicyEntry[] = [
  // A student's own assignment page and gradebook: the data on them is the viewer's own.
  { pattern: "/course/[course_id]/assignments/[assignment_id]", level: "full" },
  { pattern: "/course/[course_id]/gradebook", level: "full" },
  // Discussion and the help queue list other people's posts and requests, so they get
  // `structure` only.
  { pattern: "/course/[course_id]/discussion", level: "structure" },
  { pattern: "/course/[course_id]/discussion/[root_id]", level: "structure" },
  { pattern: "/course/[course_id]/office-hours", level: "structure" },
  { pattern: "/course/[course_id]/office-hours/[queue_id]", level: "structure" },
  // Server-rendered from rows no TableController holds; the page renders <ReportTaint>.
  { pattern: "/course/[course_id]/manage/surveys/[survey_id]/responses", level: "structure", ssrTaint: true }
];

type Segment =
  | { kind: "static"; value: string }
  | { kind: "param" }
  | { kind: "catchAll" }
  | { kind: "optionalCatchAll" };

type CompiledRoute = { pattern: string; segments: Segment[] };

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function compilePattern(pattern: string): Segment[] {
  return splitPath(pattern).map((s): Segment => {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(s)) return { kind: "optionalCatchAll" };
    if (/^\[\.\.\.[^\]]+\]$/.test(s)) return { kind: "catchAll" };
    if (/^\[[^\]]+\]$/.test(s)) return { kind: "param" };
    return { kind: "static", value: s };
  });
}

function matches(segments: Segment[], path: string[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // `[...param]` needs at least one segment and `[[...param]]` none, as in Next.js.
    if (seg.kind === "catchAll") return path.length > i;
    if (seg.kind === "optionalCatchAll") return path.length >= i;
    if (i >= path.length) return false;
    if (seg.kind === "static" && seg.value !== path[i]) return false;
  }
  return segments.length === path.length;
}

const SEGMENT_RANK: Record<Segment["kind"], number> = { static: 4, param: 3, catchAll: 2, optionalCatchAll: 1 };

/**
 * Positive when `a` is more specific than `b`. Compared segment by segment from the left, as
 * Next.js orders its routes: a static segment beats `[param]`, which beats `[...param]`, which
 * beats `[[...param]]`; when one pattern is a prefix of the other, the longer one wins.
 */
function compareSpecificity(a: Segment[], b: Segment[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = SEGMENT_RANK[a[i].kind] - SEGMENT_RANK[b[i].kind];
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function compileRoutes(patterns: readonly string[]): CompiledRoute[] {
  return patterns.map((pattern) => ({ pattern, segments: compilePattern(pattern) }));
}

let compiledAppRoutes: CompiledRoute[] | undefined;

/**
 * The app-router page Next.js would render for `pathname`, as its pattern, or null when no page
 * matches. `routes` defaults to every page under `app/` (generated/appRoutes.json).
 *
 * The policy is looked up by this pattern, never matched against the pathname itself: a listed
 * `/discussion/[root_id]` would otherwise also match `/discussion/new`, a different page.
 */
export function resolveAppRoute(pathname: string, routes?: readonly string[]): string | null {
  const compiled = routes ? compileRoutes(routes) : (compiledAppRoutes ??= compileRoutes(APP_ROUTES));
  const path = splitPath(pathname.split(/[?#]/, 1)[0]).map(safeDecode);
  let best: CompiledRoute | null = null;
  for (const candidate of compiled) {
    if (!matches(candidate.segments, path)) continue;
    if (!best || compareSpecificity(candidate.segments, best.segments) > 0) best = candidate;
  }
  return best?.pattern ?? null;
}

function isRoutePolicyEntry(value: unknown): value is RoutePolicyEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pattern === "string" &&
    v.pattern.startsWith("/") &&
    (v.level === "full" || v.level === "structure") &&
    (v.ssrTaint === undefined || typeof v.ssrTaint === "boolean")
  );
}

/**
 * The E2E-only policy from `localStorage["bugReport.testRoutePolicy"]`.
 *
 * `process.env.BUG_REPORT_E2E` is inlined at build time by `next.config.ts` from
 * `E2E_ENABLE`. A client bundle can't read `E2E_ENABLE` itself (only `NEXT_PUBLIC_*` and
 * `env` entries are inlined), so the check has to be a build-time constant. In a build
 * without `E2E_ENABLE=true` the condition folds to `false` and the minifier drops the body,
 * storage key included; nothing a user sets in their browser can turn it back on.
 */
function readTestPolicy(): RoutePolicyEntry[] {
  if (process.env.BUG_REPORT_E2E !== "true") return [];
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("bugReport.testRoutePolicy");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRoutePolicyEntry) : [];
  } catch {
    return [];
  }
}

let productionPolicy: Map<string, RoutePolicyEntry> | undefined;

/**
 * The policy entry for `pathname`, or null when the route isn't listed. The pathname is first
 * resolved to the page Next.js would render (resolveAppRoute), then that exact pattern is looked
 * up; the E2E test policy, when enabled, is looked up the same way and wins over a production
 * entry with the same pattern.
 */
export function routePolicyEntryFor(pathname: string): RoutePolicyEntry | null {
  const route = resolveAppRoute(pathname);
  if (route === null) return null;
  const testEntry = readTestPolicy().find((e) => e.pattern === route);
  if (testEntry) return testEntry;
  productionPolicy ??= new Map(ROUTE_POLICY.map((e) => [e.pattern, e]));
  return productionPolicy.get(route) ?? null;
}

/** null = don't record */
export function recordingLevelFor(pathname: string): RecordingLevel | null {
  return routePolicyEntryFor(pathname)?.level ?? null;
}

/** The numeric course id in a `/course/<id>/...` path, or null. The course flag lives on that class. */
export function courseIdFromPathname(pathname: string): number | null {
  const m = /^\/course\/(\d+)(?:\/|$)/.exec(pathname);
  return m ? Number(m[1]) : null;
}
