import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { Database } from "./SupabaseTypes";
import { sessionCookieOptions } from "../channels";
import { withProfiling } from "./ssrProfile";

export const createClient = async () => {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    // Server-side: prefer SUPABASE_URL (may point in-cluster/internal); the public
    // NEXT_PUBLIC_SUPABASE_URL is the browser-facing fallback. Anon key stays public.
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Scope auth cookies to the parent zone for cross-channel-host sessions.
      // Derived from the channel host suffix; see utils/channels.ts.
      ...sessionCookieOptions(),
      // SSR latency/directness profiling (no-op unless SSR_PROFILE is set).
      global: { fetch: withProfiling("ssr-user") },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch (error) {
            // The `set` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        }
      }
    }
  );
};
