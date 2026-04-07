import "server-only";

/**
 * Uncached SSR loaders for platform-wide and per-course data.
 * Callers must pass a Supabase client (cookie session or service role).
 */
import type { FlashcardDeck } from "@/utils/supabase/DatabaseTypes";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function fetchUserCoursesWithClasses(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role, classes(*)")
    .eq("user_id", userId)
    .eq("disabled", false);
  return { data: data ?? [], error: error?.message ?? null };
}

export type AdminDashboardStats = {
  totalClasses: number | null;
  totalUsers: number | null;
  totalEnrollments: number | null;
  recentClasses: Array<{ id: number; name: string | null; created_at: string }> | null;
  errors: string[];
};

export async function fetchAdminDashboardStats(supabase: SupabaseClient<Database>): Promise<AdminDashboardStats> {
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
}

export async function fetchFlashcardDecksForCourse(supabase: SupabaseClient<Database>, classId: number) {
  const { data, error } = await supabase
    .from("flashcard_decks")
    .select("*")
    .eq("class_id", classId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  return {
    decks: (data ?? []) as FlashcardDeck[],
    error: error?.message ?? null
  };
}
