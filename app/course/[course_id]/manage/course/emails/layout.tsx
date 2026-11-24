import { userHasClassCapability } from "@/lib/ssrUtils";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Emails"
};

// Sending emails needs send_announcements (#1010); without it, back to the course home page.
// manage/layout.tsx has already turned away non-staff and view-as.
export default async function EmailsLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  if (!(await userHasClassCapability(Number.parseInt(course_id, 10), "send_announcements"))) {
    redirect(`/course/${course_id}`);
  }
  return <>{children}</>;
}
