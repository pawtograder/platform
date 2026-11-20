"use client";

import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useParams } from "next/navigation";
import { BugReportIdentity } from "./BugReportProvider";

/**
 * Publishes the reporter's real course role and the class ID on `/course/[course_id]/...`.
 * Uses `realRole`, not the view-as role: an instructor previewing as a student is still
 * the instructor filing the report. Off course routes (the `/course` picker) it publishes
 * nothing, since there is no single role there.
 */
export function CourseBugReportIdentity() {
  const { course_id } = useParams();
  const { realRole } = useClassProfiles();
  const { user } = useAuthState();
  const classId = typeof course_id === "string" ? Number(course_id) : NaN;
  if (!Number.isFinite(classId)) return null;
  return <BugReportIdentity role={realRole} classId={classId} userId={user?.id} />;
}
