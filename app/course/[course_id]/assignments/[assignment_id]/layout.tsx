import { AssignmentProvider } from "@/hooks/useAssignment";
import { createClientWithCaching, fetchAssignmentControllerData, getEffectiveCourseIdentity } from "@/lib/ssrUtils";
import { TZDate } from "@date-fns/tz";
import { isAfter } from "date-fns";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function AssignmentLayout({
  params,
  children
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
  children: React.ReactNode;
}) {
  const { course_id, assignment_id } = await params;
  const assignmentId = Number(assignment_id);

  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }
  // Validate access: an unreleased assignment is off limits to students. Honor view-as so an
  // instructor masquerading as a student gets the same release-date gate the student would.
  const role = await getEffectiveCourseIdentity(Number(course_id), user_id);
  if (!role) {
    redirect("/");
  }

  // Staff previewing their own test-assignment submissions are exempt: the release date gates
  // *enrolled students* out of an assignment, and staff own the assignment they are testing.
  // Applying it to them bounced the Manage → Test Assignment submission links to the dashboard
  // for any assignment not yet released (issue #883). The student-facing content filters
  // (grade release, rubric visibility, hidden autograder output) still apply.
  const isStaff = role.role === "instructor" || role.role === "grader";
  if (!isStaff && !role.isViewingAsSelf) {
    // Send staff masquerading as an enrolled student back to the course rather than the
    // all-courses dashboard, so the view-as banner (and its exit button) stays in reach.
    const blockedDestination = role.isViewingAs ? `/course/${course_id}` : "/";
    const client = await createClientWithCaching({ tags: ["assignment-release-date"] });
    const { data: assignment } = await client
      .from("assignments")
      .select("release_date, classes(time_zone)")
      .eq("id", assignmentId)
      .eq("class_id", Number(course_id))
      .single();
    if (!assignment) {
      redirect(blockedDestination);
    }
    if (
      assignment.release_date &&
      isAfter(
        new TZDate(assignment.release_date, assignment.classes.time_zone),
        new TZDate(new Date(), assignment.classes.time_zone)
      )
    ) {
      redirect(blockedDestination);
    }
  }

  // Keep instructor/grader assignment pages responsive for very large classes by
  // skipping heavyweight SSR prefetch. Students retain SSR prefetch for faster first paint.
  const initialData = isStaff ? undefined : await fetchAssignmentControllerData(assignmentId, false);
  return (
    <AssignmentProvider assignment_id={assignmentId} initialData={initialData}>
      {children}
    </AssignmentProvider>
  );
}
