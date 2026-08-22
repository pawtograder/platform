import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
// Import for side effect as well as for the helpers: SentryInit owns the single Sentry.init for the
// edge runtime, and without it every capture below would be a silent no-op.
import { serveWithSentryFlush } from "../_shared/SentryInit.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

/**
 * Discord Reconciler
 *
 * Invoked every 15 minutes via pg_cron (see 20260822120000_discord_circuit_breaker_and_reconciler).
 * The Discord counterpart of github-repo-reconciler, and it does the same two jobs:
 *
 *  1. Re-enqueue membership work that was LOST. All Discord membership observation happens inside
 *     one hourly batch_role_sync envelope, so if that envelope is dropped -- an isolate killed
 *     mid-sweep, a dead-letter, a rate-limit requeue that outlives its retry ceiling -- nothing
 *     re-observes those users and nothing notices, because a stale not_joined row looks exactly like
 *     a fresh one. reconcile_stuck_discord_memberships() re-enqueues the ones whose status has gone
 *     unobserved, and only those: it skips terminal cannot_invite rows, guilds with an open circuit
 *     breaker, and work already on the queue, so a healthy platform makes it a no-op rather than a
 *     second copy of the hourly sync.
 *
 *  2. Alert on classes stuck > 12h. A cannot_invite row is terminal by design -- it needs a Discord
 *     server admin to act -- and the roster shows it to instructors. What nothing showed is the case
 *     where NOBODY acts: the row sits there for days and the class quietly has no working Discord
 *     integration. One Sentry issue per class (not per student) is the shape that makes that
 *     noticeable without reproducing the 30,332-row flood the terminal-failure work removed.
 */

/**
 * Three missed hourly passes. Long enough that an ordinary slow or backed-up sync is not treated as
 * a lost one, short enough that a genuinely dropped sweep is repaired within the morning.
 */
const STALE_MINUTES = 180;

/** Bounds one pass's enqueue burst, so a platform-wide outage recovers in waves. */
const MAX_ENQUEUE_PER_PASS = 200;

const ALERT_AFTER_HOURS = 12;

type StuckRow = {
  class_id: number;
  user_id: string;
  guild_id: string;
  discord_error_code: number | null;
  detail: string | null;
  first_observed_at: string;
  last_observed_at: string;
  classes: { name: string | null; discord_server_id: string | null } | null;
};

/**
 * Call an RPC that is not in the generated `Database` type yet.
 *
 * reconcile_stuck_discord_memberships() ships in the same change as this function, and
 * SupabaseTypes.d.ts is generated from the database rather than from the migrations, so it does not
 * know the RPC until the migration has been applied and the types regenerated. Same escape hatch the
 * metrics function uses for vacuum_health_check.
 */
type UntypedRpcResult<T> = { data: T | null; error: { message: string } | null };

function untypedRpc<T>(
  supabase: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown>
): Promise<UntypedRpcResult<T>> {
  const client = supabase as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => Promise<UntypedRpcResult<T>>;
  };
  return client.rpc(fn, args);
}

