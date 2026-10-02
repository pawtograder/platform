"use client";

import { useBugReport } from "@/components/bugReport/BugReportProvider";
import { GITHUB_BUG_REPORT_URL, useBugReportingAvailable } from "@/lib/bugReport/availability";
import { Button } from "@chakra-ui/react";
import Link from "next/link";

/**
 * "report any issues" in the Sync beta notice: opens the report dialog, or links to GitHub
 * when this deployment can't send reports.
 */
export function SyncReportIssuesLink() {
  const { openReportDialog } = useBugReport();
  const available = useBugReportingAvailable();
  if (!available) {
    return (
      <>
        report any issues{" "}
        <Link href={GITHUB_BUG_REPORT_URL} target="_blank">
          on GitHub
        </Link>
      </>
    );
  }
  return (
    <Button
      variant="plain"
      size="sm"
      h="auto"
      p={0}
      minW={0}
      verticalAlign="baseline"
      textDecoration="underline"
      color="fg.info"
      onClick={() => openReportDialog()}
    >
      report any issues
    </Button>
  );
}
