import { userHasClassCapability } from "@/lib/ssrUtils";
import { redirect } from "next/navigation";

export const metadata = {
  title: "New Poll"
};

// Require run_polls before rendering this page (#1010).
// manage/layout.tsx has already turned away non-staff and view-as.
export default async function NewPollLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  if (!(await userHasClassCapability(Number.parseInt(course_id, 10), "run_polls"))) {
    redirect(`/course/${course_id}/manage/polls`);
  }
  return <>{children}</>;
}
