/**
 * Types shared by the bug-report recorder and the packages built on it (redaction worker,
 * review dialog, envelope builder). Type-only: importing this module pulls in no rrweb code.
 */
import type { eventWithTime } from "@sentry-internal/rrweb";
import type { RecordingLevel } from "./routePolicy";
import type { TaintKind } from "./taint";

export type { RecordingLevel } from "./routePolicy";

/** One rrweb event as recorded (types 0-6; see `EventType` in @sentry-internal/rrweb). */
export type RecordedEvent = eventWithTime;

/** rrweb `EventType` values the bug reporter relies on, spelled out so callers need no rrweb import. */
export const RRWEB_EVENT_TYPE = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,
  Custom: 5,
  Plugin: 6
} as const;

/** The `tag` of the type-5 custom events the recorder adds. */
export const BREADCRUMB_TAG = "breadcrumb";

export type ConsoleBreadcrumb = {
  category: "console";
  /** Seconds since the epoch, like Sentry breadcrumbs. */
  timestamp: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  /** The arguments, stringified and truncated. May hold PII; the redaction walker handles it. */
  message: string;
};

export type ClickBreadcrumb = {
  category: "ui.click";
  timestamp: number;
  /** CSS-ish description of the target (tag, id, classes, data-testid). Never its text. */
  message: string;
  data: { nodeId?: number };
};

export type FetchBreadcrumb = {
  category: "fetch";
  timestamp: number;
  /** URL, method, status, duration. No bodies or headers, ever. */
  data: {
    method: string;
    url: string;
    /** 0 when the request failed without a response. */
    status_code: number;
    /** Milliseconds. */
    duration: number;
  };
};

export type BreadcrumbPayload = ConsoleBreadcrumb | ClickBreadcrumb | FetchBreadcrumb;

/** A recorded breadcrumb: a type-5 custom event `{ tag: "breadcrumb", payload }`. */
export type BreadcrumbEvent = {
  type: 5;
  timestamp: number;
  data: { tag: typeof BREADCRUMB_TAG; payload: BreadcrumbPayload };
};

/**
 * One checkout segment: starts with Meta (type 4) then FullSnapshot (type 2), followed by
 * everything up to the next checkout.
 */
export type FrozenSegment = {
  events: RecordedEvent[];
  /** Timestamp (ms) of the first and last event. */
  startTimestamp: number;
  endTimestamp: number;
  /** Characters of event JSON in this segment, the unit the 20 MB cap counts. */
  size: number;
  /** The level this segment was recorded at. A level change restarts rrweb, so it is uniform. */
  level: RecordingLevel;
};

/**
 * A deep copy of the ring buffer at the moment the user asked to report. The recorder keeps
 * running and never mutates it. `segments[0]` starts with Meta + FullSnapshot, and so does
 * every later segment.
 */
export type FrozenBuffer = {
  /** 32 lowercase hex, generated at recorder start and stable for the page load. */
  replayId: string;
  /** The level at freeze time. Segments recorded on other routes carry their own `level`. */
  level: RecordingLevel;
  segments: FrozenSegment[];
  /** Timestamp (ms) of the first kept event; 0 when the buffer is empty. */
  startTimestamp: number;
  /** Timestamp (ms) of the last kept event; 0 when the buffer is empty. */
  endTimestamp: number;
  /** Every URL the recording visited, in order, without duplicates. */
  urls: string[];
  /** Sentry event ids of errors captured while recording. */
  errorIds: string[];
  /** Trace ids of those errors. */
  traceIds: string[];
  /** Total characters of event JSON across `segments`. */
  size: number;
};

export type RecorderState = "recording" | "paused" | "stopped";

/**
 * The recorder's public API. `window.__bugReportRecorder` holds one while a recorder exists
 * for this page load (recording or paused), and is undefined otherwise.
 */
export interface BugReportRecorder {
  /** Deep copy of the buffer; recording continues. */
  freeze(): FrozenBuffer;
  getReplayId(): string;
  getErrorIds(): string[];
  getTraceIds(): string[];
  getUrls(): string[];
  getLevel(): RecordingLevel;
  getState(): RecorderState;
  /** The class the recording belongs to. */
  getCourseId(): number;
  /** Add values to this page load's taint set. */
  addTaint(kind: TaintKind, values: Iterable<string>): void;
  /**
   * Called by the mount on every client navigation. Pauses on unlisted routes (their events
   * never enter the buffer), resumes on listed ones, restarts rrweb when the level changes.
   */
  onNavigate(pathname: string): void;
  /** Stop recording and discard the buffer and taint set. Irreversible for this instance. */
  stop(): void;
}

export type RecorderStartOptions = {
  courseId: number;
  level: RecordingLevel;
  /** Test hooks; production callers leave them unset. */
  limits?: Partial<RingBufferLimits>;
};

export type RingBufferLimits = {
  /** Checkout interval (rrweb `checkoutEveryNms`). */
  checkoutEveryMs: number;
  /** Keep at least this much history, dropping whole segments older than it. */
  maxAgeMs: number;
  /** Cap on characters of event JSON. */
  maxSize: number;
};

export const DEFAULT_RING_BUFFER_LIMITS: RingBufferLimits = {
  checkoutEveryMs: 60_000,
  maxAgeMs: 10 * 60_000,
  maxSize: 20 * 1024 * 1024
};
