import { userHasClassCapability } from "@/lib/ssrUtils";
import { redirect } from "next/navigation";

export const metadata = {
  title: "New Assignment"
};

// Creating an assignment needs manage_assignments (#1010); without it, back to the assignment list.
// manage/layout.tsx has already turned away non-staff and view-as.
export default async function NewAssignmentLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  if (!(await userHasClassCapability(Number.parseInt(course_id, 10), "manage_assignments"))) {
    redirect(`/course/${course_id}/manage/assignments`);
  }
  return <>{children}</>;
}
