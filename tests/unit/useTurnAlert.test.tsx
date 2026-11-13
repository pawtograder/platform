/**
 * @jest-environment jsdom
 *
 * The student turn alert: the tab title gets a marker and a browser notification is sent when a
 * TA picks up the request or the student becomes next in line, but only while the tab is hidden,
 * only when the course has the feature on, and never on the first render.
 */
import { renderHook } from "@testing-library/react";
import { useTurnAlert } from "@/hooks/useTurnAlert";
import { getNotificationManager } from "@/lib/notifications/NotificationManager";

type Notes = { title: string; body?: string }[];

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible")
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useTurnAlert", () => {
  let notes: Notes;
  const originalNotification = globalThis.Notification;

  beforeEach(() => {
    notes = [];
    // Start from a clean manager, so no flash timer or saved title from an earlier test leaks in.
    getNotificationManager().clearNotifications();
    document.title = "Office Hours";
    setHidden(true);
    jest.spyOn(document, "hasFocus").mockReturnValue(true);
    class FakeNotification {
      constructor(title: string, opts?: { body?: string }) {
        notes.push({ title, body: opts?.body });
      }
      static get permission() {
        return "granted";
      }
      static requestPermission() {
        return Promise.resolve("granted");
      }
    }
    (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
  });

  afterEach(() => {
    // The shared manager keeps a title-flash timer between alerts; stop it so it can't rewrite the title.
    getNotificationManager().clearNotifications();
    (globalThis as unknown as { Notification: unknown }).Notification = originalNotification;
    setHidden(false);
    jest.restoreAllMocks();
    document.title = "";
  });

  it("does not alert on the first render, even if the request is already picked up", () => {
    renderHook(() => useTurnAlert({ status: "in_progress", assignee: "ta-1", position: 0, enabled: true }));
    expect(notes).toEqual([]);
    expect(document.title).toBe("Office Hours");
  });

  it("alerts when a TA picks up the request while the tab is hidden", () => {
    const { rerender } = renderHook(
      (p: { status: string; assignee: string | null; position: number }) => useTurnAlert({ ...p, enabled: true }),
      { initialProps: { status: "open", assignee: null as string | null, position: 2 } }
    );
    rerender({ status: "in_progress", assignee: "ta-1", position: 0 });
    expect(notes).toEqual([{ title: "Office hours", body: "A TA picked up your request." }]);
    expect(document.title.startsWith("(!)")).toBe(true);
  });

  it("alerts when the student becomes next in line", () => {
    const { rerender } = renderHook(
      (p: { status: string; position: number }) => useTurnAlert({ ...p, assignee: null, enabled: true }),
      { initialProps: { status: "open", position: 2 } }
    );
    rerender({ status: "open", position: 1 });
    expect(notes).toEqual([{ title: "Office hours", body: "You're next in line." }]);
  });

  it("shows an in-page message, and no notification, while the page is visible and focused", () => {
    setHidden(false);
    // Earlier tests can leave a title marker behind; this test checks the in-page message, not the title.
    document.title = "Office Hours";
    const { result, rerender } = renderHook(
      (p: { status: string; assignee: string | null; position: number }) => useTurnAlert({ ...p, enabled: true }),
      { initialProps: { status: "open", assignee: null as string | null, position: 2 } }
    );
    rerender({ status: "in_progress", assignee: "ta-1", position: 0 });
    expect(notes).toEqual([]);
    expect(document.title).toBe("Office Hours");
    expect(result.current).toBe("A TA picked up your request.");
  });

  it("sends a notification when the page is visible but not focused", () => {
    setHidden(false);
    jest.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook(
      (p: { status: string; assignee: string | null; position: number }) => useTurnAlert({ ...p, enabled: true }),
      { initialProps: { status: "open", assignee: null as string | null, position: 2 } }
    );
    rerender({ status: "in_progress", assignee: "ta-1", position: 0 });
    expect(notes).toEqual([{ title: "Office hours", body: "A TA picked up your request." }]);
    expect(document.title.startsWith("(!)")).toBe(true);
  });

  it("does nothing when the course has the feature off", () => {
    const { rerender } = renderHook(
      (p: { status: string; assignee: string | null; position: number }) => useTurnAlert({ ...p, enabled: false }),
      { initialProps: { status: "open", assignee: null as string | null, position: 2 } }
    );
    rerender({ status: "in_progress", assignee: "ta-1", position: 0 });
    expect(notes).toEqual([]);
    expect(document.title).toBe("Office Hours");
  });

  it("restores the title when the student comes back to the tab", () => {
    const { rerender } = renderHook(
      (p: { status: string; assignee: string | null; position: number }) => useTurnAlert({ ...p, enabled: true }),
      { initialProps: { status: "open", assignee: null as string | null, position: 2 } }
    );
    rerender({ status: "in_progress", assignee: "ta-1", position: 0 });
    expect(document.title.startsWith("(!)")).toBe(true);
    setHidden(false);
    expect(document.title).toBe("Office Hours");
  });
});
