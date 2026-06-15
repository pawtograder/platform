import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { Database } from "./SupabaseTypes";

// Gate the override on COVERAGE === "1" (defense-in-depth), not merely on
// the URL var being present, so a stray COVERAGE_FUNCTIONS_URL in a
// non-coverage environment can't reroute server-side functions.invoke()
// traffic to the coverage host.
const FUNCTIONS_URL_OVERRIDE =
  process.env.COVERAGE === "1"
    ? (process.env.NEXT_PUBLIC_COVERAGE_FUNCTIONS_URL ?? process.env.COVERAGE_FUNCTIONS_URL)
    : undefined;

export const createClient = async () => {
  const cookieStore = await cookies();

  const client = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // See utils/supabase/middleware.ts: scope auth cookies to the parent domain
      // for cross-channel-host sessions when NEXT_PUBLIC_SESSION_COOKIE_DOMAIN is set.
      ...(process.env.NEXT_PUBLIC_SESSION_COOKIE_DOMAIN
        ? { cookieOptions: { domain: process.env.NEXT_PUBLIC_SESSION_COOKIE_DOMAIN } }
        : {}),
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

  if (FUNCTIONS_URL_OVERRIDE) {
    try {
      const c = client as unknown as { functionsUrl?: URL; functions?: { url?: string } };
      c.functionsUrl = new URL(FUNCTIONS_URL_OVERRIDE);
      if (c.functions) c.functions.url = FUNCTIONS_URL_OVERRIDE;
    } catch (err) {
      // In coverage mode this MUST work — silently falling back would
      // still send requests, but they wouldn't hit our bootstrap and
      // would silently produce zero edge coverage. That looks like a
      // testing problem but is actually a misconfiguration; surface it.
      if (process.env.COVERAGE === "1") {
        throw new Error(`[coverage] failed to override server-side functions URL: ${err}`);
      }
      console.warn("[coverage] failed to override server-side functions URL:", err);
    }
  }

  return client;
};
