import * as Sentry from "@sentry/nextjs";
import type { Event } from "@sentry/nextjs";
import { redactReportUrl } from "./redaction/reportUrl";
import { getReportContext, type ReportContext } from "./reportContext";

/**
 * Uploads the reviewed, redacted replay. Package 6 implements this (segmented
 * replay_event + replay_recording envelopes through the client's transport). `submitReport`
 * only orchestrates: upload first, then feedback that points at the replay.
 */
export interface ReportReplayUpload {
  upload(): Promise<ReplayUploadResult>;
}

export type ReplayUploadResult =
  | { ok: true; replayId: string }
  /** Sentry answered 429. The whole report stops and the user is told to try later. */
  | { ok: false; reason: "rate_limited" }
  /** Retries ran out. Feedback still goes out, without a replay_id, tagged as such. */
  | { ok: false; reason: "failed" };

export type SubmitReportInput = {
  description: string;
  /** "You may contact me about this". Sent as tag `contact_ok`. */
  contactOk: boolean;
  /** Sentry event ID of the error being reported, when the report came from one. */
  eventId?: string;
  /** Present only when a recording is attached (flag on, route listed, user kept it). */
  replay?: ReportReplayUpload;
  /** Overrides the live report context. Only `app/global-error.tsx` needs this. */
  context?: ReportContext;
};

export type SubmitReportResult =
  | { status: "sent"; feedbackId: string; replay: "none" | "attached" | "failed" }
  | { status: "rate_limited" }
  | { status: "error"; message: string };

type Client = NonNullable<ReturnType<typeof Sentry.getClient>>;
/** The transport response the client hands to `afterSendEvent` (`TransportMakeRequestResponse`). */
type SendResponse = { statusCode?: number; headers?: Record<string, string | null | undefined> };

const SEND_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_MS = 60_000;

/**
 * After a 429 the SDK's transport drops everything locally until the limit expires and
 * reports the drop as a response without a status code. Remember the window ourselves so
 * the dialog can say "try again later" instead of a generic failure.
 */
let rateLimitedUntil = 0;

/** Test-only reset. */
export function resetSubmitStateForTests(): void {
  rateLimitedUntil = 0;
}

export function buildReportTags(input: Pick<SubmitReportInput, "contactOk" | "eventId" | "context">, client?: Client) {
  const ctx = input.context ?? getReportContext();
  const tags: Record<string, string> = {
    contact_ok: input.contactOk ? "true" : "false"
  };
  if (ctx.classId !== undefined) tags.class_id = String(ctx.classId);
  if (ctx.role) tags.role = ctx.role;
  if (ctx.route) tags.route = ctx.route;
  const release = client?.getOptions().release;
  if (release) tags.release = release;
  if (input.eventId) tags.linked_event_id = input.eventId;
  return tags;
}

/**
 * Files a bug report as a Sentry feedback item. This is the only place reports leave the
 * browser, and with no `replay` it never sends anything replay-related.
 *
 * Why `captureFeedback` and not `Sentry.sendFeedback`: `sendFeedback` needs no feedback
 * integration (it works with `integrations: []`), but it copies `params.tags` onto the
 * current scope with `setTags`, so `contact_ok`, `route`, and the rest would stick to every
 * error event sent afterwards. Its rejection is also an untyped string, so a 429 can't be
 * told apart from a network failure. `captureFeedback` is what `sendFeedback` calls
 * underneath; we pass the tags on the event only and read the transport response from the
 * client's `afterSendEvent` hook. The `includeReplay: false` hint is kept so that, if a
 * replay integration were ever present, it would still not attach one (test B4/B5 guard
 * against the integration itself).
 */
export async function submitReport(input: SubmitReportInput): Promise<SubmitReportResult> {
  const message = input.description.trim();
  if (!message) {
    return { status: "error", message: "Describe the problem before sending." };
  }

  const client = Sentry.getClient();
  if (!client || !client.getDsn()) {
    return { status: "error", message: "Bug reporting is not configured on this deployment." };
  }

  if (Date.now() < rateLimitedUntil) {
    return { status: "rate_limited" };
  }

  let replayId: string | undefined;
  let replayState: "none" | "attached" | "failed" = "none";
  if (input.replay) {
    const result = await input.replay.upload();
    if (result.ok) {
      replayId = result.replayId;
      replayState = "attached";
    } else if (result.reason === "rate_limited") {
      return { status: "rate_limited" };
    } else {
      replayState = "failed";
    }
  }

  const tags = buildReportTags(input, client);
  if (replayState === "failed") tags.replay_upload = "failed";

  // contexts.feedback.replay_id is how Sentry links the feedback to the replay. Set it in a
  // one-shot beforeSendFeedback hook (captureFeedback emits it synchronously), and only when
  // a replay upload actually succeeded.
  const unhook = replayId
    ? client.on("beforeSendFeedback", (event: Event) => {
        if (event.contexts?.feedback) {
          event.contexts.feedback.replay_id = replayId;
        }
      })
    : undefined;

  // Pick the event ID ourselves (scope.captureEvent honors hint.event_id) so the listener
  // below is registered for the right event before anything is sent.
  const feedbackId = newEventId();
  let stopListening: () => void = () => {};
  const sent = new Promise<SendResponse | undefined>((resolve) => {
    stopListening = client.on("afterSendEvent", (event: Event, response: SendResponse | undefined) => {
      if (event.event_id === feedbackId) {
        resolve(response);
      }
    });
  });
  try {
    Sentry.captureFeedback(
      {
        message,
        // The page URL can carry a name or email in its query; mask it like the replay URLs.
        url: typeof window !== "undefined" ? redactReportUrl(window.location.href) : undefined,
        source: "bug-report-dialog",
        associatedEventId: input.eventId,
        tags
      },
      { event_id: feedbackId, includeReplay: false }
    );
  } finally {
    unhook?.();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    sent,
    new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS)))
  ]);
  clearTimeout(timer);
  stopListening();

  if (response === "timeout") {
    return { status: "error", message: "The report did not go through. Check your connection and try again." };
  }
  const statusCode = response?.statusCode;
  if (statusCode === 429) {
    rateLimitedUntil = Date.now() + retryAfterMs(response?.headers);
    return { status: "rate_limited" };
  }
  if (statusCode === undefined && Date.now() < rateLimitedUntil) {
    return { status: "rate_limited" };
  }
  if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
    return { status: "sent", feedbackId, replay: replayState };
  }
  return { status: "error", message: "The report did not go through. Check your connection and try again." };
}

function newEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function retryAfterMs(headers: SendResponse["headers"]): number {
  const raw = headers?.["retry-after"];
  const seconds = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_MS;
}
