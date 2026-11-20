"use client";

import { Text } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import { getNotificationManager } from "@/lib/notifications/NotificationManager";
import { isCheckInPending } from "@/lib/helpRequestEscalation";

/** One request as far as the staff alert is concerned. */
export type EscalationWatchItem = { id: number; escalation_count: number };

type StaffEscalationInput = {
  /** Every request the viewer can see. Only the escalation counts are read. */
  requests: readonly EscalationWatchItem[];
  /** Whether the course has turned the alert on. */
  enabled: boolean;
};

/**
 * Tells staff when a ticket is escalated, while their tab is in the background.
 *
 * Escalation is the one queue event that asks a different staff member to step in, so it is the
 * one worth interrupting for: an escalated ticket sits at the top of every staff member's queue
 * and nothing else tells them it arrived.
 *
 * Nothing fires for a ticket the viewer is seeing for the first time, so a page that loads with
 * escalated tickets already in the queue stays quiet. Only a count that goes up while the page is
 * open is new.
 */
export function useStaffEscalationAlert({ requests, enabled }: StaffEscalationInput): void {
  // id -> the escalation_count this hook has already accounted for.
  const seen = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const counts = seen.current;
    let escalated = 0;
    for (const request of requests) {
      const before = counts.get(request.id);
      counts.set(request.id, request.escalation_count);
      // A request this render is the first to see says nothing about what changed; it is the
      // starting point. While the alert is off (the flag hasn't resolved yet) every request is
      // recorded the same way, so switching it on later doesn't fire for the backlog.
      if (before === undefined || !enabled) continue;
      if (request.escalation_count > before) escalated += 1;
    }
    // Requests that went away shouldn't hold a count: the same id can't come back, but the map
    // would otherwise grow for the life of the page.
    if (counts.size > requests.length) {
      const live = new Set(requests.map((r) => r.id));
      for (const id of counts.keys()) if (!live.has(id)) counts.delete(id);
    }
    if (!enabled || escalated === 0) return;

    getNotificationManager().notify({
      title: "Office hours",
      body: escalated === 1 ? "A ticket was escalated." : `${escalated} tickets were escalated.`,
      tag: "office-hours-escalation",
      persistent: true
    });
  }, [requests, enabled]);
}

type CheckInAlertInput = {
  /**
   * Who and what the alert is tracking, as one string. The page that uses this hook stays mounted
   * when the student opens a different request from the help drawer, so the remembered state has
   * to be thrown away when this changes.
   */
  subject: string;
  /** The student's request status, or undefined while it loads. */
  status: string | undefined;
  /** When the check-in window closes, or null when there is no check-in. */
  checkInExpiresAt: string | null | undefined;
  /** Whether the course has turned the alert on. */
  enabled: boolean;
};

/**
 * Tells a student that staff resolved their ticket and the check-in is waiting for them.
 *
 * The check-in window is short and closes on its own, so a student who has the tab in the
 * background can lose the chance to say the problem is not fixed. That is the state this alert
 * exists for. Like the turn alert, nothing fires on the first render.
 */
export function useCheckInAlert({ subject, status, checkInExpiresAt, enabled }: CheckInAlertInput): string | null {
  const previous = useRef<{ subject: string; pending: boolean } | null>(null);
  const [inPageMessage, setInPageMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!inPageMessage) return;
    const timer = setTimeout(() => setInPageMessage(null), 8000);
    return () => clearTimeout(timer);
  }, [inPageMessage]);

  useEffect(() => {
    // State remembered for a different request says nothing about this one, and this has to happen
    // before any early return. Opening a request whose data has not loaded yet used to leave the
    // last request's entry in the ref, so coming back to that request could alert for a check-in
    // that was already pending when the page opened.
    if (previous.current && previous.current.subject !== subject) previous.current = null;
    if (status === undefined) return;
    const pending = isCheckInPending({ status, check_in_expires_at: checkInExpiresAt ?? null });
    const before = previous.current;
    // Seed once while the alert is off, then hold, so a check-in that opened during that window
    // still fires when the flag resolves. With the alert on, every render moves it forward.
    if (enabled || before === null) previous.current = { subject, pending };
    if (!enabled || !before) return;
    if (before.pending || !pending) return;

    const message = "Your ticket was resolved. Did your problem get fixed?";
    if (document.hidden || !document.hasFocus()) {
      getNotificationManager().notify({
        title: "Office hours",
        body: message,
        tag: "office-hours-check-in",
        persistent: true
      });
    } else {
      setInPageMessage(message);
    }
  }, [enabled, subject, status, checkInExpiresAt]);

  // A message about the request the student just left doesn't belong on the one they opened.
  useEffect(() => setInPageMessage(null), [subject]);

  return inPageMessage;
}

/** Shows the check-in alert on the page itself, for a student who is already looking at it. */
export function CheckInAlertBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    // role="status": with the page focused, notify() returns early and shows nothing, so this
    // banner is the whole alert. Without a live region a screen reader never announces it.
    <Text
      role="status"
      fontSize="sm"
      fontWeight="semibold"
      color="fg"
      bg="bg.emphasized"
      px={3}
      py={2}
      borderRadius="md"
      mb={3}
    >
      {message}
    </Text>
  );
}
