/**
 * Auth options for the per-request supabase-js clients the edge functions build.
 *
 * WHY THIS EXISTS. `createClient()` defaults to `autoRefreshToken: true`.
 * GoTrueClient's constructor runs initialize() -> _initialize() ->
 * _handleVisibilityChange(), and on a non-browser platform that last step calls
 * startAutoRefresh() unconditionally -- "in non-browser environments the refresh
 * token ticker runs always". That is a `setInterval(..., 30_000)` which strongly
 * retains the GoTrueClient, which retains the SupabaseClient. Nothing in a
 * request-scoped client's lifetime ever calls stopAutoRefresh(), so every client
 * built per request survives GC for the life of the isolate.
 *
 * This is the edge-function twin of `utils/supabase/serviceClientOptions.ts`,
 * which fixed the same defect in the web tier (#984). It is worth stating why it
 * bites harder here than the ~24KB/client the web tier measured: a user worker
 * serves many requests and is only retired on a memory / CPU / wall-clock limit,
 * so the tickers accumulate and keep *running*. Measured locally against
 * supabase/edge-runtime v1.74.0 driving all bundled functions, RSS climbed
 * ~3.0 MiB/min with ZERO requests in flight -- no per-request work, no eszip
 * cold load, no isolate creation, just tickers firing. Applying these options
 * flattened that to -2.2 MiB/min, reproduced against an unpatched control that
 * agreed with itself to within 1.3%.
 *
 * Verified in Deno 2.9.6 with jsr:@supabase/supabase-js@2: instrumenting
 * globalThis.setInterval before importing shows one 30s timer per createClient()
 * with the defaults, and none with these options.
 *
 * SAFE FOR THE JWT-CARRYING CALL SITES TOO. A dozen callers pass a user's token
 * via `global.headers.Authorization` rather than through a supabase-js session.
 * PostgREST authorizes off that header; nothing reads or refreshes a stored
 * session, so disabling session persistence and refresh is behaviourally a
 * no-op for them as well as for the service-role clients.
 */
export const REQUEST_SCOPED_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false
} as const;
