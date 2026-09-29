"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { getActiveRecorder } from "@/lib/bugReport/activeRecorder";
import { installFetchHook } from "@/lib/bugReport/fetchHook";
import { armIngest, disarmIngest } from "@/lib/bugReport/ingestGate";
import { courseIdFromPathname, recordingLevelFor } from "@/lib/bugReport/routePolicy";
import { COURSE_FEATURES, courseFeatureEnabled } from "@/lib/courseFeatures";
import { createClient } from "@/utils/supabase/client";

// supabase-js captures `fetch` when a client is constructed, so the pass-through hook has to
// be in place before the first one is. `utils/supabase/client.ts` installs it before it builds
// the client; this call covers any other order. See lib/bugReport/fetchHook.ts.
installFetchHook();

/** The course whose flag the last lookup found off, so later navigations inside it don't re-arm. */
let flagOffCourse: number | null = null;

/**
 * Arm the taint ingest's pre-start fetch buffer when `pathname` could start a recorder: a listed
 * route in a course whose flag isn't already known to be off. The recorder chunk (and the ingest)
 * load only after the flag lookup; responses that arrive meanwhile wait in the buffer, unread,
 * and are dropped if the flag is off. See lib/bugReport/ingestGate.ts.
 */
function armForPath(pathname: string): void {
  if (getActiveRecorder()) return;
  const courseId = courseIdFromPathname(pathname);
  if (courseId === null || courseId === flagOffCourse || recordingLevelFor(pathname) === null) return;
  armIngest();
}

// Module evaluation runs before the app renders, so a full page load's first fetches are covered.
if (typeof window !== "undefined") armForPath(window.location.pathname);

async function recordingFlagEnabled(courseId: number): Promise<boolean> {
  const { data, error } = await createClient().from("classes").select("features").eq("id", courseId).maybeSingle();
  // A failed lookup counts as off: the recorder only runs on a confirmed flag.
  if (error || !data) return false;
  return courseFeatureEnabled(
    data.features as { name: string; enabled: boolean }[] | null,
    COURSE_FEATURES.BUG_REPORT_RECORDING
  );
}

/**
 * Starts, pauses, and stops the bug-report recorder as the route changes. Rendered once from
 * the root layout; renders nothing.
 *
 * The recorder chunk (rrweb) is imported only when the route is listed in the route policy
 * and the course flag is on. The flag is re-read on every navigation inside the course while
 * a recorder exists, so turning it off takes effect on the next navigation: the recorder stops
 * and its buffer is discarded. Moving to another course stops it as well.
 */
export default function BugReportRecorder() {
  const pathname = usePathname();
  const navigation = useRef(0);

  // In render, not in the effect: on a client navigation the new route renders (and starts
  // fetching) before this effect runs. Idempotent, and a no-op once a recorder exists.
  armForPath(pathname);

  useEffect(() => {
    const seq = ++navigation.current;
    const courseId = courseIdFromPathname(pathname);
    const level = recordingLevelFor(pathname);
    let recorder = getActiveRecorder();

    if (recorder && courseId !== null && recorder.getCourseId() !== courseId) {
      recorder.stop();
      recorder = undefined;
    }
    // Pause or resume right away; the flag check below can only stop it.
    recorder?.onNavigate(pathname);
    if (courseId === null || (!recorder && level === null)) {
      disarmIngest();
      return;
    }

    void (async () => {
      const enabled = await recordingFlagEnabled(courseId).catch(() => false);
      const active = getActiveRecorder();
      flagOffCourse = enabled ? null : courseId;
      if (!enabled) {
        disarmIngest();
        if (active && active.getCourseId() === courseId) active.stop();
        return;
      }
      // A later navigation owns the decision to start.
      if (seq !== navigation.current || active || level === null) return;
      const { startRecorder } = await import("@/lib/bugReport/recorder");
      if (seq !== navigation.current || getActiveRecorder()) return;
      const stillLevel = recordingLevelFor(window.location.pathname);
      if (stillLevel === null || courseIdFromPathname(window.location.pathname) !== courseId) {
        disarmIngest();
        return;
      }
      startRecorder({ courseId, level: stillLevel });
    })();
  }, [pathname]);

  return null;
}
