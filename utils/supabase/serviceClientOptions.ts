/**
 * Auth options for short-lived, server-side supabase-js clients.
 *
 * WHY THIS EXISTS. `createClient()` from @supabase/supabase-js defaults to
 * `autoRefreshToken: true`. GoTrueClient's constructor runs
 * initialize() -> _initialize() -> _handleVisibilityChange(), and on a
 * non-browser platform that last step calls startAutoRefresh()
 * unconditionally — "in non-browser environments the refresh token ticker runs
 * always". That is a `setInterval(..., 30_000)` which strongly retains the
 * GoTrueClient, which retains the SupabaseClient. Nothing in a request-scoped
 * client's lifetime ever calls stopAutoRefresh(), so on the server every client
 * built per request survives GC for the life of the process.
 *
 * That is fine for the long-lived singleton a browser tab keeps, and a leak for
 * anything created per request: one course-page render calls
 * createClientWithCaching() 18 times, so a web pod accumulates 18 immortal
 * clients (~24 KB each) per render until it hits its memory limit and is
 * OOM-killed.
 *
 * `createServerClient` from @supabase/ssr already passes `autoRefreshToken:
 * false` internally, which is why utils/supabase/server.ts and
 * utils/supabase/middleware.ts never had this problem — only the raw
 * `createClient()` call sites do.
 *
 * Every call site using these options talks to PostgREST with the service-role
 * key and never carries a user session, so disabling session persistence and
 * refresh is behaviourally a no-op.
 */
export const SERVICE_CLIENT_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false
} as const;
