import { getEffectiveCourseIdentity } from "@/lib/ssrUtils";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Staff-only routes under `/manage/`. When an instructor is viewing the course as a
 * student, redirect back to the student-facing course home — manage pages assume the
 * real staff identity and must not render under the masqueraded student role.
 */
export default async function ManageLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }

  const identity = await getEffectiveCourseIdentity(Number.parseInt(course_id, 10), user_id);
  if (!identity) {
    redirect("/");
  }
  // Real students enroll with a non-null identity (isViewingAs === false), so the previous
  // gate let them render /manage/* relying on each child page to re-check auth. Block any
  // non-staff identity at the layout boundary as well, so manage pages always assume staff.
  const isStaff = identity.realRole === "instructor" || identity.realRole === "grader";
  if (!isStaff || identity.isViewingAs) {
    redirect(`/course/${course_id}`);
  }

  return children;
}
