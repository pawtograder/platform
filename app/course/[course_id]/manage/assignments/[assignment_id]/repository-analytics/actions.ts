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

export async function getRepositoryAnalytics(courseId: number, assignmentId: number) {
  await authorizeStaff(courseId);

  const supabase = await createClient();

  const { data: dailyStats, error: dailyError } = await supabase
    .from("repository_analytics_daily")
    .select(
      `
      *,
      repositories!inner(id, repository, profile_id, assignment_group_id,
        profiles(id, name),
        assignment_groups(id, name)
      )
    `
    )
    .eq("assignment_id", assignmentId)
    .order("date", { ascending: true });

  if (dailyError) throw dailyError;

  const { data: fetchStatus, error: fetchError } = await supabase
    .from("repository_analytics_fetch_status")
    .select("*")
    .eq("assignment_id", assignmentId)
    .maybeSingle();

  if (fetchError) throw fetchError;

  // Aggregate per-repository totals
  const repoMap = new Map<
    number,
    {
      repository_id: number;
      repository_name: string;
      owner_name: string | null;
      group_name: string | null;
      issues_opened: number;
      issues_closed: number;
      issue_comments: number;
      prs_opened: number;
      pr_review_comments: number;
      commits: number;
      daily: typeof dailyStats;
    }
  >();

  for (const row of dailyStats || []) {
    const repoData = row.repositories as unknown as {
      id: number;
      repository: string;
      profile_id: string | null;
      assignment_group_id: number | null;
      profiles: { id: string; name: string } | null;
      assignment_groups: { id: number; name: string } | null;
    };

    if (!repoMap.has(row.repository_id)) {
      repoMap.set(row.repository_id, {
        repository_id: row.repository_id,
        repository_name: repoData.repository,
        owner_name: repoData.profiles?.name || null,
        group_name: repoData.assignment_groups?.name || null,
        issues_opened: 0,
        issues_closed: 0,
        issue_comments: 0,
        prs_opened: 0,
        pr_review_comments: 0,
        commits: 0,
        daily: []
      });
    }
    const entry = repoMap.get(row.repository_id)!;
    entry.issues_opened += row.issues_opened;
    entry.issues_closed += row.issues_closed;
    entry.issue_comments += row.issue_comments;
    entry.prs_opened += row.prs_opened;
    entry.pr_review_comments += row.pr_review_comments;
    entry.commits += row.commits;
    entry.daily = [...(entry.daily || []), row];
  }

  return {
    repositories: Array.from(repoMap.values()),
    fetchStatus: fetchStatus || null
  };
}

export async function getRepositoryAnalyticsDetail(courseId: number, repositoryId: number) {
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

  return { items: items || [], daily: daily || [] };
}

export async function requestAnalyticsRefresh(courseId: number, assignmentId: number) {
  await authorizeStaff(courseId);

  const supabase = await createClient();

  // Check the fetch status for rate limiting (10 minutes)
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

  // Get the class's GitHub org
  const { data: classData, error: classError } = await supabase
    .from("classes")
    .select("github_org")
    .eq("id", courseId)
    .single();

  if (classError || !classData?.github_org) {
    return { success: false, message: "Could not find GitHub organization for this course" };
  }

  // Use admin client for enqueue (RPC uses security definer so anon key works too,
  // but let's use service role for reliability)
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

export async function getAnalyticsCsvData(courseId: number, assignmentId: number) {
  await authorizeStaff(courseId);

  const supabase = await createClient();

  const { data: dailyStats, error: dailyError } = await supabase
    .from("repository_analytics_daily")
    .select(
      `
      *,
      repositories!inner(id, repository, profile_id, assignment_group_id,
        profiles(id, name),
        assignment_groups(id, name)
      )
    `
    )
    .eq("assignment_id", assignmentId)
    .order("date", { ascending: true });

  if (dailyError) throw dailyError;

  const { data: items, error: itemsError } = await supabase
    .from("repository_analytics_items")
    .select(
      `
      *,
      repositories!inner(id, repository, profile_id, assignment_group_id,
        profiles(id, name),
        assignment_groups(id, name)
      )
    `
    )
    .eq("assignment_id", assignmentId)
    .order("created_date", { ascending: true });

  if (itemsError) throw itemsError;

  return { dailyStats: dailyStats || [], items: items || [] };
}
