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

/**
 * Ceiling on the long-stuck rows one pass pulls back.
 *
 * These rows are grouped by class and thrown away, so the cap only has to be large enough that no
 * affected class goes unnamed. Without it, a deployment-wide permission failure would select one row
 * per enrolled student -- tens of thousands -- into an isolate that has better uses for the memory.
 */
const MAX_STUCK_ROWS_PER_PASS = 2000;

/**
 * How many user ids one `user_roles` lookup may name.
 *
 * supabase-js encodes `.in(...)` into the PostgREST request URL, and a UUID costs 37 characters
 * there. The full MAX_STUCK_ROWS_PER_PASS set -- which a broad Discord outage really does produce,
 * since every enrolled student in every class reaches cannot_invite together -- is around 74KB of
 * request line, well past the 8KB a gateway typically accepts before answering 414 without ever
 * reaching Postgres. The reconciler throws on that read by design, which would suppress every
 * long-stuck class alert precisely during the outage the alerts exist for.
 *
 * 100 keeps each URL near 4KB and costs at most 20 requests per pass at the row cap.
 */
const ENROLLMENT_LOOKUP_CHUNK = 100;

/**
 * Row cap for one enrollment chunk, kept below PostgREST's `max_rows = 1000`.
 *
 * The point is not the ceiling but being able to SEE it: PostgREST truncates at max_rows and answers
 * 200, so an unbounded `.select()` cannot tell a complete reply from a clipped one. Asking for a
 * bound we chose means hitting it is a fact the code can act on. One chunk is 100 users scoped to the
 * classes being alerted on, so reaching 900 rows means an assumption is wrong, not that a class is big.
 */
const ENROLLMENT_LOOKUP_ROW_CAP = 900;

type StuckRow = {
  class_id: number;
  user_id: string;
  guild_id: string;
  discord_error_code: number | null;
  detail: string | null;
  first_observed_at: string;
  last_observed_at: string;
  classes: {
    name: string | null;
    discord_server_id: string | null;
    archived: boolean | null;
    end_date: string | null;
  } | null;
};

/**
 * The TypeScript half of `is_class_active(archived, end_date)`.
 *
 * reconcile_stuck_discord_memberships() scopes its re-enqueue on that function, and the alerting pass
 * below had no equivalent -- so a course that finished last term but was never archived kept its guild
 * and its cannot_invite rows, was correctly excluded from the re-enqueue as "finished, not stuck", and
 * then paged Sentry about the same class every fifteen minutes forever. The two halves have to agree
 * on what "still running" means or the reconciler alerts on precisely the classes it has decided not
 * to repair.
 *
 * Archived classes need no term here: the archive trigger nulls `discord_server_id`, so they are
 * already dropped by the current-guild filter. It is kept anyway because relying on another trigger's
 * side effect to enforce this one's predicate is how 20260822150000 went wrong.
 */
const ACTIVE_CLASS_GRACE_DAYS = 30;