serveWithSentryFlush(async (req) => {
  console.log(`[discord-reconciler] Received request: ${req.method}`);

  const scope = new Sentry.Scope();
  scope.setTag("function", "discord-reconciler");

  // Require the shared edge-function secret on EVERY request. The pg_cron invoker sends it via
  // call_edge_function_internal (injected from Vault). x-supabase-webhook-source is only an
  // attacker-settable routing/logging label and must never grant access on its own.
  const secret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");
  const webhookSource = req.headers.get("x-supabase-webhook-source");
  if (!expectedSecret || secret !== expectedSecret) {
    console.error(`[discord-reconciler] Unauthorized request (source=${webhookSource ?? "none"})`);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    console.error("[discord-reconciler] Missing required environment variables");
    return new Response(JSON.stringify({ error: "Missing required environment variables" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseKey);

  try {
    // 1) Re-enqueue membership checks the hourly sync stopped performing.
    const { data: requeuedCount, error: reconcileError } = await untypedRpc<number>(
      supabase,
      "reconcile_stuck_discord_memberships",
      { p_stale_minutes: STALE_MINUTES, p_limit: MAX_ENQUEUE_PER_PASS }
    );
    if (reconcileError) {
      console.error("[discord-reconciler] reconcile_stuck_discord_memberships failed:", reconcileError);
      scope.setContext("reconcile_error", { error: reconcileError.message });
      throw new Error(reconcileError.message);
    }
    const requeued = requeuedCount ?? 0;
    console.log(`[discord-reconciler] Re-enqueued ${requeued} stale membership checks`);
    if (requeued >= MAX_ENQUEUE_PER_PASS) {
      // The cap was reached, so there is more waiting than one pass can carry. Worth saying out
      // loud: it means the hourly sync has been failing broadly rather than for a class or two.
      const capScope = scope.clone();
      capScope.setContext("reconcile_cap", { requeued, cap: MAX_ENQUEUE_PER_PASS, stale_minutes: STALE_MINUTES });
      capScope.setFingerprint(["discord-reconciler", "enqueue-cap-reached"]);
      capScope.setLevel("warning");
      Sentry.captureMessage(
        `Discord reconciler hit its per-pass cap of ${MAX_ENQUEUE_PER_PASS} stale memberships; the hourly role sync is probably not completing`,
        capScope
      );
    }

    // 2) Alert on classes whose membership rows have been failing longer than the threshold.
    //
    // cannot_invite only. not_joined is a student who has not clicked their invite, which is normal
    // and resolves without anyone being paged; cannot_invite is the bot being unable to act, which
    // is the state that needs a human. first_observed_at is the right clock because
    // record_discord_membership_status() resets it whenever the state changes, so it measures how
    // long this failure has persisted rather than how long the row has existed.
    const cutoff = new Date(Date.now() - ALERT_AFTER_HOURS * 60 * 60 * 1000).toISOString();
    const { data: stuckRows, error: stuckError } = await supabase
      .from("discord_membership_status")
      .select(
        "class_id, user_id, guild_id, discord_error_code, detail, first_observed_at, last_observed_at, classes!inner(name, discord_server_id)"
      )
      .eq("state", "cannot_invite")
      .lt("first_observed_at", cutoff);
    if (stuckError) {
      console.error("[discord-reconciler] Failed to query long-stuck memberships:", stuckError);
      scope.setContext("stuck_query_error", { error: stuckError.message });
      throw stuckError;
    }

    // Rows for a guild the class no longer uses are left behind by a server change and are not a
    // live failure -- get_discord_membership_status_for_class() hides them from instructors for the
    // same reason, and alerting on them would page for a server nobody is using any more.
    const stuck = ((stuckRows ?? []) as unknown as StuckRow[]).filter(
      (row) => row.classes?.discord_server_id === row.guild_id
    );

    // Grouped per class before capturing. One misconfigured guild affects every enrolled student, so
    // per-row events would be the dead-letter flood again, in Sentry instead of pgmq.
    const byClass = new Map<number, StuckRow[]>();
    for (const row of stuck) {
      const existing = byClass.get(row.class_id);
      if (existing) existing.push(row);
      else byClass.set(row.class_id, [row]);
    }

    for (const [classId, rows] of byClass) {
      const oldest = rows.reduce((a, b) => (a.first_observed_at <= b.first_observed_at ? a : b));
      const classScope = scope.clone();
      classScope.setTag("class_id", String(classId));
      classScope.setTag("guild_id", oldest.guild_id);
      classScope.setTag("discord_error_code", String(oldest.discord_error_code ?? "none"));
      // One issue per class, matching how github-repo-reconciler groups per class+assignment.
      classScope.setFingerprint(["discord-membership-stuck", String(classId)]);
      classScope.setContext("stuck_discord_membership", {
        class_id: classId,
        class_name: oldest.classes?.name ?? null,
        guild_id: oldest.guild_id,
        affected_users: rows.length,
        oldest_first_observed_at: oldest.first_observed_at,
        last_observed_at: oldest.last_observed_at,
        discord_error_code: oldest.discord_error_code,
        detail: oldest.detail,
        hours_stuck: ALERT_AFTER_HOURS
      });
      classScope.setLevel("error");
      Sentry.captureMessage(
        `Discord membership has been failing for ${rows.length} user(s) in class ${classId} for over ${ALERT_AFTER_HOURS}h; a Discord server admin needs to restore the bot's access`,
        classScope
      );
    }

    if (byClass.size > 0) {
      console.warn(
        `[discord-reconciler] ${stuck.length} memberships across ${byClass.size} class(es) stuck > ${ALERT_AFTER_HOURS}h (alerted to Sentry)`
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        requeued,
        long_stuck_users: stuck.length,
        long_stuck_classes: byClass.size,
        timestamp: new Date().toISOString()
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[discord-reconciler] Error:", error);
    Sentry.captureException(error, scope);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString()
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
