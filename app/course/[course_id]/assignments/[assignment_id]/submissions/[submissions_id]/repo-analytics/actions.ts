"use server";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { getUserRolesForCourse } from "@/lib/ssrUtils";
import { headers } from "next/headers";

async function authorizeStaff(courseId: number) {
  const headersList = await headers();
  const userId = headersList.get("X-User-ID");
  if (!userId) throw new Error("Unauthorized");

  const role = await getUserRolesForCourse(courseId, userId);
  if (!role || (role.role !== "instructor" && role.role !== "grader")) {
    throw new Error("Unauthorized: must be instructor or grader");
  }
  return { userId, role };
}

export async function getRepositoryAnalyticsForSubmission(
  courseId: number,
  repositoryId: number,
  assignmentId: number
) {
  await authorizeStaff(courseId);
  const supabase = await createClient();

  const { data: items, error } = await supabase
    .from("repository_analytics_items")
    .select("*")
    .eq("repository_id", repositoryId)
    .order("created_date", { ascending: false });

  if (error) throw error;

  const { data: daily, error: dailyError } = await supabase
    .from("repository_analytics_daily")
    .select("*")
    .eq("repository_id", repositoryId)
    .order("date", { ascending: true });

  if (dailyError) throw dailyError;

  const { data: fetchStatus } = await supabase
    .from("repository_analytics_fetch_status")
    .select("*")
    .eq("assignment_id", assignmentId)
    .maybeSingle();

  return { items: items || [], daily: daily || [], fetchStatus: fetchStatus || null };
}

export async function requestAnalyticsRefreshForSubmission(courseId: number, assignmentId: number) {
  await authorizeStaff(courseId);
  const supabase = await createClient();

  const { data: status } = await supabase
    .from("repository_analytics_fetch_status")
    .select("*")
    .eq("assignment_id", assignmentId)
    .maybeSingle();

  if (status?.last_requested_at) {
    const lastRequested = new Date(status.last_requested_at).getTime();
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    if (lastRequested > tenMinutesAgo) {
      const nextAvailable = new Date(lastRequested + 10 * 60 * 1000);
      return {
        success: false,
        message: `Refresh can be requested again at ${nextAvailable.toLocaleTimeString()}`
      };
    }
  }

  const { data: classData, error: classError } = await supabase
    .from("classes")
    .select("github_org")
    .eq("id", courseId)
    .single();

  if (classError || !classData?.github_org) {
    return { success: false, message: "Could not find GitHub organization for this course" };
  }

  const adminSupabase = createAdminClient<Database>();
  const { error: enqueueError } = await adminSupabase.rpc("enqueue_repo_analytics_fetch", {
    p_class_id: courseId,
    p_assignment_id: assignmentId,
    p_org: classData.github_org
  });

  if (enqueueError) {
    return { success: false, message: `Failed to enqueue refresh: ${enqueueError.message}` };
  }

  return { success: true, message: "Analytics refresh has been queued" };
}

export async function getAnalyticsCsvDataForSubmission(courseId: number, repositoryId: number) {
  await authorizeStaff(courseId);
  const supabase = await createClient();

  const { data: items, error } = await supabase
    .from("repository_analytics_items")
    .select("*")
    .eq("repository_id", repositoryId)
    .order("created_date", { ascending: true });

  if (error) throw error;

  return { items: items || [] };
}
