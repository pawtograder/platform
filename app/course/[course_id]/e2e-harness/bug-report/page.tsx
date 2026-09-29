import { notFound } from "next/navigation";
import { Suspense } from "react";
import BugReportHarness from "./harness";

/**
 * E2E-only fixture page for the bug-report recorder tests (C2, C5, C6). `BUG_REPORT_E2E` is
 * inlined at build time from E2E_ENABLE (next.config.ts), so outside E2E builds this route
 * is always a 404.
 */
export default function Page() {
  if (process.env.BUG_REPORT_E2E !== "true") notFound();
  return (
    <Suspense>
      <BugReportHarness />
    </Suspense>
  );
}
