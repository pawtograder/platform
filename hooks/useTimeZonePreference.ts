import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Enumerates the supported user choices for how times should be displayed.
 * - "course": Always display times in the course's configured IANA time zone
 * - "browser": Display times translated into the user's current browser IANA time zone
 */
export type TimeZonePreference = "course" | "browser";

type UseTimeZonePreferenceReturn = {
  /**
   * The effective IANA time zone identifier to use for displaying times.
   * Will be either the course's time zone or the user's current browser time zone
   * depending on the saved preference (if any) or the default.
   */
  displayTimeZone: string;
  /** The saved preference, defaults to "course" when no cookie is set. */
  preference: TimeZonePreference;
  /** The course's configured IANA time zone (e.g., "America/New_York"). */
  courseTimeZone: string;
  /** The user's current browser IANA time zone. */
  browserTimeZone: string;
  /**
   * Whether a modal should be shown prompting the user to choose a preference.
   * True only when browser and course zones differ and no cookie preference exists yet.
   */
  shouldPrompt: boolean;
  /** Persist a new preference to a cookie and update the effective display zone. */
  setPreferenceChoice: (choice: TimeZonePreference) => void;
};

// Client-side cookie access is intentionally avoided; cookies are written server-side
// via a Route Handler for better security and consistency with Next.js best practices.

/**
 * Returns the browser's current IANA time zone (e.g., "America/Los_Angeles").
 */
function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Provides a cookie-backed user preference for displaying dates in either the course
 * time zone or the browser's current time zone, on a per-course basis.
 */
export function useTimeZonePreference(
  courseId: number,
  courseTimeZone: string,
  initialPreference?: TimeZonePreference
): UseTimeZonePreferenceReturn {
  const browserTimeZone = useMemo(() => getBrowserTimeZone(), []);

  // Default to "course" until we learn otherwise from the API.
  const [preference, setPreference] = useState<TimeZonePreference>(initialPreference ?? "course");

  // Tri-state internal flag: undefined while loading, then true/false accordingly.
  const [hasCookie, setHasCookie] = useState<boolean | undefined>(initialPreference ? true : undefined);

  // Initial load: query the server for an existing preference cookie
  useEffect(() => {
    let isActive = true;
    const controller = new AbortController();

    async function fetchPreference(): Promise<void> {
      try {
        const res = await fetch(`/api/timezone-preference?courseId=${courseId}`, {
          method: "GET",
          signal: controller.signal,
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });
        if (!res.ok) {
          if (isActive) {
            setHasCookie(false);
          }
          return;
        }
        const data = (await res.json()) as Partial<{ preference: TimeZonePreference }>;
        if (!isActive) return;
        if (data.preference === "course" || data.preference === "browser") {
          setPreference(data.preference);
          setHasCookie(true);
        } else {
          setHasCookie(false);
        }
      } catch {
        if (isActive) setHasCookie(false);
      }
    }

    fetchPreference();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [courseId]);

  const setPreferenceChoice = useCallback(
    async (choice: TimeZonePreference) => {
      try {
        // Optimistically update the UI
        setPreference(choice);
        setHasCookie(true);

        await fetch(`/api/timezone-preference`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ courseId, choice })
        });
      } catch {
        // If the server write fails, we still keep the local state consistent for UX.
        // A subsequent navigation/refresh will re-attempt the GET and reconcile.
      }
    },
    [courseId]
  );

  const displayTimeZone = useMemo(
    () => (preference === "browser" ? browserTimeZone : courseTimeZone),
    [preference, browserTimeZone, courseTimeZone]
  );

  const shouldPrompt = useMemo(() => {
    // Do not prompt until we know whether a cookie exists
    if (hasCookie === undefined) return false;
    if (hasCookie) return false;
    return courseTimeZone !== browserTimeZone;
  }, [hasCookie, courseTimeZone, browserTimeZone]);

  return {
    displayTimeZone,
    preference,
    courseTimeZone,
    browserTimeZone,
    shouldPrompt,
    setPreferenceChoice
  };
}
