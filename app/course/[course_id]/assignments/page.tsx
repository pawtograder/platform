import { getEffectiveCourseIdentity } from "@/lib/ssrUtils";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import StudentAssignmentsList from "./studentAssignmentsList";

/**
 * The student assignments dashboard. Every row comes from
 * `get_assignments_for_student_dashboard`, which is keyed on a real `user_roles` row with
 * `role = 'student'` — so for a staff identity it returns nothing and the page renders two
 * confidently empty tables ("No upcoming deadlines available"). Staff reached it that way from
 * the Test Assignment preview (issue #892), and also by typing the URL.
 *
 * Send any non-student identity to the management list instead. `role` here is the *effective*
 * identity, so an instructor viewing as an enrolled student still gets this page — that is the
 * full student view, and it populates.
 */
export default async function AssignmentsPage({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;
  const user_id = (await headers()).get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }
  const identity = await getEffectiveCourseIdentity(Number.parseInt(course_id, 10), user_id);
  if (!identity) {
    redirect("/");
  }
  if (identity.role !== "student") {
    redirect(`/course/${course_id}/manage/assignments`);
  }
  return <StudentAssignmentsList />;
}
