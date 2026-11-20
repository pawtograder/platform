import { notFound } from "next/navigation";
import BugReportUnmaskHarness from "./BugReportUnmaskHarness";

/**
 * Test harness for the bug reporter's taint trace (test I3). It renders the `name` query parameter
 * inside a `data-report-unmask` component so the trace can prove that a classified value reaching
 * unmasked text fails the check. It exists only when the server runs with `E2E_ENABLE=true`; every
 * other deployment answers 404.
 */
export const dynamic = "force-dynamic";

export default async function BugReportUnmaskHarnessPage({
  searchParams
}: {
  searchParams: Promise<{ name?: string }>;
}) {
  if (process.env.E2E_ENABLE !== "true") notFound();
  const { name } = await searchParams;
  return <BugReportUnmaskHarness name={name ?? ""} />;
}
