import { AssignmentProvider } from "@/hooks/useAssignment";
import { createClientWithCaching, fetchAssignmentControllerData, getUserRolesForCourse } from "@/lib/ssrUtils";
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

  // Pre-fetch all assignment controller data on the server with caching
  const initialData = await fetchAssignmentControllerData(assignmentId);

  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }
  // Validate access: if not released and not grader or instructor, redirect to course page
  const role = await getUserRolesForCourse(Number(course_id), user_id);
  if (!role) {
    redirect("/");
  }
  if (role.role !== "instructor" && role.role !== "grader") {
    const client = await createClientWithCaching({ tags: ["assignment-release-date"] });
    const { data: assignment } = await client
      .from("assignments")
      .select("release_date, classes(time_zone)")
      .eq("id", assignmentId)
      .eq("class_id", Number(course_id))
      .single();
    if (!assignment) {
      redirect("/");
    }
    if (
      assignment.release_date &&
      isAfter(
        new TZDate(assignment.release_date, assignment.classes.time_zone),
        new TZDate(new Date(), assignment.classes.time_zone)
      )
    ) {
      redirect("/");
    }
  }

  return (
    <AssignmentProvider assignment_id={assignmentId} initialData={initialData}>
      {children}
    </AssignmentProvider>
  );
}
