"use client";

import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import AssignmentGradingToolbar from "@/components/ui/assignment-grading-toolbar";
import { SurveyStatusBanner } from "@/components/ui/survey-status-banner";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Assignment } from "@/utils/supabase/DatabaseTypes";

/**
 * The parts of the submission header that differ between the staff and student views.
 *
 * A client component rather than a branch in the server layout because the Test Assignment
 * self-preview is client state: staff toggling it must see the student's chrome (their due date and
 * survey status) in place of the grading toolbar, and a server-rendered branch cannot respond to it.
 * `role` here is the *effective* identity, so this covers viewing an enrolled student too.
 *
 * Two slots because these pieces sit either side of the heading row they belong to.
 */
export function SubmissionHeaderChrome({
  assignment,
  courseId,
  assignmentId,
  slot
}: {
  assignment: Assignment;
  courseId: number;
  assignmentId: number;
  slot: "due-date" | "below-header";
}) {
  const { role } = useClassProfiles();
  // Kept as two separate conditions, matching the server branches this replaced: the due date shows
  // for any non-staff viewer, while the survey banner is specifically for students.
  const isStaff = role.role === "instructor" || role.role === "grader";
  const isStudent = role.role === "student";

  if (slot === "due-date") {
    if (isStaff) return null;
    return <AssignmentDueDate assignment={assignment} showLateTokenButton={true} showTimeZone={true} showDue={true} />;
  }

  return (
    <>
      {isStaff && <AssignmentGradingToolbar />}
      {isStudent && <SurveyStatusBanner assignmentId={assignmentId} courseId={courseId} />}
    </>
  );
}
