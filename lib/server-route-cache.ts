import "server-only";

import { createClient } from "@/utils/supabase/server";
import type { FlashcardDeck } from "@/utils/supabase/DatabaseTypes";
import { unstable_cache } from "next/cache";

const SHORT_REVALIDATE_SECONDS = 30;

/** User's enrollments with class rows (course picker / redirect). */
export async function getCachedUserCoursesWithClasses(userId: string) {
  return unstable_cache(
    async () => {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("user_roles")
        .select("role, classes(*)")
        .eq("user_id", userId)
        .eq("disabled", false);
      return { data: data ?? [], error: error?.message ?? null };
    },
    ["user-courses-with-classes", userId],
    { revalidate: SHORT_REVALIDATE_SECONDS, tags: [`user:${userId}:courses`] }
  )();
}

type AdminDashboardStats = {
  totalClasses: number | null;
  totalUsers: number | null;
  totalEnrollments: number | null;
  recentClasses: Array<{ id: number; name: string | null; created_at: string }> | null;
  errors: string[];
};

export async function getCachedAdminDashboardStats(): Promise<AdminDashboardStats> {
  return unstable_cache(
    async () => {
      const supabase = await createClient();
      const errors: string[] = [];
      const [
        { count: totalClasses, error: e1 },
        { count: totalUsers, error: e2 },
        { count: totalEnrollments, error: e3 },
        { data: recentClasses, error: e4 }
      ] = await Promise.all([
        supabase.from("classes").select("*", { count: "exact", head: true }),
        supabase.from("users").select("*", { count: "exact", head: true }),
        supabase.from("user_roles").select("*", { count: "exact", head: true }),
        supabase.from("classes").select("id, name, created_at").order("created_at", { ascending: false }).limit(5)
      ]);
      if (e1) errors.push(e1.message);
      if (e2) errors.push(e2.message);
      if (e3) errors.push(e3.message);
      if (e4) errors.push(e4.message);
      return {
        totalClasses: totalClasses ?? null,
        totalUsers: totalUsers ?? null,
        totalEnrollments: totalEnrollments ?? null,
        recentClasses: recentClasses ?? null,
        errors
      };
    },
    ["admin-dashboard-stats"],
    { revalidate: SHORT_REVALIDATE_SECONDS, tags: ["admin:dashboard-stats"] }
  )();
}

export async function getCachedFlashcardDecksForCourse(classId: number, userId: string) {
  return unstable_cache(
    async () => {
      const client = await createClient();
      const { data, error } = await client
        .from("flashcard_decks")
        .select("*")
        .eq("class_id", classId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      return {
        decks: (data ?? []) as FlashcardDeck[],
        error: error?.message ?? null
      };
    },
    ["flashcard-decks", String(classId), userId],
    { revalidate: SHORT_REVALIDATE_SECONDS, tags: [`course:${classId}:flashcard-decks`] }
  )();
}
