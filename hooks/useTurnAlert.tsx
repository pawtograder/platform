"use client";

import { Button, Text } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import { getNotificationManager } from "@/lib/notifications/NotificationManager";

type TurnAlertInput = {
  /** The student's request status, or undefined while it loads. */
  status: string | undefined;
  /** The TA working on the request, if any. */
  assignee: string | null | undefined;
  /** 1-based place in the queue, or 0 when the request isn't waiting. */
  position: number;
  /** Whether the course has turned the alert on. */
  enabled: boolean;
};

/**
 * Tells a student when their turn comes up, while their tab is in the background:
 * the title gets a marker, and a browser notification shows if the student allowed them.
 *
 * Nothing fires on the first render, so a page that loads with the request already picked up
 * or already next does not alert.
 */
export function useTurnAlert({ status, assignee, position, enabled }: TurnAlertInput): string | null {
  const previous = useRef<{ status?: string; assignee?: string | null; position: number } | null>(null);
  const originalTitle = useRef<string | null>(null);
  const [inPageMessage, setInPageMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const restoreTitle = () => {
      if (originalTitle.current !== null && !document.hidden && document.hasFocus()) {
        document.title = originalTitle.current;
        originalTitle.current = null;
      }
    };
    document.addEventListener("visibilitychange", restoreTitle);
    window.addEventListener("focus", restoreTitle);
    return () => {
      document.removeEventListener("visibilitychange", restoreTitle);
      window.removeEventListener("focus", restoreTitle);
    };
  }, [enabled]);

  useEffect(() => {
    if (!inPageMessage) return;
    const timer = setTimeout(() => setInPageMessage(null), 8000);
    return () => clearTimeout(timer);
  }, [inPageMessage]);

  useEffect(() => {
    if (!enabled || status === undefined) return;
    const before = previous.current;
    previous.current = { status, assignee, position };
    if (!before) return;

    const pickedUp = before.status === "open" && status === "in_progress" && Boolean(assignee);
    const nextInLine = status === "open" && position === 1 && before.position > 1;
    if (!pickedUp && !nextInLine) return;

    const message = pickedUp ? "A TA picked up your request." : "You're next in line.";
    const away = document.hidden || !document.hasFocus();
    if (away) {
      if (originalTitle.current === null) originalTitle.current = document.title;
      // Notify before adding the marker, so the shared manager saves the clean title and restores it.
      // Goes through the shared notification manager, so it gets the same sound, title flash, favicon badge,
      // and preferences as the other office hours alerts.
      getNotificationManager().notify({
        title: "Office hours",
        body: message,
        tag: "office-hours-turn",
        persistent: true
      });
      document.title = `(!) ${originalTitle.current}`;
    } else {
      setInPageMessage(message);
    }
  }, [enabled, status, assignee, position]);

  return inPageMessage;
}

/** Shows the turn alert on the page itself, for a student who is already looking at it. */
export function TurnAlertBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Text fontSize="sm" fontWeight="semibold" color="fg" bg="bg.emphasized" px={3} py={2} borderRadius="md" mb={3}>
      {message}
    </Text>
  );
}

/** Offers the student the browser notification permission the turn alert uses. */
export function TurnAlertPrompt({ enabled }: { enabled: boolean }) {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported" | null>(null);

  useEffect(() => {
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);

  if (!enabled || permission === null || permission === "unsupported" || permission === "granted") return null;

  if (permission === "denied") {
    return (
      <Text fontSize="sm" color="fg.muted" mb={3}>
        Browser alerts are blocked for this site. Turn them on in your browser&apos;s site settings to get a
        notification when your turn comes up.
      </Text>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      mb={3}
      onClick={async () => setPermission(await Notification.requestPermission())}
    >
      Turn on browser alerts for my turn
    </Button>
  );
}
