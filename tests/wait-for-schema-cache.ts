// Playwright globalSetup: probe PostgREST until its in-memory schema cache
// is loaded and the typical mutating call path is healthy. Runs ONCE before
// any worker spawns.
//
// Why this exists:
//   PostgREST listens on the `pgrst` LISTEN channel and rebuilds its cache
//   whenever any DDL fires the `extensions.pgrst_ddl_watch` event trigger.
//   The supabase-postgres image installs that trigger globally, so realtime
//   partition rotation, pg_cron internal CREATE/ALTER, supabase service
//   migrations, etc. all invalidate the cache without warning. During the
//   rebuild window (typically tens of ms but can be longer if the meta
//   query contends with a concurrent transaction), inbound REST writes
//   come back with
//
//       "Could not query the database for the schema cache. Retrying."
//
//   That's the error that bombed ~10% of the E2E suite on a freshly
//   deployed preview — the realtime tenant migrations ran during the
//   chart's postStart hook, queued up several reloads, and one of them
//   raced our setup() class-creation.
//
//   The robust fix is to wait at the suite boundary, not to retry inside
//   every test. We probe both an INSERT path (the actual call shape that
//   was failing) and a SELECT to make sure the cache is fully built.

import { createClient } from "@supabase/supabase-js";
import { Database } from "@/utils/supabase/SupabaseTypes";

const TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
// Once we see a successful probe pass, keep probing until the cache has
// been quiet (no errors) for this long. Otherwise we can return on the
// FIRST quiet window and miss the realtime tenant-migrations storm that
// hits 30–60s after the cluster reports ready — exactly when the suite
// has started spawning workers.
const STEADY_STATE_MS = 30_000;

export default async function globalSetup() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    // Local-dev path with `supabase start` — env may not be exported yet.
    // In that mode the schema is whatever the supabase CLI provisions,
    // and we don't need this guard.
    // eslint-disable-next-line no-console
    console.warn("[wait-for-schema-cache] SUPABASE_URL/SERVICE_ROLE_KEY unset; skipping");
    return;
  }

  // Type-erased: this helper calls RPCs (metrics_workflow_runs_by_conclusion)
  // whose signatures land via migration. SupabaseTypes.d.ts only regenerates
  // when someone runs `npm run client-local`, so the typed client treats those
  // RPC names as unknown until then. The runtime behaviour is identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const started = Date.now();
  let lastError: string | undefined;
  let attempts = 0;
  let firstSuccessAt: number | undefined;

  while (Date.now() - started < TIMEOUT_MS) {
    attempts++;

    // 1. SELECT-side: the schema cache is needed to plan ANY query.
    //    Pick a tiny table we know exists on the demo seed.
    const selRes = await client.from("classes").select("id").limit(1);
    // 2. RPC-side: schema cache also caches function signatures. The
    //    metrics_workflow_runs_by_conclusion RPC was introduced in the
    //    20260529 migration; if PostgREST hasn't seen the latest schema
    //    it'll 404 on the RPC even though SELECT works.
    const rpcRes = !selRes.error
      ? await client.rpc("metrics_workflow_runs_by_conclusion", { window_hours: 1 })
      : { error: { message: "skipped (select failed)" } };
    // 3. INSERT-side: writes hit a different code path that previously
    //    failed with the schema-cache error. A throwaway insert into a
    //    table we have RLS access to via the service role.
    const inserted =
      !selRes.error && !rpcRes.error
        ? await client
            .from("classes")
            .insert({
              name: "schema-cache-probe-" + crypto.randomUUID(),
              slug: "schema-cache-probe-" + crypto.randomUUID(),
              github_org: "pawtograder-playground",
              time_zone: "America/New_York"
            })
            .select("id")
            .single()
        : { data: null, error: { message: "skipped" } };
    if (inserted.data?.id) {
      // Clean up the probe row immediately so we don't leak demo classes.
      await client.from("classes").delete().eq("id", inserted.data.id);
    }

    const err = selRes.error
      ? `select: ${selRes.error.message}`
      : rpcRes.error
        ? `rpc: ${rpcRes.error.message}`
        : inserted.error
          ? `insert: ${inserted.error.message}`
          : undefined;

    if (err) {
      lastError = err;
      // Any failure resets the steady-state clock — the cache moved on
      // us, the previous "quiet" window doesn't count.
      firstSuccessAt = undefined;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (firstSuccessAt === undefined) {
      firstSuccessAt = Date.now();
      // eslint-disable-next-line no-console
      console.log(`[wait-for-schema-cache] first success after ${attempts} attempt(s); now requiring ${STEADY_STATE_MS}ms of quiet`);
    }
    if (Date.now() - firstSuccessAt >= STEADY_STATE_MS) {
      // eslint-disable-next-line no-console
      console.log(
        `[wait-for-schema-cache] settled after ${attempts} attempt(s), ${Date.now() - started}ms total ` +
          `(${Date.now() - firstSuccessAt}ms quiet)`
      );
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `[wait-for-schema-cache] PostgREST schema cache did not stay quiet for ${STEADY_STATE_MS}ms ` +
      `within ${TIMEOUT_MS}ms (${attempts} attempts). Last error: ${lastError}`
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
