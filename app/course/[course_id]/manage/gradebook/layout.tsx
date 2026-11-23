import { userHasClassCapability } from "@/lib/ssrUtils";
import { createClient } from "@/utils/supabase/server";
import type { GradebookRecordsForStudent } from "@/hooks/useGradebook";
import { redirect } from "next/navigation";
import GradebookLayoutClient from "./GradebookLayoutClient";

export default async function ManageGradebookLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}) {
  const { course_id } = await params;
  let initialGradebookRecords: GradebookRecordsForStudent[] | null = null;

  // Reject partially numeric segments (parseInt("123foo", 10) === 123).
  const hasValidCourseIdSegment = course_id != null && /^\d+$/.test(course_id);
  const classId = hasValidCourseIdSegment ? Number.parseInt(course_id, 10) : Number.NaN;

  // The staff gradebook needs manage_gradebook (#1010); without it, back to the course page,
  // before any scores are fetched. manage/layout.tsx has already turned away non-staff and view-as.
  if (!(await userHasClassCapability(classId, "manage_gradebook"))) {
    redirect(`/course/${course_id}`);
  }

  if (hasValidCourseIdSegment && !Number.isNaN(classId)) {
    try {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("get_gradebook_records_for_all_students", {
        p_class_id: classId
      });
      if (!error && data != null && Array.isArray(data)) {
        initialGradebookRecords = data as GradebookRecordsForStudent[];
      }
    } catch {
      initialGradebookRecords = null;
    }
  }

  return <GradebookLayoutClient initialGradebookRecords={initialGradebookRecords}>{children}</GradebookLayoutClient>;
}
