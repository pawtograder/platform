import type { Survey } from "@/types/survey";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/utils/supabase/server";
import EmptySurveysState from "./EmptySurveysState";
import SurveysTable from "./SurveysTable";

export async function ManageSurveysBody({ course_id }: { course_id: string }) {
  const supabase = await createClient();
  const classId = Number(course_id);

  const { data: surveys, error } = await supabase
    .from("surveys")
    .select("*")
    .eq("class_id", classId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    Sentry.captureException(error);
  }

  const { count: totalStudents } = await supabase
    .from("user_roles")
    .select("*", { count: "exact", head: true })
    .eq("class_id", classId)
    .eq("role", "student")
    .eq("disabled", false);

  const surveysWithCounts = await Promise.all(
    (surveys || []).map(async (survey: Survey) => {
      const { count: responseCount } = await supabase
        .from("survey_responses")
        .select("*", { count: "exact", head: true })
        .eq("survey_id", survey.id)
        .eq("is_submitted", true)
        .is("deleted_at", null);

      let assignedStudentCount = totalStudents || 0;

      if (!survey.assigned_to_all) {
        const { count: assignmentCount } = await supabase
          .from("survey_assignments")
          .select("*", { count: "exact", head: true })
          .eq("survey_id", survey.id);

        assignedStudentCount = assignmentCount || 0;
      }

      return {
        ...survey,
        response_count: responseCount || 0,
        submitted_count: responseCount || 0,
        assigned_student_count: assignedStudentCount
      };
    })
  );

  if (!surveys || surveys.length === 0) {
    return <EmptySurveysState courseId={course_id} />;
  }

  return <SurveysTable surveys={surveysWithCounts} courseId={course_id} />;
}
