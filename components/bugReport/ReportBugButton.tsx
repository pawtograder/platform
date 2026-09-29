"use client";

import { Button, type ButtonProps } from "@/components/ui/button";
import { useBugReport } from "./BugReportProvider";

/** A button that opens the "Report a bug" dialog, for server-rendered pages. */
export function ReportBugButton({ eventId, children, ...rest }: ButtonProps & { eventId?: string }) {
  const { openReportDialog } = useBugReport();
  return (
    <Button onClick={() => openReportDialog({ eventId })} {...rest}>
      {children ?? "Report a bug"}
    </Button>
  );
}
