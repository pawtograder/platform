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
  const classId = Number.parseInt(course_id, 10);
  let initialGradebookRecords: GradebookRecordsForStudent[] | null = null;

  if (!Number.isNaN(classId)) {
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
