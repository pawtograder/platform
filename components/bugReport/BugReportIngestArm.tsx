"use client";

import { usePathname } from "next/navigation";
import { armIngest, ingestTrace } from "@/lib/bugReport/ingestGate";
import { courseIdFromPathname, recordingLevelFor } from "@/lib/bugReport/routePolicy";

/**
 * Arms the taint ingest's pre-start fetch buffer (lib/bugReport/ingestGate.ts) when this course's
 * `bug-report-recording` flag is on and the route is listed in the route policy.
 *
 * The course layout (a server component) renders it with the flag it already read from the
 * class row, ahead of the controller providers. It arms during render, not in an effect: the
 * providers after it construct TableControllers, and start fetching, in their own render. With
 * the flag off it does nothing at all; nothing is cloned or classified.
 *
 * The flag here is the server's value at render time. The recorder mount still re-reads it on
 * every navigation and disarms the buffer when it finds the flag off (test A6).
 */
export function BugReportIngestArm({ courseId, recording }: { courseId: number; recording: boolean }) {
  const pathname = usePathname();
  ingestTrace(`render ${recording}`);
  if (recording && courseIdFromPathname(pathname) === courseId && recordingLevelFor(pathname) !== null) {
    armIngest();
  }
  return null;
}
