import { createBrowserClient } from "@supabase/ssr";
import { createClient as supabaseCreateClient } from "@supabase/supabase-js";
import { Database } from "./SupabaseTypes";
import { assert } from "../utils";
import { sessionCookieOptions } from "../channels";
import { installFetchHook } from "../../lib/bugReport/fetchHook";

export const createClient = () => {
  // supabase-js captures `window.fetch` when the client is constructed (and @supabase/ssr keeps
  // one browser client per page), so the bug reporter's pass-through fetch hook has to be in
  // place first. It forwards straight to the original fetch unless a recorder is listening.
  // No-op on the server.
  installFetchHook();
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  assert(supabaseUrl, "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  assert(supabaseAnonKey, "SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY is required");

  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey, {
    realtime: {
      worker: true
    },
    // Scope auth cookies to the parent zone for cross-channel-host sessions.
    // Derived from the channel host suffix; see utils/channels.ts.
    ...sessionCookieOptions()
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
