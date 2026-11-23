import { userHasClassCapability } from "@/lib/ssrUtils";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export const metadata = {
  title: "Edit Rubric"
};

// Editing a rubric needs manage_rubrics (#1010); without it, back to the assignment page.
// manage/layout.tsx has already turned away non-staff and view-as.
export default async function RubricLayout({
  children,
  params
}: {
  children: ReactNode;
  params: Promise<{ course_id: string; assignment_id: string }>;
}) {
  const { course_id, assignment_id } = await params;
  if (!(await userHasClassCapability(Number.parseInt(course_id, 10), "manage_rubrics"))) {
    redirect(`/course/${course_id}/manage/assignments/${assignment_id}`);
  }
  return <>{children}</>;
}
