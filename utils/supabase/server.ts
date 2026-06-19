import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { Database } from "./SupabaseTypes";

export const createClient = async () => {
  const cookieStore = await cookies();

  return createServerClient<Database>(
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
};
