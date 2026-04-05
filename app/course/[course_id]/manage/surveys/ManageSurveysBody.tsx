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

  const list = surveys ?? [];
  if (list.length === 0) {
    return <EmptySurveysState courseId={course_id} />;
  }

  const { count: totalStudents } = await supabase
    .from("user_roles")
    .select("*", { count: "exact", head: true })
    .eq("class_id", classId)
    .eq("role", "student")
    .eq("disabled", false);

  const surveyIds = list.map((s) => s.id);

  const { data: responseRows, error: respErr } = await supabase
    .from("survey_responses")
    .select("survey_id")
    .in("survey_id", surveyIds)
    .eq("is_submitted", true)
    .is("deleted_at", null);

  if (respErr) {
    Sentry.captureException(respErr);
  }

  const responseCountBySurvey = new Map<string, number>();
  for (const row of responseRows ?? []) {
    const sid = row.survey_id;
    responseCountBySurvey.set(sid, (responseCountBySurvey.get(sid) ?? 0) + 1);
  }

  const targetedSurveyIds = list.filter((s) => !s.assigned_to_all).map((s) => s.id);
  const assignmentCountBySurvey = new Map<string, number>();
  if (targetedSurveyIds.length > 0) {
    const { data: assignRows, error: assignErr } = await supabase
      .from("survey_assignments")
      .select("survey_id")
      .in("survey_id", targetedSurveyIds);

    if (assignErr) {
      Sentry.captureException(assignErr);
    }
    for (const row of assignRows ?? []) {
      const sid = row.survey_id;
      assignmentCountBySurvey.set(sid, (assignmentCountBySurvey.get(sid) ?? 0) + 1);
    }
  }

  const totalStudentCount = totalStudents ?? 0;
  const surveysWithCounts = list.map((survey: Survey) => {
    const response_count = responseCountBySurvey.get(survey.id) ?? 0;
    const assigned_student_count = survey.assigned_to_all
      ? totalStudentCount
      : (assignmentCountBySurvey.get(survey.id) ?? 0);

    return {
      ...survey,
      response_count,
      assigned_student_count
    };
  });

  return <SurveysTable surveys={surveysWithCounts} courseId={course_id} />;
}
