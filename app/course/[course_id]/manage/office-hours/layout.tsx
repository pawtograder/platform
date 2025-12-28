import { getCourse } from "@/lib/ssrUtils";
import HelpManageLayoutClient from "./layout-client";

export async function generateMetadata({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;
  const course = await getCourse(Number(course_id));
  if (!course) {
    return {
      title: "Office Hours - Pawtograder"
    };
  }
  return {
    title: `${course.course_title || course.name} - Office Hours - Pawtograder`
  };
}

export default function HelpManageLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <HelpManageLayoutClient>{children}</HelpManageLayoutClient>;
}
