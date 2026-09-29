"use client";

import { installErrorEventTracking } from "@/lib/bugReport/errorEventLink";
import { clearReportIdentity, setReportIdentity, setReportRoute, type ReportRole } from "@/lib/bugReport/reportContext";
import { registerReportDialogOpener, type OpenReportDialogOptions } from "@/lib/bugReport/reportDialog";
import { routePatternFor } from "@/lib/bugReport/routePattern";
import { useParams, usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ReportBugDialog, type ReportReplaySlot } from "./ReportBugDialog";
import { useReplayReview } from "./ReplayReview";

type BugReportContextValue = {
  openReportDialog: (options?: OpenReportDialogOptions) => void;
};

const BugReportContext = createContext<BugReportContextValue | null>(null);

/**
 * App-wide owner of the "Report a bug" dialog. Mounted once in the root layout; every entry
 * point (user menu, "Report this" on error toasts, the error page) opens the same dialog.
 * It also keeps the route pattern in the report context current.
 *
 * The recording half comes from `useReplayReview`: when the recorder is running on this route
 * at the moment the dialog opens, the dialog gets the review section and attaches the redacted
 * replay on Submit. Otherwise reports go without one. `replay` overrides it (tests, harnesses).
 */
export function BugReportProvider({ children, replay }: { children: ReactNode; replay?: ReportReplaySlot | null }) {
  const [open, setOpen] = useState(false);
  const [eventId, setEventId] = useState<string | undefined>(undefined);
  const pathname = usePathname();
  const params = useParams();

  useEffect(() => {
    setReportRoute(pathname ? routePatternFor(pathname, params) : undefined);
  }, [pathname, params]);

  useEffect(() => {
    installErrorEventTracking();
    // E2E builds only: the upload test hook (see lib/bugReport/upload/e2eHook.ts). The
    // condition is a build-time constant, so other builds drop the import and its chunk.
    // The catch matters: WebKit fails a chunk load that a navigation cancels, and an unhandled
    // ChunkLoadError makes StaleBundleRecovery reload the page, on top of that navigation.
    if (process.env.BUG_REPORT_E2E === "true") {
      import("@/lib/bugReport/upload/e2eHook").then((m) => m.installUploadTestHook()).catch(() => {});
    }
  }, []);

  const openReportDialog = useCallback((options: OpenReportDialogOptions = {}) => {
    setEventId(options.eventId);
    // Let whatever triggered us (a closing menu, a dismissing toast) finish restoring its
    // own focus before the dialog takes it.
    setTimeout(() => setOpen(true), 0);
  }, []);

  useEffect(() => registerReportDialogOpener(openReportDialog), [openReportDialog]);

  const value = useMemo(() => ({ openReportDialog }), [openReportDialog]);
  const review = useReplayReview(open && replay === undefined);

  return (
    <BugReportContext.Provider value={value}>
      {children}
      <ReportBugDialog
        open={open}
        onOpenChange={setOpen}
        eventId={eventId}
        replay={replay === undefined ? review : replay}
      />
    </BugReportContext.Provider>
  );
}

export function useBugReport(): BugReportContextValue {
  const ctx = useContext(BugReportContext);
  if (!ctx) {
    throw new Error("useBugReport must be used within a BugReportProvider");
  }
  return ctx;
}

/**
 * Publishes who is reporting (role, and class on course routes) for as long as it is
 * mounted. Render it inside the layout that knows the identity.
 */
export function BugReportIdentity({ role, classId }: { role?: ReportRole; classId?: number }) {
  useEffect(() => {
    setReportIdentity({ role, classId });
    return () => clearReportIdentity();
  }, [role, classId]);
  return null;
}
