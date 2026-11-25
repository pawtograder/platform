import { userHasClassCapability } from "@/lib/ssrUtils";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Edit Survey"
};

// Require manage_surveys before rendering this page (#1010).
// manage/layout.tsx has already turned away non-staff and view-as.
export default async function EditSurveyLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  if (!(await userHasClassCapability(Number.parseInt(course_id, 10), "manage_surveys"))) {
    redirect(`/course/${course_id}/manage/surveys`);
  }
  return <>{children}</>;
}
