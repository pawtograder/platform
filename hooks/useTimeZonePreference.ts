import { useCallback, useEffect, useMemo, useState } from "react";

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

/**
 * Cookie key used per-course to remember the time zone preference.
 * Example: tz_pref_course_1234 = "browser" | "course"
 */
function getCookieKey(courseId: number): string {
  return `tz_pref_course_${courseId}`;
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const cookieStr = document.cookie;
  if (!cookieStr) return undefined;
  const parts = cookieStr.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return rest.join("=");
      }
    }
  }
  return undefined;
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  if (typeof document === "undefined") return;
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
}

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
export function useTimeZonePreference(courseId: number, courseTimeZone: string): UseTimeZonePreferenceReturn {
  const browserTimeZone = useMemo(() => getBrowserTimeZone(), []);
  const cookieKey = useMemo(() => getCookieKey(courseId), [courseId]);

  const [preference, setPreference] = useState<TimeZonePreference>(() => {
    const val = readCookie(cookieKey);
    return val === "browser" || val === "course" ? val : "course";
  });

  const [hasCookie, setHasCookie] = useState<boolean>(() => {
    const val = readCookie(cookieKey);
    return val === "browser" || val === "course";
  });

  useEffect(() => {
    // If cookie changes externally (unlikely), reflect it.
    const val = readCookie(cookieKey);
    if (val === "browser" || val === "course") {
      setPreference(val);
      setHasCookie(true);
    }
  }, [cookieKey]);

  const setPreferenceChoice = useCallback(
    (choice: TimeZonePreference) => {
      setPreference(choice);
      // 180 days
      writeCookie(cookieKey, choice, 60 * 60 * 24 * 180);
      setHasCookie(true);
    },
    [cookieKey]
  );

  const displayTimeZone = useMemo(
    () => (preference === "browser" ? browserTimeZone : courseTimeZone),
    [preference, browserTimeZone, courseTimeZone]
  );

  const shouldPrompt = useMemo(() => {
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
