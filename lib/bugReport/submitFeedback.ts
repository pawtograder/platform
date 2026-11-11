import * as Sentry from "@sentry/nextjs";
import type { Event } from "@sentry/nextjs";
import { redactReportUrl } from "./redaction/reportUrl";
import { getReportContext, type ReportContext } from "./reportContext";
import { stripQueryAndFragment } from "./sentryScrub";

/**
 * Uploads the reviewed, redacted replay. Package 6 implements this (segmented
 * replay_event + replay_recording envelopes through the client's transport). `submitReport`
 * only orchestrates: upload first, then feedback that points at the replay.
 */
export interface ReportReplayUpload {
  /** `tags` are the report's tags (`buildReportTags`), for the replay events. */
  upload(tags: Record<string, string>): Promise<ReplayUploadResult>;
  /**
   * The strings the user redacted in review (click-to-redact), for the feedback's page URL.
   * Read after `upload` settles: they are the ones of the pass it sent.
   */
  extraRedactions?(): readonly string[];
}

export type ReplayUploadResult =
  | {
      ok: true;
      replayId: string;
      segments?: number;
      /** Events left out because one event alone was over the segment size cap. */
      dropped?: { events: number; ms: number };
    }
  /** Sentry answered 429. The whole report stops and the user is told to try later. */
  | { ok: false; reason: "rate_limited"; replayId?: string }
  /** Retries ran out. Feedback still goes out, without a replay_id, tagged as such. */
  | { ok: false; reason: "failed"; replayId?: string };

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

  const tags = buildReportTags(input, client);
  const contextUserId = (input.context ?? getReportContext()).userId;

  let replayId: string | undefined;
  let replayState: "none" | "attached" | "failed" = "none";
  if (input.replay) {
    let result: ReplayUploadResult;
    try {
      result = await input.replay.upload({ ...tags });
    } catch {
      // The upload threw instead of answering: its chunk failed to load (a deploy since the page
      // loaded), or the browser has no CompressionStream. The report still goes out, without the
      // replay, as when the retries run out.
      result = { ok: false, reason: "failed" };
    }
    if (result.ok) {
      replayId = result.replayId;
      replayState = "attached";
      // Staff should see that the replay has a gap, not wonder what the user skipped.
      if (result.dropped) tags.replay_truncated = "true";
    } else if (result.reason === "rate_limited") {
      return { status: "rate_limited" };
    } else {
      replayState = "failed";
    }
  }

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
  // Everything the scope merges into the event (breadcrumbs, extra, request, other contexts,
  // scope tags and user fields) has not been through redaction. Strip it just before the
  // envelope is built; `beforeSendFeedback` fires before the scope is applied, so it can't.
  const stopScrubbing = client.on("beforeSendEvent", (event: Event) => {
    if (event.event_id === feedbackId) scrubFeedbackEvent(event, tags, contextUserId, replayId);
  });
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
        // Without the query and fragment, as on error events: they can hold a name (a search
        // for a student), and with recording off the taint set is empty, so masking alone
        // would leave it. The path is masked like the replay URLs.
        url:
          typeof window !== "undefined"
            ? stripQueryAndFragment(redactReportUrl(window.location.href, undefined, input.replay?.extraRedactions?.()))
            : undefined,
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
  stopScrubbing();

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

/** Contexts the feedback event keeps: its own, trace linking, and the SDK's device facts. */
const FEEDBACK_CONTEXTS = new Set(["feedback", "trace", "replay", "os", "browser", "device"]);

/**
 * Reduces a feedback event to what the report itself supplies: the feedback context (message,
 * redacted page URL, replay_id), the report's tags, the user's ID, and trace, replay and device
 * contexts. The redacted breadcrumbs travel in the replay instead. `fallbackUserId` (from the
 * report context) fills in the ID where nothing called `Sentry.setUser`, as on admin pages.
 * `replayId` is the replay this report attached, if any. Exported for unit tests.
 */
export function scrubFeedbackEvent(
  event: Event,
  tags: Record<string, string>,
  fallbackUserId?: string,
  replayId?: string
): void {
  delete event.breadcrumbs;
  delete event.extra;
  delete event.request;
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!FEEDBACK_CONTEXTS.has(key)) delete event.contexts[key];
    }
    if (!replayId) delete event.contexts.replay;
  }
  // The envelope's trace header is the dynamic sampling context, where the recorder's createDsc
  // hook puts the running recording's ID, and Sentry links an event to the replay named there.
  // Name the replay this report attached, or none: not one that failed to upload or was never
  // attached. The DSC can be shared with other events in the trace, so replace it, don't edit it.
  const metadata = event.sdkProcessingMetadata;
  const dsc = metadata?.dynamicSamplingContext as Record<string, unknown> | undefined;
  if (dsc && dsc.replay_id !== replayId) {
    const corrected = { ...dsc };
    if (replayId) corrected.replay_id = replayId;
    else delete corrected.replay_id;
    event.sdkProcessingMetadata = { ...metadata, dynamicSamplingContext: corrected };
  }
  event.tags = { ...tags };
  // As on the replay events: the ID only, and no inferred IP.
  const id = event.user?.id ?? fallbackUserId;
  event.user = { ...(id !== undefined ? { id: String(id) } : {}), ip_address: null };
}

function newEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function retryAfterMs(headers: SendResponse["headers"]): number {
  const raw = headers?.["retry-after"];
  const seconds = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_MS;
}
