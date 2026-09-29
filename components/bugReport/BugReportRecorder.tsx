"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { getActiveRecorder } from "@/lib/bugReport/activeRecorder";
import { installFetchHook } from "@/lib/bugReport/fetchHook";
import { courseIdFromPathname, recordingLevelFor } from "@/lib/bugReport/routePolicy";
import { COURSE_FEATURES, courseFeatureEnabled } from "@/lib/courseFeatures";
import { createClient } from "@/utils/supabase/client";

// supabase-js captures `fetch` when a client is constructed, so the pass-through hook has to
// be in place before the first one is. Module load of this root-layout component is early
// enough; see lib/bugReport/fetchHook.ts.
installFetchHook();

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
    if (courseId === null) return;
    if (!recorder && level === null) return;

    void (async () => {
      const enabled = await recordingFlagEnabled(courseId).catch(() => false);
      const active = getActiveRecorder();
      if (!enabled) {
        if (active && active.getCourseId() === courseId) active.stop();
        return;
      }
      // A later navigation owns the decision to start.
      if (seq !== navigation.current || active || level === null) return;
      const { startRecorder } = await import("@/lib/bugReport/recorder");
      if (seq !== navigation.current || getActiveRecorder()) return;
      const stillLevel = recordingLevelFor(window.location.pathname);
      if (stillLevel === null || courseIdFromPathname(window.location.pathname) !== courseId) return;
      startRecorder({ courseId, level: stillLevel });
    })();
  }, [pathname]);

  return null;
}
