"use client";

import Link from "@/components/ui/link";
import { GITHUB_BUG_REPORT_URL, useBugReportingAvailable } from "@/lib/bugReport/availability";
import { Menu } from "@chakra-ui/react";
import { useBugReport } from "./BugReportProvider";

/** The "Report a bug" menu item: opens the report dialog, or links to GitHub when reports can't be sent. */
export function ReportBugMenuItem() {
  const { openReportDialog } = useBugReport();
  const available = useBugReportingAvailable();
  if (!available) {
    return (
      <Menu.Item value="report-bug">
        <Link href={GITHUB_BUG_REPORT_URL} target="_blank">
          Report a bug
        </Link>
      </Menu.Item>
    );
  }
  return (
    <Menu.Item value="report-bug" onClick={() => openReportDialog()}>
      Report a bug
    </Menu.Item>
  );
}
