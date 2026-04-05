import { createClient } from "@/utils/supabase/server";
import type { GradebookRecordsForStudent } from "@/hooks/useGradebook";
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
