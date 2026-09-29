/**
 * Unit tests for the bug report submit layer (package 5): tags, the no-replay guarantee,
 * 429 handling, and the replay orchestration package 6 plugs into.
 */
type Handler = (...args: unknown[]) => void;

class FakeClient {
  handlers = new Map<string, Set<Handler>>();
  dsn: object | undefined = { host: "sentry.test" };
  release: string | undefined = "abc1234";
  /** What the next afterSendEvent reports. `null` = never answer. */
  nextResponse: { statusCode?: number; headers?: Record<string, string> } | null = { statusCode: 200 };
  on(name: string, fn: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(fn);
    return () => this.handlers.get(name)!.delete(fn);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(...args);
  }
  getDsn() {
    return this.dsn;
  }
  getOptions() {
    return { release: this.release };
  }
}

const client = new FakeClient();
const sentEvents: Record<string, unknown>[] = [];
const hints: Record<string, unknown>[] = [];

jest.mock("@sentry/nextjs", () => ({
  getClient: () => client,
  // Mirrors @sentry/core captureFeedback: build the event, emit beforeSendFeedback
  // synchronously, then "send" it and emit afterSendEvent asynchronously.
  captureFeedback: (
    params: { message: string; tags?: Record<string, string>; associatedEventId?: string; url?: string },
    hint: { event_id: string }
  ) => {
    const event = {
      event_id: hint.event_id,
      type: "feedback",
      contexts: {
        feedback: { message: params.message, associated_event_id: params.associatedEventId, url: params.url }
      },
      tags: params.tags
    };
    hints.push(hint);
    client.emit("beforeSendFeedback", event, hint);
    sentEvents.push(event);
    const response = client.nextResponse;
    if (response) Promise.resolve().then(() => client.emit("afterSendEvent", event, response));
    return hint.event_id;
  }
}));

import {
  resetReportContextForTests,
  setReportIdentity,
  setReportRoute,
  clearReportIdentity,
  getLastKnownReportContext
} from "@/lib/bugReport/reportContext";
import { resetSubmitStateForTests, submitReport } from "@/lib/bugReport/submitFeedback";

beforeEach(() => {
  sentEvents.length = 0;
  hints.length = 0;
  client.handlers.clear();
  client.dsn = { host: "sentry.test" };
  client.release = "abc1234";
  client.nextResponse = { statusCode: 200 };
  resetReportContextForTests();
  resetSubmitStateForTests();
});

describe("submitReport without a replay", () => {
  it("sends feedback with route, class, role, release, contact_ok and nothing replay-related", async () => {
    setReportRoute("/course/[course_id]/assignments");
    setReportIdentity({ classId: 42, role: "student" });
    const result = await submitReport({ description: "  The page froze  ", contactOk: false });

    expect(result).toEqual({ status: "sent", feedbackId: expect.stringMatching(/^[0-9a-f]{32}$/), replay: "none" });
    expect(sentEvents).toHaveLength(1);
    const event = sentEvents[0] as { tags: Record<string, string>; contexts: { feedback: Record<string, unknown> } };
    expect(event.tags).toEqual({
      contact_ok: "false",
      class_id: "42",
      role: "student",
      route: "/course/[course_id]/assignments",
      release: "abc1234"
    });
    expect(event.contexts.feedback.message).toBe("The page froze");
    expect(event.contexts.feedback).not.toHaveProperty("replay_id");
    expect(hints[0]).toMatchObject({ includeReplay: false });
    // The feedback listener must not outlive the call.
    expect(client.handlers.get("beforeSendFeedback")?.size ?? 0).toBe(0);
    expect(client.handlers.get("afterSendEvent")?.size ?? 0).toBe(0);
  });

  it("omits class_id and keeps role on admin routes, and links the event ID", async () => {
    setReportRoute("/admin/classes");
    setReportIdentity({ role: "admin" });
    await submitReport({ description: "x", contactOk: true, eventId: "e".repeat(32) });
    const event = sentEvents[0] as { tags: Record<string, string>; contexts: { feedback: Record<string, unknown> } };
    expect(event.tags).not.toHaveProperty("class_id");
    expect(event.tags.role).toBe("admin");
    expect(event.tags.contact_ok).toBe("true");
    expect(event.tags.linked_event_id).toBe("e".repeat(32));
    expect(event.contexts.feedback.associated_event_id).toBe("e".repeat(32));
  });

  it("refuses an empty description without sending", async () => {
    const result = await submitReport({ description: "   ", contactOk: false });
    expect(result.status).toBe("error");
    expect(sentEvents).toHaveLength(0);
  });

  it("reports an error when Sentry has no DSN", async () => {
    client.dsn = undefined;
    const result = await submitReport({ description: "x", contactOk: false });
    expect(result.status).toBe("error");
    expect(sentEvents).toHaveLength(0);
  });

  it("maps a 429 to rate_limited and short-circuits the next attempt", async () => {
    client.nextResponse = { statusCode: 429, headers: { "retry-after": "120" } };
    expect(await submitReport({ description: "x", contactOk: false })).toEqual({ status: "rate_limited" });
    client.nextResponse = { statusCode: 200 };
    expect(await submitReport({ description: "x", contactOk: false })).toEqual({ status: "rate_limited" });
    expect(sentEvents).toHaveLength(1);
  });

  it("maps a 5xx to an error", async () => {
    client.nextResponse = { statusCode: 502 };
    const result = await submitReport({ description: "x", contactOk: false });
    expect(result.status).toBe("error");
  });
});

