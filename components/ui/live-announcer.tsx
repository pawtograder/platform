"use client";

import * as React from "react";

type AnnounceFn = (message: string, opts?: { priority?: "polite" | "assertive" }) => void;

const AnnouncerContext = React.createContext<AnnounceFn | null>(null);

/**
 * Imperative hook to push a string into a global polite live region.
 * Safe to call from event handlers and effects; messages are debounced
 * and cleared after 1s so back-to-back announcements don't stomp each
 * other. No-op outside the provider so callers can stay unconditional.
 */
export function useAnnouncer(): AnnounceFn {
  const ctx = React.useContext(AnnouncerContext);
  return ctx ?? (() => undefined);
}

/**
 * Single mounted `<div role="status" aria-live>` host. Mount once near the
 * root of the app (see `app/layout.tsx`).
 */
export function LiveAnnouncer({ children }: { children?: React.ReactNode }) {
  const [politeMessage, setPoliteMessage] = React.useState("");
  const [assertiveMessage, setAssertiveMessage] = React.useState("");
  const politeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const assertiveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = React.useCallback<AnnounceFn>((message, opts) => {
    if (!message) return;
    const priority = opts?.priority ?? "polite";
    if (priority === "assertive") {
      setAssertiveMessage("");
      requestAnimationFrame(() => setAssertiveMessage(message));
      if (assertiveTimer.current) clearTimeout(assertiveTimer.current);
      assertiveTimer.current = setTimeout(() => setAssertiveMessage(""), 1500);
    } else {
      setPoliteMessage("");
      requestAnimationFrame(() => setPoliteMessage(message));
      if (politeTimer.current) clearTimeout(politeTimer.current);
      politeTimer.current = setTimeout(() => setPoliteMessage(""), 1500);
    }
  }, []);

  React.useEffect(
    () => () => {
      if (politeTimer.current) clearTimeout(politeTimer.current);
      if (assertiveTimer.current) clearTimeout(assertiveTimer.current);
    },
    []
  );

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0
        }}
      >
        {politeMessage}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0
        }}
      >
        {assertiveMessage}
      </div>
    </AnnouncerContext.Provider>
  );
}
