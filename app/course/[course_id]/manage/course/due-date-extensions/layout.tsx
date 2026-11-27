import { userHasClassCapability } from "@/lib/ssrUtils";
import { redirect } from "next/navigation";
import DueDateExtensionsLayoutClient from "./layout-client";

export const metadata = {
  title: "Due Date Extensions"
};

// Granting extensions needs grant_extensions (#1010); without it, back to the course page.
// manage/layout.tsx has already turned away non-staff and view-as.
export default async function DueDateExtensionsLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  if (!(await userHasClassCapability(Number.parseInt(course_id, 10), "grant_extensions"))) {
    redirect(`/course/${course_id}`);
  }
  return <DueDateExtensionsLayoutClient>{children}</DueDateExtensionsLayoutClient>;
}