describe("submitReport with a replay (package 6 contract)", () => {
  it("uploads first, then sets contexts.feedback.replay_id", async () => {
    const order: string[] = [];
    const upload = jest.fn(async () => {
      order.push("upload");
      expect(sentEvents).toHaveLength(0);
      return { ok: true as const, replayId: "r".repeat(32) };
    });
    const result = await submitReport({ description: "x", contactOk: false, replay: { upload } });
    expect(result).toMatchObject({ status: "sent", replay: "attached" });
    expect(upload).toHaveBeenCalledTimes(1);
    const event = sentEvents[0] as { contexts: { feedback: Record<string, unknown> } };
    expect(event.contexts.feedback.replay_id).toBe("r".repeat(32));
  });

  it("hands the report tags to the upload and flags a replay with a gap", async () => {
    setReportRoute("/course/[course_id]/gradebook");
    setReportIdentity({ classId: 3, role: "grader" });
    const upload = jest.fn(async (tags: Record<string, string>) => {
      void tags;
      return { ok: true as const, replayId: "r".repeat(32), dropped: { events: 4, ms: 1200 } };
    });
    await submitReport({ description: "x", contactOk: true, replay: { upload } });
    expect(upload.mock.calls[0][0]).toMatchObject({
      class_id: "3",
      role: "grader",
      route: "/course/[course_id]/gradebook",
      release: "abc1234",
      contact_ok: "true"
    });
    const event = sentEvents[0] as { tags: Record<string, string> };
    expect(event.tags.replay_truncated).toBe("true");
    expect(upload.mock.calls[0][0]).not.toHaveProperty("replay_truncated");
  });

  it("stops without feedback when the replay upload is rate limited", async () => {
    const result = await submitReport({
      description: "x",
      contactOk: false,
      replay: { upload: async () => ({ ok: false as const, reason: "rate_limited" as const }) }
    });
    expect(result).toEqual({ status: "rate_limited" });
    expect(sentEvents).toHaveLength(0);
  });

  it("still sends feedback, without replay_id, when the upload fails for good", async () => {
    const result = await submitReport({
      description: "x",
      contactOk: false,
      replay: { upload: async () => ({ ok: false as const, reason: "failed" as const }) }
    });
    expect(result).toMatchObject({ status: "sent", replay: "failed" });
    const event = sentEvents[0] as { tags: Record<string, string>; contexts: { feedback: Record<string, unknown> } };
    expect(event.contexts.feedback).not.toHaveProperty("replay_id");
    expect(event.tags.replay_upload).toBe("failed");
  });
});

describe("report context", () => {
  it("keeps the last identity for global-error after the layouts unmount", () => {
    setReportIdentity({ classId: 7, role: "grader" });
    clearReportIdentity();
    expect(getLastKnownReportContext()).toMatchObject({ classId: 7, role: "grader" });
  });
});
