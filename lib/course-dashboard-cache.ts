import "server-only";

import { createClient } from "@/utils/supabase/server";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { unstable_cache } from "next/cache";

/** Short TTL: dashboard and manage lists should feel fresh without hammering DB on every navigation. */
const DASHBOARD_REVALIDATE_SECONDS = 20;

export type ManageAssignmentsOverviewRow = Database["public"]["Views"]["assignment_overview"]["Row"];

export async function getCachedManageAssignmentsOverview(
  classId: number,
  userId: string
): Promise<{ data: ManageAssignmentsOverviewRow[]; error: string | null }> {
  return unstable_cache(
    async () => {
      const client = await createClient();
      const { data, error } = await client
        .from("assignment_overview")
        .select("*")
        .eq("class_id", classId)
        .order("due_date", { ascending: false });
      return { data: data ?? [], error: error?.message ?? null };
    },
    ["course-manage-assignments-overview", String(classId), userId],
    {
      revalidate: DASHBOARD_REVALIDATE_SECONDS,
      tags: [`course:${classId}:assignments-overview`]
    }
  )();
}

export type InstructorDashboardCachedBundle = {
  metricsRaw: Database["public"]["Functions"]["get_instructor_dashboard_overview_metrics"]["Returns"] | null;
  metricsError: string | null;
  helpRequests: Database["public"]["Tables"]["help_requests"]["Row"][] | null;
  helpRequestsError: string | null;
  course: {
    time_zone: string | null;
    office_hours_ics_url: string | null;
    events_ics_url: string | null;
  } | null;
  courseError: string | null;
  surveysForDashboardRaw: Array<{
    id: string;
    survey_id: string;
    title: string | null;
    status: string;
    due_date: string | null;
    updated_at: string | null;
  }> | null;
  surveysDashboardError: string | null;
  identitiesJson: { identities: unknown[] } | null;
  workflowStatsHour: Database["public"]["Functions"]["get_workflow_statistics"]["Returns"] | null;
  workflowStatsHourError: string | null;
  workflowStatsDay: Database["public"]["Functions"]["get_workflow_statistics"]["Returns"] | null;
  workflowStatsDayError: string | null;
  recentErrors: unknown[] | null;
  recentErrorsError: string | null;
};

export async function getCachedInstructorDashboardBundle(
  courseId: number,
  userId: string
): Promise<InstructorDashboardCachedBundle> {
  return unstable_cache(
    async () => {
      const supabase = await createClient();

      const [
        { data: metricsRaw, error: metricsError },
        { data: helpRequests, error: helpRequestsError },
        { data: course, error: courseError },
        { data: surveysForDashboardRaw, error: surveysDashboardError },
        identities,
        { data: workflowStatsHour, error: workflowStatsHourError },
        { data: workflowStatsDay, error: workflowStatsDayError },
        { data: recentErrors, error: recentErrorsError }
      ] = await Promise.all([
        supabase.rpc("get_instructor_dashboard_overview_metrics", { p_class_id: courseId }),
        supabase
          .from("help_requests")
          .select("*")
          .eq("class_id", courseId)
          .eq("status", "open")
          .order("created_at", { ascending: true }),
        supabase.from("classes").select("time_zone, office_hours_ics_url, events_ics_url").eq("id", courseId).single(),
        supabase
          .from("surveys")
          .select("id, survey_id, title, status, due_date, updated_at")
          .eq("class_id", courseId)
          .is("deleted_at", null)
          .in("status", ["published", "closed"]),
        supabase.auth.getUserIdentities(),
        supabase.rpc("get_workflow_statistics", { p_class_id: courseId, p_duration_hours: 1 }),
        supabase.rpc("get_workflow_statistics", { p_class_id: courseId, p_duration_hours: 24 }),
        supabase
          .from("workflow_run_error")
          .select(
            `
      id,
      name,
      created_at,
      submissions!submission_id(
        profiles!profile_id(name, id),
        assignments!assignment_id(title),
        assignment_groups!assignment_group_id(name)
      )
    `
          )
          .eq("class_id", courseId)
          .order("created_at", { ascending: false })
          .limit(5)
      ]);

      return {
        metricsRaw: metricsRaw ?? null,
        metricsError: metricsError?.message ?? null,
        helpRequests: helpRequests ?? null,
        helpRequestsError: helpRequestsError?.message ?? null,
        course: course ?? null,
        courseError: courseError?.message ?? null,
        surveysForDashboardRaw: surveysForDashboardRaw ?? null,
        surveysDashboardError: surveysDashboardError?.message ?? null,
        identitiesJson: identities.data
          ? { identities: identities.data.identities as unknown[] }
          : identities.error
            ? null
            : { identities: [] },
        workflowStatsHour: workflowStatsHour ?? null,
        workflowStatsHourError: workflowStatsHourError?.message ?? null,
        workflowStatsDay: workflowStatsDay ?? null,
        workflowStatsDayError: workflowStatsDayError?.message ?? null,
        recentErrors: (recentErrors as unknown[]) ?? null,
        recentErrorsError: recentErrorsError?.message ?? null
      };
    },
    ["instructor-dashboard-bundle", String(courseId), userId],
    {
      revalidate: DASHBOARD_REVALIDATE_SECONDS,
      tags: [`course:${courseId}:instructor-dashboard`]
    }
  )();
}

