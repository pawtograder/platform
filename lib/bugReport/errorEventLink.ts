import * as Sentry from "@sentry/nextjs";

/**
 * Links error toasts to the Sentry event behind them, so "Report this" can prefill it.
 *
 * The app has no single error helper: call sites capture with `Sentry.captureException`
 * and then call `toaster.error` right after, in the same synchronous block. The client
 * emits `preprocessEvent` synchronously inside `captureException`, so we remember the ID of
 * the error event captured in the current task and forget it on the next one. A toast
 * raised in that same task picks it up. Anything captured in an earlier task (an unrelated
 * error minutes ago) is never linked by accident.
 *
 * A toast with no event in its task gets one on demand when the user submits the report its
 * "Report this" opened (see `ensureEventIdForReport`), so every report from a toast links to an
 * event. Not on the click itself: Cancel sends nothing.
 */
let sameTaskEventId: string | undefined;
let installedOn: object | undefined;

export function installErrorEventTracking(): void {
  const client = Sentry.getClient();
  if (!client || installedOn === client) return;
  installedOn = client;
  client.on("preprocessEvent", (event, hint) => {
    // Error events have no `type`; feedback, transactions, and replays do.
    if (event.type) return;
    const id = event.event_id ?? hint?.event_id;
    if (!id) return;
    sameTaskEventId = id;
    setTimeout(() => {
      if (sameTaskEventId === id) sameTaskEventId = undefined;
    }, 0);
  });
}

/** The error event captured earlier in the current task, if any. */
export function currentTaskErrorEventId(): string | undefined {
  return sameTaskEventId;
}

/**
 * Returns `eventId` if given; otherwise captures a small error-level event so the report has
 * something to link to. The event carries no toast text: titles and descriptions are
 * sometimes built from names or free text, and the user's own description goes in the
 * feedback anyway.
 */
export function ensureEventIdForReport(eventId: string | undefined): string | undefined {
  if (eventId) return eventId;
  if (!Sentry.getClient()?.getDsn()) return undefined;
  return Sentry.captureMessage("User reported an error notification", {
    level: "error",
    fingerprint: ["bug-report", "error-toast"],
    tags: { bug_report_source: "error_toast" }
  });
}

/** Test-only reset. */
export function resetErrorEventTrackingForTests(): void {
  sameTaskEventId = undefined;
  installedOn = undefined;
}
