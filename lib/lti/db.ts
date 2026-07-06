/**
 * Server-only Supabase access for LTI flows. All LTI endpoints run trusted,
 * server-to-server logic (verifying platform tokens, signing assertions, writing
 * launch state), so they use the service-role admin client.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/client";
import type { Database } from "@/utils/supabase/SupabaseTypes";

export type LtiDb = SupabaseClient<Database>;

export function ltiAdminClient(): LtiDb {
  return createAdminClient<Database>();
}
