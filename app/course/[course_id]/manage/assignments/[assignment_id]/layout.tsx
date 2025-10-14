import { AssignmentProvider } from "@/hooks/useAssignment";
import { createClientWithCaching, fetchAssignmentControllerData, getUserRolesForCourse } from "@/lib/ssrUtils";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ManageAssignmentNav } from "./ManageAssignmentNav";

export async function generateMetadata({ params }: { params: Promise<{ assignment_id: string }> }) {
  const { assignment_id } = await params;
  const client = await createClientWithCaching({ tags: ["assignment_metadata"] });
  const { data: assignment } = await client
    .from("assignments")
    .select("title")
    .eq("id", Number(assignment_id))
    .single();

  return {
    title: `${assignment?.title || "Assignment"} - Manage - Pawtograder`
  };
}

/**
 * Server layout for assignment management pages
 * Pre-fetches all assignment data and validates instructor/grader access
 */
export default async function ManageAssignmentLayout({
  params,
  children
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
  children: React.ReactNode;
}) {
  const { course_id, assignment_id } = await params;
  const assignmentId = Number(assignment_id);
  const courseId = Number(course_id);

  // Validate user is authenticated
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }

  // Validate user has grader or instructor role
  const role = await getUserRolesForCourse(courseId, user_id);
  if (!role || (role.role !== "instructor" && role.role !== "grader")) {
    redirect(`/course/${courseId}`);
  }

  // Pre-fetch all assignment controller data on the server with caching
  const initialData = await fetchAssignmentControllerData(
    assignmentId,
    role.role === "instructor" || role.role === "grader"
  );

  // Fetch assignment metadata for the title
  const client = await createClientWithCaching({ tags: ["assignment_metadata"] });
  const { data: assignment } = await client
    .from("assignments")
    .select("title")
    .eq("id", assignmentId)
    .eq("class_id", courseId)
    .single();

  if (!assignment) {
    redirect(`/course/${courseId}`);
  }

  return (
    <AssignmentProvider assignment_id={assignmentId} initialData={initialData}>
      <ManageAssignmentNav assignmentTitle={assignment.title}>{children}</ManageAssignmentNav>
    </AssignmentProvider>
  );
}