export type StudentDashboardCachedBundle = {
  course: {
    time_zone: string | null;
    office_hours_ics_url: string | null;
    events_ics_url: string | null;
  } | null;
  assignments: unknown;
  assignmentsError: string | null;
  surveysRaw: unknown[] | null;
  surveysError: string | null;
  regradeRequests: unknown;
  regradeError: string | null;
  identitiesJson: { identities: unknown[] } | null;
  userRole: { class_section_id: number | null; lab_section_id: number | null } | null;
  userRoleError: string | null;
  responsesRaw: unknown[] | null;
  responsesError: string | null;
  classSection: Database["public"]["Tables"]["class_sections"]["Row"] | null;
  labSection: Database["public"]["Tables"]["lab_sections"]["Row"] | null;
  leadersRaw: Array<{ profiles: { name: string | null } | null }> | null;
};

export async function getCachedStudentDashboardBundle(
  courseId: number,
  userId: string,
  privateProfileId: string
): Promise<StudentDashboardCachedBundle> {
  return unstable_cache(
    async () => {
      const supabase = await createClient();

      const [
        { data: course },
        { data: assignments, error: assignmentsError },
        { data: surveysRaw, error: surveysError },
        { data: regradeRequests, error: regradeError },
        identities,
        { data: userRole, error: userRoleError }
      ] = await Promise.all([
        supabase.from("classes").select("time_zone, office_hours_ics_url, events_ics_url").eq("id", courseId).single(),
        supabase
          .from("assignments_with_effective_due_dates")
          .select(
            "*, submissions!submissio_assignment_id_fkey(*, grader_results!grader_results_submission_id_fkey(*)), classes(time_zone)"
          )
          .eq("class_id", courseId)
          .eq("submissions.is_active", true)
          .eq("student_profile_id", privateProfileId)
          .gte("due_date", new Date().toISOString())
          .order("due_date", { ascending: true })
          .limit(5),
        supabase
          .from("surveys")
          .select("*")
          .eq("class_id", courseId)
          .eq("status", "published")
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("submission_regrade_requests")
          .select(
            `
      *,
      assignments(id, title),
      submissions!inner(id, ordinal),
      submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_file_comments_rubric_check_id_fkey(name)),
      submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_artifact_comments_rubric_check_id_fkey(name)),
      submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_comments_rubric_check_id_fkey(name))
    `
          )
          .eq("class_id", courseId)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase.auth.getUserIdentities(),
        userId
          ? supabase
              .from("user_roles")
              .select("class_section_id, lab_section_id")
              .eq("class_id", courseId)
              .eq("user_id", userId)
              .eq("disabled", false)
              .single()
          : Promise.resolve({ data: null, error: null })
      ]);

      const surveysList = (surveysRaw ?? []) as { id: string }[];
      const [{ data: responsesRaw, error: responsesError }, { data: classSection }, { data: labSection }] =
        await Promise.all([
          surveysList.length > 0
            ? supabase
                .from("survey_responses")
                .select("*")
                .eq("profile_id", privateProfileId)
                .in(
                  "survey_id",
                  surveysList.map((s) => s.id)
                )
            : Promise.resolve({ data: null, error: null }),
          userRole?.class_section_id
            ? supabase.from("class_sections").select("*").eq("id", userRole.class_section_id).single()
            : Promise.resolve({ data: null, error: null }),
          userRole?.lab_section_id
            ? supabase.from("lab_sections").select("*").eq("id", userRole.lab_section_id).single()
            : Promise.resolve({ data: null, error: null })
        ]);

      const { data: leadersRaw } = labSection?.id
        ? await supabase.from("lab_section_leaders").select("profiles(name)").eq("lab_section_id", labSection.id)
        : { data: null };

      return {
        course: course ?? null,
        assignments: assignments ?? null,
        assignmentsError: assignmentsError?.message ?? null,
        surveysRaw: surveysRaw ?? null,
        surveysError: surveysError?.message ?? null,
        regradeRequests: regradeRequests ?? null,
        regradeError: regradeError?.message ?? null,
        identitiesJson: identities.data ? { identities: identities.data.identities as unknown[] } : null,
        userRole: userRole ?? null,
        userRoleError: userRoleError?.message ?? null,
        responsesRaw: responsesRaw ?? null,
        responsesError: responsesError?.message ?? null,
        classSection: classSection ?? null,
        labSection: labSection ?? null,
        leadersRaw: leadersRaw ?? null
      };
    },
    ["student-dashboard-bundle", String(courseId), userId, privateProfileId],
    {
      revalidate: DASHBOARD_REVALIDATE_SECONDS,
      tags: [`course:${courseId}:student-dashboard`]
    }
  )();
}
