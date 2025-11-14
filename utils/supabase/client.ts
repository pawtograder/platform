import { createBrowserClient } from "@supabase/ssr";
import { createClient as supabaseCreateClient } from "@supabase/supabase-js";
import { Database } from "./SupabaseTypes";
import { assert } from "../utils";

export const createClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  assert(supabaseUrl, "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  assert(supabaseAnonKey, "SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY is required");

  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey, {
    realtime: {
      worker: true
    }
  });
};

export const createAdminClient = <DB>() => {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(supabaseUrl, "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  assert(supabaseServiceRoleKey, "SUPABASE_SERVICE_ROLE_KEY is required");

  return supabaseCreateClient<DB>(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
};
