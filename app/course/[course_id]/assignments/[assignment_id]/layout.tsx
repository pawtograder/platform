import { AssignmentProvider } from "@/hooks/useAssignment";
import { AssignmentDataBridge } from "@/hooks/assignment-data";
import { createClientWithCaching, getUserRolesForCourse, prefetchAssignmentData } from "@/lib/ssrUtils";
import { HydrationBoundary } from "@tanstack/react-query";
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

  const isStaff = role.role === "instructor" || role.role === "grader";

  // Pre-fetch all assignment data and dehydrate for TanStack Query HydrationBoundary
  const dehydratedState = await prefetchAssignmentData(Number(course_id), assignmentId, isStaff);

  return (
    <HydrationBoundary state={dehydratedState}>
      <AssignmentProvider assignment_id={assignmentId}>
        <AssignmentDataBridge assignmentId={assignmentId}>{children}</AssignmentDataBridge>
      </AssignmentProvider>
    </HydrationBoundary>
  );
}
