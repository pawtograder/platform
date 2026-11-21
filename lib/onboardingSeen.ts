import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

/**
 * Which onboarding guides the signed-in user has seen, stored per user in user_onboarding_seen
 * (supabase/migrations/20261121160000_user_onboarding_seen.sql). A guide that is meant to show once
 * then shows once per user, on every browser and device, instead of once per browser.
 *
 * RLS limits each user to their own rows, so these calls only read and write the signed-in user's
 * rows. Neither call passes a user id: the table fills user_id from auth.uid().
 */

/** The guides that record "seen" here. Add a key when a new guide needs one. */
export const ONBOARDING_KEYS = {
  /** The office hours hints for students (#1347). */
  OFFICE_HOURS_STUDENT_ONBOARDING: "office-hours-student-onboarding"
} as const;

export type OnboardingKey = (typeof ONBOARDING_KEYS)[keyof typeof ONBOARDING_KEYS];

/**
 * Whether the signed-in user has seen this guide. Throws if the read fails, so the caller decides
 * what a failed read means. A guide that opens on its own should usually treat it as seen, so it
 * doesn't open on every page load while the database is unreachable.
 */
export async function hasSeenOnboarding(supabase: SupabaseClient<Database>, key: OnboardingKey): Promise<boolean> {
  const { data, error } = await supabase.from("user_onboarding_seen").select("key").eq("key", key).maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Records that the signed-in user has seen this guide. Recording it again is not an error. */
export async function markOnboardingSeen(supabase: SupabaseClient<Database>, key: OnboardingKey): Promise<void> {
  const { error } = await supabase
    .from("user_onboarding_seen")
    .upsert({ key }, { onConflict: "user_id,key", ignoreDuplicates: true });
  if (error) throw error;
}
