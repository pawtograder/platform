import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { Database } from "./SupabaseTypes";

const FUNCTIONS_URL_OVERRIDE = process.env.NEXT_PUBLIC_COVERAGE_FUNCTIONS_URL ?? process.env.COVERAGE_FUNCTIONS_URL;

export const createClient = async () => {
  const cookieStore = await cookies();

  const client = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
      (client as unknown as { functionsUrl?: URL }).functionsUrl = new URL(FUNCTIONS_URL_OVERRIDE);
      (client.functions as unknown as { url?: string }).url = FUNCTIONS_URL_OVERRIDE;
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
