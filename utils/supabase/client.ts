import { createBrowserClient } from "@supabase/ssr";
import { createClient as supabaseCreateClient } from "@supabase/supabase-js";
import { Database } from "./SupabaseTypes";
import { assert } from "../utils";

// During coverage runs we replace `supabase functions serve` with our own
// Deno bootstrap (see supabase/functions/_coverage/). The Supabase SDK
// builds the functions URL from supabaseUrl at construction time and
// exposes no public setter; we override the internal URL after the client
// is built when this env var is set. The cast goes through `unknown` to
// preserve the caller's generic Database parameter — using a generic
// constraint here makes downstream T resolve to `unknown` which breaks
// typed table access throughout the codebase.
const FUNCTIONS_URL_OVERRIDE = process.env.NEXT_PUBLIC_COVERAGE_FUNCTIONS_URL ?? process.env.COVERAGE_FUNCTIONS_URL;

function applyFunctionsUrlOverride<T>(client: T): T {
  if (!FUNCTIONS_URL_OVERRIDE) return client;
  try {
    const c = client as unknown as { functionsUrl?: URL; functions?: { url?: string } };
    c.functionsUrl = new URL(FUNCTIONS_URL_OVERRIDE);
    if (c.functions) c.functions.url = FUNCTIONS_URL_OVERRIDE;
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[coverage] failed to override functions URL:", err);
    }
  }
  return client;
}

export const createClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  assert(supabaseUrl, "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  assert(supabaseAnonKey, "SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY is required");

  const client = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey, {
    realtime: {
      worker: true
    }
  });
  return applyFunctionsUrlOverride(client);
};

export const createAdminClient = <DB>() => {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(supabaseUrl, "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  assert(supabaseServiceRoleKey, "SUPABASE_SERVICE_ROLE_KEY is required");

  const client = supabaseCreateClient<DB>(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  return applyFunctionsUrlOverride(client);
};
