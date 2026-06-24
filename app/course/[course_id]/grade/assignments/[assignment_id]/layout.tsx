import { AssignmentProvider } from "@/hooks/useAssignment";
import { createClientWithCaching, getUserRolesForCourse } from "@/lib/ssrUtils";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function generateMetadata({ params }: { params: Promise<{ assignment_id: string }> }) {
  const { assignment_id } = await params;
  const client = await createClientWithCaching({ tags: ["assignment_metadata"] });
  const { data: assignment } = await client
    .from("assignments")
    .select("title")
    .eq("id", Number(assignment_id))
    .single();

  return {
    title: assignment?.title ? `Grade ${assignment.title}` : "Grade Submission"
  };
}

export default async function GradeAssignmentLayout({
  params,
  children
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
  children: React.ReactNode;
}) {
  const { course_id, assignment_id } = await params;
  const assignmentId = Number(assignment_id);
  const courseId = Number(course_id);

  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }

  const role = await getUserRolesForCourse(courseId, user_id);
  if (!role || (role.role !== "instructor" && role.role !== "grader")) {
    redirect(`/course/${courseId}`);
  }

  const client = await createClientWithCaching({ tags: ["assignment_metadata"] });
  const { data: assignment } = await client
    .from("assignments")
    .select("id")
    .eq("id", assignmentId)
    .eq("class_id", courseId)
    .single();

  if (!assignment) {
    redirect(`/course/${courseId}`);
  }

  return (
    <AssignmentProvider assignment_id={assignmentId} initialData={undefined}>
      {children}
    </AssignmentProvider>
  );
}
