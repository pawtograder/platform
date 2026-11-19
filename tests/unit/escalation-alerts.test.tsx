/**
 * @jest-environment jsdom
 *
 * The office hours escalation alerts: staff hear about a ticket that was escalated, a student
 * hears that their ticket was resolved and a check-in is waiting. Both are behind the course
 * flag, both only interrupt while the tab is in the background, and neither fires for state that
 * was already there when the page opened.
 */
import { renderHook } from "@testing-library/react";
import { useCheckInAlert, useStaffEscalationAlert } from "@/hooks/useEscalationAlert";
import { getNotificationManager } from "@/lib/notifications/NotificationManager";

type Notes = { title: string; body?: string }[];

const REQUEST_A = "student-1:101";
const REQUEST_B = "student-1:102";
/** Far enough ahead that the window is open; isCheckInPending compares against now. */
const OPEN_WINDOW = new Date(Date.now() + 5 * 60_000).toISOString();
const CLOSED_WINDOW = new Date(Date.now() - 60_000).toISOString();

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible")
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("office hours escalation alerts", () => {
  let notes: Notes;
  const originalNotification = globalThis.Notification;

  beforeEach(() => {
    notes = [];
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
    getNotificationManager().clearNotifications();
    (globalThis as unknown as { Notification: unknown }).Notification = originalNotification;
    setHidden(false);
    jest.restoreAllMocks();
    document.title = "";
  });

  describe("staff alert", () => {
    it("stays quiet for tickets that were already escalated when the page opened", () => {
      renderHook(() => useStaffEscalationAlert({ requests: [{ id: 1, escalation_count: 2 }], enabled: true }));
      expect(notes).toEqual([]);
    });

    it("alerts when a ticket's escalation count goes up", () => {
      const { rerender } = renderHook(
        (p: { requests: { id: number; escalation_count: number }[] }) =>
          useStaffEscalationAlert({ ...p, enabled: true }),
        { initialProps: { requests: [{ id: 1, escalation_count: 0 }] } }
      );
      rerender({ requests: [{ id: 1, escalation_count: 1 }] });
      expect(notes).toEqual([{ title: "Office hours", body: "A ticket was escalated." }]);
    });

    it("counts two escalations in one update as one alert", () => {
      const { rerender } = renderHook(
        (p: { requests: { id: number; escalation_count: number }[] }) =>
          useStaffEscalationAlert({ ...p, enabled: true }),
        {
          initialProps: {
            requests: [
              { id: 1, escalation_count: 0 },
              { id: 2, escalation_count: 0 }
            ]
          }
        }
      );
      rerender({
        requests: [
          { id: 1, escalation_count: 1 },
          { id: 2, escalation_count: 1 }
        ]
      });
      expect(notes).toEqual([{ title: "Office hours", body: "2 tickets were escalated." }]);
    });

    it("a ticket that arrives already escalated is not an escalation", () => {
      // It was escalated on some other staff member's screen before this page saw it at all.
      const { rerender } = renderHook(
        (p: { requests: { id: number; escalation_count: number }[] }) =>
          useStaffEscalationAlert({ ...p, enabled: true }),
        { initialProps: { requests: [{ id: 1, escalation_count: 0 }] } }
      );
      rerender({
        requests: [
          { id: 1, escalation_count: 0 },
          { id: 2, escalation_count: 3 }
        ]
      });
      expect(notes).toEqual([]);
    });

    it("does nothing when the course has the feature off", () => {
      const { rerender } = renderHook(
        (p: { requests: { id: number; escalation_count: number }[] }) =>
          useStaffEscalationAlert({ ...p, enabled: false }),
        { initialProps: { requests: [{ id: 1, escalation_count: 0 }] } }
      );
      rerender({ requests: [{ id: 1, escalation_count: 1 }] });
      expect(notes).toEqual([]);
    });

    it("does not fire for the backlog when the flag resolves late", () => {
      // enabled is false until the course features load. An escalation in that window is still
      // news, but tickets that were already escalated must not all alert at once.
      const { rerender } = renderHook(
        (p: { requests: { id: number; escalation_count: number }[]; enabled: boolean }) => useStaffEscalationAlert(p),
        { initialProps: { requests: [{ id: 1, escalation_count: 4 }], enabled: false } }
      );
      rerender({ requests: [{ id: 1, escalation_count: 4 }], enabled: true });
      expect(notes).toEqual([]);
    });
  });

  describe("student check-in alert", () => {
    it("does not alert on the first render of a ticket already waiting on a check-in", () => {
      renderHook(() =>
        useCheckInAlert({
          subject: REQUEST_A,
          status: "resolved",
          checkInExpiresAt: OPEN_WINDOW,
          enabled: true
        })
      );
      expect(notes).toEqual([]);
    });

    it("alerts when the check-in opens while the tab is hidden", () => {
      const { rerender } = renderHook(
        (p: { status: string; checkInExpiresAt: string | null }) =>
          useCheckInAlert({ ...p, subject: REQUEST_A, enabled: true }),
        { initialProps: { status: "in_progress", checkInExpiresAt: null as string | null } }
      );
      rerender({ status: "resolved", checkInExpiresAt: OPEN_WINDOW });
      expect(notes).toEqual([{ title: "Office hours", body: "Your ticket was resolved. Did your problem get fixed?" }]);
    });

    it("shows an in-page message, and no notification, while the page is visible and focused", () => {
      setHidden(false);
      const { result, rerender } = renderHook(
        (p: { status: string; checkInExpiresAt: string | null }) =>
          useCheckInAlert({ ...p, subject: REQUEST_A, enabled: true }),
        { initialProps: { status: "in_progress", checkInExpiresAt: null as string | null } }
      );
      rerender({ status: "resolved", checkInExpiresAt: OPEN_WINDOW });
      expect(notes).toEqual([]);
      expect(result.current).toBe("Your ticket was resolved. Did your problem get fixed?");
    });

    it("a ticket closed with no check-in does not alert", () => {
      // Staff "End ticket" resolves without a check-in window.
      const { rerender } = renderHook(
        (p: { status: string; checkInExpiresAt: string | null }) =>
          useCheckInAlert({ ...p, subject: REQUEST_A, enabled: true }),
        { initialProps: { status: "in_progress", checkInExpiresAt: null as string | null } }
      );
      rerender({ status: "closed", checkInExpiresAt: null });
      expect(notes).toEqual([]);
    });

    it("an expired check-in window does not alert", () => {
      const { rerender } = renderHook(
        (p: { status: string; checkInExpiresAt: string | null }) =>
          useCheckInAlert({ ...p, subject: REQUEST_A, enabled: true }),
        { initialProps: { status: "in_progress", checkInExpiresAt: null as string | null } }
      );
      rerender({ status: "resolved", checkInExpiresAt: CLOSED_WINDOW });
      expect(notes).toEqual([]);
    });

    it("does not treat a different request's state as this one's history", () => {
      // The help drawer moves between requests without remounting the page.
      const { rerender } = renderHook(
        (p: { subject: string; status: string; checkInExpiresAt: string | null }) =>
          useCheckInAlert({ ...p, enabled: true }),
        {
          initialProps: {
            subject: REQUEST_A,
            status: "in_progress",
            checkInExpiresAt: null as string | null
          }
        }
      );
      rerender({ subject: REQUEST_B, status: "resolved", checkInExpiresAt: OPEN_WINDOW });
      expect(notes).toEqual([]);
    });

    it("drops a request's history even when the next request's data has not loaded", () => {
      // Opening a request whose status is still undefined must not leave the previous request's
      // entry in place: coming back would then alert for a check-in already pending on arrival.
      const { rerender } = renderHook(
        (p: { subject: string; status: string | undefined; checkInExpiresAt: string | null }) =>
          useCheckInAlert({ ...p, enabled: true }),
        {
          initialProps: {
            subject: REQUEST_A,
            status: "in_progress" as string | undefined,
            checkInExpiresAt: null as string | null
          }
        }
      );
      // B is opened before its row arrives.
      rerender({ subject: REQUEST_B, status: undefined, checkInExpiresAt: null });
      // Back on A, already resolved and waiting on the check-in when the page opened.
      rerender({ subject: REQUEST_A, status: "resolved", checkInExpiresAt: OPEN_WINDOW });
      expect(notes).toEqual([]);
    });

    it("alerts for a check-in that opened while the feature flag was still loading", () => {
      const { rerender } = renderHook(
        (p: { status: string; checkInExpiresAt: string | null; enabled: boolean }) =>
          useCheckInAlert({ ...p, subject: REQUEST_A }),
        {
          initialProps: {
            status: "in_progress",
            checkInExpiresAt: null as string | null,
            enabled: false
          }
        }
      );
      rerender({ status: "resolved", checkInExpiresAt: OPEN_WINDOW, enabled: false });
      expect(notes).toEqual([]);
      rerender({ status: "resolved", checkInExpiresAt: OPEN_WINDOW, enabled: true });
      expect(notes).toEqual([{ title: "Office hours", body: "Your ticket was resolved. Did your problem get fixed?" }]);
    });
  });
});
