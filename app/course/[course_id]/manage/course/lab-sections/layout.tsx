import { userHasClassCapability } from "@/lib/ssrUtils";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Lab Sections"
};

// Managing lab sections needs manage_roster (#1010); without it, back to the lab roster, which
// every staff member can read. manage/layout.tsx has already turned away non-staff and view-as.
export default async function LabSectionsLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  if (!(await userHasClassCapability(Number.parseInt(course_id, 10), "manage_roster"))) {
    redirect(`/course/${course_id}/manage/course/lab-roster`);
  }
  return <>{children}</>;
}
