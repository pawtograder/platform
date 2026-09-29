"use client";

import { usePathname } from "next/navigation";
import { armIngest, ingestTrace } from "@/lib/bugReport/ingestGate";
import { courseIdFromPathname, recordingLevelFor } from "@/lib/bugReport/routePolicy";

/** Set by the course layout, in its server HTML, only when the course's bug report flag is on. */
export const RECORDING_MARKER_ATTRIBUTE = "data-bug-report-recording";

function armIfListed(courseId: number, pathname: string): void {
  if (courseIdFromPathname(pathname) === courseId && recordingLevelFor(pathname) !== null) armIngest();
}

/**
 * Arms the pre-start buffer from the course layout's server-rendered marker, if it is already
 * in the document. The recorder mount calls it at module load and before its own flag lookup:
 * the root layout hydrates, and starts fetching, before the course layout segment does, so the
 * component below would be too late for those requests. With the flag off the marker is absent
 * and this does nothing.
 */
export function armFromRecordingMarker(): void {
  if (typeof document === "undefined") return;
  const marker = document.querySelector(`[${RECORDING_MARKER_ATTRIBUTE}]`);
  const courseId = Number(marker?.getAttribute(RECORDING_MARKER_ATTRIBUTE));
  if (!marker || !Number.isFinite(courseId)) return;
  ingestTrace("marker");
  armIfListed(courseId, window.location.pathname);
}

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
  if (recording) armIfListed(courseId, pathname);
  return null;
}