function isClassActive(archived: boolean | null, endDate: string | null): boolean {
  if (archived === true) return false;
  if (!endDate) return true;
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(end)) return true;
  return end >= Date.now() - ACTIVE_CLASS_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

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
        "class_id, user_id, guild_id, discord_error_code, detail, first_observed_at, last_observed_at, classes!inner(name, discord_server_id, archived, end_date)"
      )
      .eq("state", "cannot_invite")
      .lt("first_observed_at", cutoff)
      // Bounded for the same reason the enqueue pass is. This runs every fifteen minutes in an edge
      // isolate with a fixed memory ceiling, and the pathological case -- a deployment where the bot
      // lost its permissions everywhere -- is one row per enrolled student across every class. The
      // rows are only used to decide which classes to alert about, and MAX_STUCK_ROWS_PER_PASS is far
      // more than enough to name every affected class, so the cap costs nothing the alert needs.
      // Ordered, so the cap takes a defined sample rather than whatever the planner happened to emit.
      // Unordered, a deployment-wide failure could return 2000 rows all belonging to one class -- or
      // all belonging to students who have since been dropped, which the filter below then removes,
      // producing zero alerts while other classes really were stuck. Oldest first is the right sample
      // because it is the one the alert is about.
      .order("first_observed_at", { ascending: true })
      .limit(MAX_STUCK_ROWS_PER_PASS);
    if (stuckError) {
      console.error("[discord-reconciler] Failed to query long-stuck memberships:", stuckError);
      scope.setContext("stuck_query_error", { error: stuckError.message });
      // Wrapped in an Error rather than thrown bare: a PostgrestError is a plain object, so Sentry
      // records it without a stack and the handler above cannot read `.message` off it reliably.
      // The branch that reports the enqueue failure already throws a real Error; this matches it.
      throw new Error(`Failed to query long-stuck Discord memberships: ${stuckError.message}`);
    }

    // Rows for a guild the class no longer uses are left behind by a server change and are not a
    // live failure -- get_discord_membership_status_for_class() hides them from instructors for the
    // same reason, and alerting on them would page for a server nobody is using any more.
    const onCurrentGuild = ((stuckRows ?? []) as unknown as StuckRow[]).filter(
      (row) =>
        row.classes?.discord_server_id === row.guild_id &&
        // Same predicate the re-enqueue half scopes on. See isClassActive.
        isClassActive(row.classes?.archived ?? null, row.classes?.end_date ?? null)
    );

    // Rows for somebody who is no longer an active member of the class are not a live failure either.
    // A student who reached cannot_invite and was then dropped keeps their status row -- nothing
    // deletes it on disable, deliberately, since an instructor re-enabling them should not lose the
    // history -- so without this the class was paged every fifteen minutes about a person who is not
    // expected in the server at all. get_discord_membership_status_for_class() hides these from the
    // roster for the same reason, and this is the alerting half of that predicate.
    //
    // Unlinking Discord needs no filter here: clear_discord_membership_status_on_identity_change is
    // `AFTER UPDATE OF discord_id ... WHEN (new.discord_id IS DISTINCT FROM old.discord_id)`, so
    // setting it to NULL already deletes the rows.
    let stuck = onCurrentGuild;
    if (onCurrentGuild.length > 0) {
      const userIds = [...new Set(onCurrentGuild.map((row) => row.user_id))];
      const alertedClassIds = [...new Set(onCurrentGuild.map((row) => row.class_id))];
      const active = new Set<string>();
      for (let offset = 0; offset < userIds.length; offset += ENROLLMENT_LOOKUP_CHUNK) {
        const chunk = userIds.slice(offset, offset + ENROLLMENT_LOOKUP_CHUNK);
        const { data: activeRoles, error: rolesError } = await supabase
          .from("user_roles")
          .select("class_id, user_id")
          .eq("disabled", false)
          .in("user_id", chunk)
          // Narrowed to the classes actually being alerted on, and bounded explicitly.
          //
          // Without the class filter this asked for every enrollment each of these users has in every
          // course on the deployment. A user with rows in several classes multiplies, and PostgREST
          // applies `max_rows = 1000` (supabase/config.toml) by TRUNCATING rather than erroring -- so
          // the reply came back short, the missing pairs read as "not enrolled", and whole classes were
          // silently dropped from the >12h alert. Silently, because a truncated 200 is
          // indistinguishable from a complete one.
          .in("class_id", alertedClassIds)
          .limit(ENROLLMENT_LOOKUP_ROW_CAP);
        if (rolesError) {
          // Fail loud rather than alerting on an unfiltered set: a silent fallback here would restore
          // exactly the noise this filter exists to remove. Thrown on the first failing chunk, so a
          // partial `active` set is never used to decide who is enrolled.
          throw new Error(`Failed to read active enrollments for stuck Discord memberships: ${rolesError.message}`);
        }
        if ((activeRoles ?? []).length >= ENROLLMENT_LOOKUP_ROW_CAP) {
          // At the cap the result may be truncated and there is no way to tell, so the enrollment set
          // is not trustworthy. Thrown for the same reason the branch above throws: alerting on a set
          // we know might be short is how a real outage goes unreported.
          throw new Error(
            `Active-enrollment lookup for stuck Discord memberships hit its ${ENROLLMENT_LOOKUP_ROW_CAP}-row cap; refusing to alert on a possibly truncated enrollment set`
          );
        }
        for (const role of activeRoles ?? []) active.add(`${role.class_id}:${role.user_id}`);
      }
      // The class is matched here rather than in the query. A `class_id` predicate would add its own
      // list to every URL above for no benefit: the pair key already requires the row to be for this
      // class, and a user's other classes contribute keys that simply never match.
      stuck = onCurrentGuild.filter((row) => active.has(`${row.class_id}:${row.user_id}`));
    }

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
