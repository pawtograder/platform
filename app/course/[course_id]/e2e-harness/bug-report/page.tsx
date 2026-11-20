import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TAINT_BLOCK_ID, type TaintBlockPayload } from "@/lib/bugReport/taint";
import { serializeTaintPayload } from "@/components/bugReport/ReportTaint";
import BugReportHarness from "./harness";
import { parseLeakValues } from "./leakValues";

/**
 * E2E-only fixture page for the bug-report recorder and redaction tests (C2, C5, C6, D8-D12,
 * D15, D17). `BUG_REPORT_E2E` is inlined at build time from E2E_ENABLE (next.config.ts), so
 * outside E2E builds this route is always a 404.
 *
 * The `leaks` fixture renders the values in `?v=` (JSON) and, standing in for the ingest points
 * that would have seen them arrive from the server, puts them in a taint block.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ fixture?: string; v?: string }> }) {
  if (process.env.BUG_REPORT_E2E !== "true") notFound();
  const { fixture, v } = await searchParams;
  const leak = fixture === "leaks" ? parseLeakValues(v) : null;
  const payload: TaintBlockPayload | null = leak
    ? { v: 1, values: { name: [leak.name, leak.otherName], email: [leak.email], handle: [leak.handle] } }
    : null;
  return (
    <>
      {payload && (
        <script
          type="application/json"
          id={TAINT_BLOCK_ID}
          dangerouslySetInnerHTML={{ __html: serializeTaintPayload(payload) }}
        />
      )}
      <Suspense>
        <BugReportHarness />
      </Suspense>
    </>
  );
}
