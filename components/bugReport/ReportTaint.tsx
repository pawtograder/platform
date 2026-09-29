import { COURSE_FEATURES, courseFeatureEnabled } from "@/lib/courseFeatures";
import { ROUTE_POLICY } from "@/lib/bugReport/routePolicy";
import { TAINT_BLOCK_ID, type TaintBlockPayload, type TaintKind } from "@/lib/bugReport/taint";

/**
 * Taint block for server-rendered pages listed with `ssrTaint: true` (spec section 4.3).
 *
 * A server component that renders PII without hydrating a TableController gives the values it
 * rendered here; the recorder reads the block at start and adds them to the taint set. It
 * renders nothing unless the course flag is on and `pattern` is listed with `ssrTaint: true`,
 * so pages pay nothing while recording is off.
 *
 * Package 1 ships this minimal version so the route-policy test has something to check;
 * package 2 owns it from here.
 */
export function ReportTaint({
  values,
  features,
  pattern
}: {
  values: Partial<Record<TaintKind, readonly (string | null | undefined)[]>>;
  /** `classes.features` of the course the page belongs to. */
  features: { name: string; enabled: boolean }[] | null | undefined;
  /** This page's ROUTE_POLICY pattern. */
  pattern: string;
}) {
  if (!courseFeatureEnabled(features, COURSE_FEATURES.BUG_REPORT_RECORDING)) return null;
  if (!ROUTE_POLICY.some((e) => e.pattern === pattern && e.ssrTaint)) return null;
  const payload: TaintBlockPayload = { v: 1, values: {} };
  for (const [kind, list] of Object.entries(values) as [TaintKind, readonly (string | null | undefined)[]][]) {
    payload.values[kind] = Array.from(new Set(list.filter((v): v is string => typeof v === "string" && v !== "")));
  }
  return (
    <script
      type="application/json"
      id={TAINT_BLOCK_ID}
      // JSON is not HTML-safe inside <script>: escape "<" so a value holding "</script>" can't
      // close the tag, and the two line separators JSON allows but some parsers don't.
      dangerouslySetInnerHTML={{ __html: serializeTaintPayload(payload) }}
    />
  );
}

export function serializeTaintPayload(payload: TaintBlockPayload): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
