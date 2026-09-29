/**
 * Opens the "Report a bug" dialog from code that lives outside React, such as the toast
 * store in `components/ui/toaster.tsx`. `BugReportProvider` registers the opener when it
 * mounts; inside React, prefer `useBugReport().openReportDialog`.
 */
export type OpenReportDialogOptions = {
  /** Sentry event ID of the error being reported. Shown in the dialog and sent with the report. */
  eventId?: string;
};

type Opener = (options: OpenReportDialogOptions) => void;

let opener: Opener | null = null;

export function registerReportDialogOpener(fn: Opener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Returns false when no provider is mounted (the dialog could not open). */
export function openReportDialog(options: OpenReportDialogOptions = {}): boolean {
  if (!opener) return false;
  opener(options);
  return true;
}
