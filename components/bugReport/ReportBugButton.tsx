"use client";

import { Button, type ButtonProps } from "@/components/ui/button";
import { GITHUB_BUG_REPORT_URL, useBugReportingAvailable } from "@/lib/bugReport/availability";
import Link from "next/link";
import { useBugReport } from "./BugReportProvider";

/**
 * A button that opens the "Report a bug" dialog, for server-rendered pages. It links to a new
 * GitHub issue instead when this deployment can't send reports.
 */
export function ReportBugButton({ eventId, children, ...rest }: ButtonProps & { eventId?: string }) {
  const { openReportDialog } = useBugReport();
  const available = useBugReportingAvailable();
  if (!available) {
    return (
      <Button asChild {...rest}>
        <Link href={GITHUB_BUG_REPORT_URL} target="_blank" rel="noopener noreferrer">
          {children ?? "Report a bug"}
        </Link>
      </Button>
    );
  }
  return (
    <Button onClick={() => openReportDialog({ eventId })} {...rest}>
      {children ?? "Report a bug"}
    </Button>
  );
}
