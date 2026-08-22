import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
// Import for side effect: this function makes Sentry calls but does not import HandlerUtils, so
// without this Sentry.init never ran and every capture was a silent no-op.
import { serveWithSentryFlush } from "../_shared/SentryInit.ts";
import type {
  DiscordAsyncEnvelope,
  SendMessageArgs,
  UpdateMessageArgs,
  CreateChannelArgs,
  DeleteChannelArgs,
  CreateRoleArgs,
  DeleteRoleArgs,
  AddMemberRoleArgs,
  RemoveMemberRoleArgs
} from "../_shared/DiscordAsyncTypes.ts";
import * as discord from "../_shared/DiscordWrapper.ts";
import { beginWorkerRun } from "../_shared/workerRun.ts";
import {
  classifyDiscordError,
  isBotPermissionProblem,
  isRateLimitError,
  isResourceGone,
  DISCORD_UNKNOWN_GUILD
} from "../_shared/DiscordErrorClassification.ts";
import { discordApiBase, isDiscordApiMocked } from "../_shared/DiscordApiBase.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { waitUntilWithSentryFlush } from "../_shared/SentryInit.ts";

// Declare EdgeRuntime for type safety
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

// Guard to prevent multiple concurrent batch handlers per runtime instance
let started = false;

type QueueMessage<T> = {
  msg_id: number;
  read_ct: number;
  vt: string;
  enqueued_at: string;
  message: T;
};

function toMsLatency(enqueuedAt: string): number {
  try {
    const start = new Date(enqueuedAt).getTime();
    const end = Date.now();
    return Math.max(0, end - start);
  } catch {
    return 0;
  }
}

/** Returns whether the message actually left the queue. Callers that have no other way of ending a
 * message need to know: an unarchived message reappears when its visibility timeout expires. */
async function archiveMessage(
  adminSupabase: SupabaseClient<Database>,
  msgId: number,
  scope: Sentry.Scope
): Promise<boolean> {
  console.log(`[archiveMessage] Archiving message ${msgId}`);
  try {
    const { error } = await adminSupabase.schema("pgmq_public").rpc("archive", {
      queue_name: "discord_async_calls",
      message_id: msgId
    });
    if (error) {
      throw error;
    }
    console.log(`[archiveMessage] Successfully archived message ${msgId}`);
    return true;
  } catch (error) {
    console.error(`[archiveMessage] Failed to archive message ${msgId}:`, error);
    scope.setContext("archive_error", {
      msg_id: msgId,
      error_message: error instanceof Error ? error.message : String(error)
    });
    Sentry.captureException(error, scope);
    return false;
  }
}

/**
 * Remove a message from the queue outright.
 *
 * The fallback for when `archive` fails and the payload is already safe in the dead letter queue.
 * Archiving is preferred everywhere else because it keeps the message for inspection, but a message
 * that cannot be archived and is not deleted is redelivered every time its visibility timeout
 * expires, with no retry ceiling on the terminal path to stop it.
 */
async function deleteMessage(
  adminSupabase: SupabaseClient<Database>,
  msgId: number,
  scope: Sentry.Scope
): Promise<boolean> {
  try {
    const { error } = await adminSupabase.schema("pgmq_public").rpc("delete", {
      queue_name: "discord_async_calls",
      message_id: msgId
    });
    if (error) {
      throw error;
    }
    console.log(`[deleteMessage] Deleted message ${msgId} after archiving failed`);
    return true;
  } catch (error) {
    console.error(`[deleteMessage] Failed to delete message ${msgId}:`, error);
    scope.setContext("delete_error", {
      msg_id: msgId,
      error_message: error instanceof Error ? error.message : String(error)
    });
    Sentry.captureException(error, scope);
    return false;
  }
}

function parseRetryAfterSeconds(error: unknown): number | undefined {
  const err = error as { message?: string };
  const msg = err?.message || "";

  // Discord rate limit errors contain "retry after Xms" or similar
  const match = msg.match(/retry after (\d+)ms/i);
  if (match) {
    const ms = parseInt(match[1], 10);
    if (!isNaN(ms) && ms >= 0) return Math.ceil(ms / 1000); // Convert to seconds
  }

  return undefined;
}

function detectRateLimit(error: unknown): { isRateLimit: boolean; retryAfter?: number } {
  // Delegates to the shared classifier rather than keeping its own `msg.includes("429")` rule.
  // The wrapper interpolates 17-19 digit snowflakes into its messages, so the bare substring made
  // this disagree with classifyDiscordError about the same error: a timeout on
  // `GET /guilds/1142900000000000000/members/…` was tagged rate_limit in Sentry and took the
  // rate-limit backoff path, polluting the signal that genuine 429s are meant to raise.
  if (isRateLimitError(error)) {
    return {
      isRateLimit: true,
      retryAfter: parseRetryAfterSeconds(error)
    };
  }

  return { isRateLimit: false };
}

function computeBackoffSeconds(baseSeconds: number | undefined, retryCount: number): number {
  const base = Math.max(5, baseSeconds ?? 60);
  const exp = Math.min(6, Math.max(0, retryCount));
  const backoff = Math.min(900, base * Math.pow(2, exp));
  const jitter = Math.floor(Math.random() * Math.floor(backoff / 4));
  return backoff + jitter;
}

/**
 * Put a replacement message on the queue.
 *
 * Returns whether it is actually there. Callers archive the original immediately afterwards, so a
 * swallowed failure here loses the operation outright -- and for a manually requested retry on an
 * inactive class there is no hourly batch behind it to notice, leaving the recorded failure stuck
 * until somebody presses the button again.
 */
async function requeueWithDelay(
  adminSupabase: SupabaseClient<Database>,
  envelope: DiscordAsyncEnvelope,
  delaySeconds: number,
  scope: Sentry.Scope
): Promise<boolean> {
  const newRetryCount = (envelope.retry_count ?? 0) + 1;
  console.log(
    `[requeueWithDelay] Requeuing envelope with method=${envelope.method}, retry_count=${newRetryCount}, delay=${delaySeconds}s`
  );
  return await sendReplacement(adminSupabase, { ...envelope, retry_count: newRetryCount }, delaySeconds, scope);
}

/**
 * Put a replacement message on the queue WITHOUT charging it a retry.
 *
 * For the circuit breaker's deferrals, which are not attempts: no Discord call was made and nothing
 * about this envelope failed. Spending `retry_count` on them was what dead-lettered work the breaker
 * was successfully deferring. Deferrals are bounded by their own counter instead -- see
 * MAX_CIRCUIT_DEFERRALS -- so this is not an unbounded requeue.
 */
async function requeueWithoutRetry(
  adminSupabase: SupabaseClient<Database>,
  envelope: DiscordAsyncEnvelope,
  delaySeconds: number,
  scope: Sentry.Scope
): Promise<boolean> {
  console.log(
    `[requeueWithoutRetry] Requeuing envelope with method=${envelope.method}, retry_count=${envelope.retry_count ?? 0} (unchanged), delay=${delaySeconds}s`
  );
  return await sendReplacement(adminSupabase, envelope, delaySeconds, scope);
}

/** The pgmq write both requeue paths share. Returns whether the replacement is actually on the queue. */
async function sendReplacement(
  adminSupabase: SupabaseClient<Database>,
  newEnvelope: DiscordAsyncEnvelope,
  delaySeconds: number,
  scope: Sentry.Scope
): Promise<boolean> {
  const result = await adminSupabase.schema("pgmq_public").rpc("send", {
    queue_name: "discord_async_calls",
    message: newEnvelope as unknown as Json,
    sleep_seconds: delaySeconds
  });
  if (result.error) {
    console.error(`[sendReplacement] Failed to requeue:`, result.error);
    scope.setContext("requeue_error", { error_message: result.error.message, delay_seconds: delaySeconds });
    Sentry.captureException(result.error, scope);
    return false;
  }
  console.log(`[sendReplacement] Successfully requeued envelope`);
  return true;
}

async function sendToDeadLetterQueue(
  adminSupabase: SupabaseClient<Database>,
  envelope: DiscordAsyncEnvelope,
  meta: { msg_id: number; enqueued_at: string },
  error: unknown,
  scope: Sentry.Scope
): Promise<boolean> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error ? error.constructor.name : "Unknown";
  const retryCount = envelope.retry_count ?? 0;
  console.log(
    `[sendToDeadLetterQueue] Sending message ${meta.msg_id} to DLQ after ${retryCount} retries. Error: ${errorMessage}`
  );

  // Send to DLQ queue
  try {
    const dlqResult = await adminSupabase.schema("pgmq_public").rpc("send", {
      queue_name: "discord_async_calls_dlq",
      message: envelope as unknown as Json,
      sleep_seconds: 0
    });
    if (dlqResult.error) {
      scope.setContext("dlq_send_error", {
        error_message: dlqResult.error.message,
        original_msg_id: meta.msg_id
      });
      Sentry.captureException(dlqResult.error, scope);
      return false;
    }
  } catch (e) {
    scope.setContext("dlq_send_exception", {
      error_message: e instanceof Error ? e.message : String(e),
      original_msg_id: meta.msg_id
    });
    Sentry.captureException(e, scope);
    return false;
  }

  // Record in DLQ tracking table
  try {
    const { error: insertError } = await adminSupabase.from("discord_async_worker_dlq_messages" as never).insert({
      original_msg_id: meta.msg_id,
      method: envelope.method,
      envelope: envelope as unknown as Json,
      error_message: errorMessage,
      error_type: errorType,
      retry_count: retryCount,
      last_error_context: {
        error_message: errorMessage,
        error_type: errorType,
        enqueued_at: meta.enqueued_at,
        failed_at: new Date().toISOString()
      } as unknown as Json,
      class_id: envelope.class_id,
      debug_id: envelope.debug_id,
      log_id: envelope.log_id
    });

    if (insertError) {
      scope.setContext("dlq_table_insert_error", {
        error_message: insertError.message,
        original_msg_id: meta.msg_id
      });
      Sentry.captureException(insertError, scope);
      return false;
    }
  } catch (e) {
    scope.setContext("dlq_table_insert_exception", {
      error_message: e instanceof Error ? e.message : String(e),
      original_msg_id: meta.msg_id
    });
    Sentry.captureException(e, scope);
    return false;
  }

  // Log to Sentry
  scope.setTag("dlq", "true");
  scope.setTag("retry_count", String(retryCount));
  scope.setContext("dead_letter_queue", {
    original_msg_id: meta.msg_id,
    method: envelope.method,
    retry_count: retryCount,
    error_message: errorMessage,
    error_type: errorType,
    enqueued_at: meta.enqueued_at,
    class_id: envelope.class_id,
    debug_id: envelope.debug_id,
    log_id: envelope.log_id
  });

  Sentry.captureMessage(`Message sent to dead letter queue after ${retryCount} retries: ${envelope.method}`, {
    level: "error",
    tags: {
      dlq: "true",
      method: envelope.method,
      retry_count: String(retryCount)
    }
  });

  return true;
}

type DiscordMembershipState = Database["public"]["Enums"]["discord_membership_state"];

/** Discord error code for "that user is not in this guild", which a removal is trying to achieve. */
const DISCORD_UNKNOWN_MEMBER = 10007;

/** Attempts for the membership-status write, which the caller has no way to retry. */
const STATUS_WRITE_ATTEMPTS = 3;

/**
 * Store a freshly created Discord invite, and return the URL the student will actually be given.
 *
 * Retried in place and compensated on failure, because by this point the invite exists in Discord
 * and every alternative is worse. Rethrowing sends the whole envelope back through the retry path,
 * which calls createGuildInvite again -- and `unique: true` means a new invite every time, so a
 * database hiccup left one live, unreachable invite per attempt. Swallowing left the student with no
 * link at all. Retrying the write repeats nothing external; revoking is what keeps a write that
 * genuinely cannot succeed from leaving anything behind.
 *
 * A lost race is not a failure: another worker stored a usable invite first, so this one revokes
 * what it made and hands back the stored URL. Both workers then describe the same invite.
 */
async function claimInvite(
  adminSupabase: SupabaseClient<Database>,
  invite: { userId: string; classId: number; guildId: string; code: string; url: string; expiresAt: Date },
  scope: Sentry.Scope
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= STATUS_WRITE_ATTEMPTS; attempt++) {
    const { data, error } = await adminSupabase.rpc("claim_discord_invite", {
      p_user_id: invite.userId,
      p_class_id: invite.classId,
      p_guild_id: invite.guildId,
      p_invite_code: invite.code,
      p_invite_url: invite.url,
      p_expires_at: invite.expiresAt.toISOString()
    });

    if (!error) {
      const row = data?.[0];
      if (row?.claimed === false && row.winning_invite_url && row.winning_invite_url !== invite.url) {
        console.log(`[claimInvite] Lost the invite race for user ${invite.userId}, revoking the surplus invite`);
        await revokeInvite(invite.code, scope);
        return row.winning_invite_url;
      }
      return row?.winning_invite_url ?? invite.url;
    }

    lastError = error;
    if (attempt < STATUS_WRITE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }

  // Out of attempts. The invite is real and nothing can reach it, so revoke it before giving up --
  // otherwise it sits in the guild for seven days, in no table and no UI.
  console.error(`[claimInvite] Could not store invite for user ${invite.userId}:`, lastError);
  scope.setContext("invite_storage_error", {
    user_id: invite.userId,
    class_id: invite.classId,
    error_message: lastError instanceof Error ? lastError.message : String(lastError)
  });
  await revokeInvite(invite.code, scope);
  throw lastError;
}

/**
 * Revoke an invite, or make it somebody's job to.
 *
 * A 404 is success -- the invite is already gone, which is the state this is trying to reach.
 * Anything else means a live invite nobody can reach, and swallowing it archived the message with
 * only a Sentry event behind it. Thrown as non-retriable because retrying re-runs createGuildInvite
 * and produces another one, so the choice is a dead-letter row naming this invite or a growing pile.
 */
async function revokeInvite(code: string, scope: Sentry.Scope): Promise<void> {
  try {
    await discord.deleteInvite(code, scope);
  } catch (e) {
    if (classifyDiscordError(e).httpStatus === 404) {
      console.log(`[revokeInvite] Invite ${code} was already gone`);
      return;
    }
    console.error(`[revokeInvite] Failed to revoke invite ${code}:`, e);
    scope.setContext("invite_revoke_failed", {
      invite_code: code,
      error_message: e instanceof Error ? e.message : String(e)
    });
    throw new NonRetriableWorkerError(`Discord invite ${code} is live and could not be revoked`, { cause: e });
  }
}

/**
 * Record where a user stands with a class's Discord server.
 *
 * This is what replaces retrying: a user who has not joined the server, or a bot that cannot invite
 * them, is a state to record and show an instructor, not an operation to attempt again next hour.
 */
async function recordMembershipStatus(
  adminSupabase: SupabaseClient<Database>,
  args: {
    classId: number;
    userId: string;
    guildId: string;
    state: DiscordMembershipState;
    discordErrorCode?: number;
    detail?: string;
    /**
     * The Discord account this observation was made against.
     *
     * The RPC discards the write when it no longer matches users.discord_id. A worker reads the
     * account, makes its Discord call, and by the time it records the result the user may have
     * relinked -- without this, the outcome for the old account would be written over the new one's
     * clean slate and an in_guild would exclude them from retries indefinitely.
     */
    observedDiscordId: string;
  },
  scope: Sentry.Scope
): Promise<void> {
  try {
    // Retried in place, because the caller cannot retry it. Every call site has already performed
    // the Discord side -- an invite created, a membership observed -- so throwing would repeat that
    // mutation, and swallowing on the first failure loses the outcome entirely. For a class reached
    // by a manual retry there is no hourly pass behind it: the row is the only record there will
    // ever be. This touches nothing but the database, so retrying is free of side effects.
    let lastError: unknown;
    for (let attempt = 1; attempt <= STATUS_WRITE_ATTEMPTS; attempt++) {
      const { error } = await adminSupabase.rpc("record_discord_membership_status", {
        p_class_id: args.classId,
        p_user_id: args.userId,
        p_guild_id: args.guildId,
        p_state: args.state,
        p_discord_error_code: args.discordErrorCode,
        p_detail: args.detail,
        p_observed_discord_id: args.observedDiscordId
      });

      if (!error) {
        console.log(
          `[recordMembershipStatus] Recorded ${args.state} for user ${args.userId} in class ${args.classId} (guild ${args.guildId})`
        );
        return;
      }

      lastError = error;
      if (attempt < STATUS_WRITE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    throw lastError;
  } catch (e) {
    // Failing to record the state must not turn a terminal outcome back into a retry loop, so this
    // is reported and swallowed.
    console.error(`[recordMembershipStatus] Failed to record ${args.state}:`, e);
    scope.setContext("membership_status_error", {
      class_id: args.classId,
      user_id: args.userId,
      guild_id: args.guildId,
      state: args.state,
      error_message: e instanceof Error ? e.message : String(e)
    });
    Sentry.captureException(e, scope);
  }
}

/** Resolve a Discord snowflake to a Pawtograder user id, which is what the status table keys on. */
async function lookupUserIdByDiscordId(
  adminSupabase: SupabaseClient<Database>,
  discordId: string
): Promise<string | null> {
  const { data, error } = await adminSupabase.from("users").select("user_id").eq("discord_id", discordId).single();
  if (error || !data) {
    console.warn(`[lookupUserIdByDiscordId] No user found for discord_id=${discordId}`, error);
    return null;
  }
  return data.user_id;
}

/**
 * What became of a terminal failure, which decides how loudly it is reported.
 *
 * `recorded` is the membership case this change exists for: the outcome is written to
 * discord_membership_status and shown on the roster, so an instructor already has it and there is
 * nothing for an operator to do. Those arrive continuously for as long as a student stays out of a
 * server -- 30,332 of them buried the dead letter queue -- so they stay a grouped warning.
 *
 * `dead-lettered` is everything else: a role that cannot be created, a message that cannot be sent.
 * Nothing in the product records those, so the DLQ row is the only durable evidence, and its growth
 * is what PawtograderDiscordDLQGrowing watches.
 */
type TerminalDisposition = "recorded" | "dead-lettered";

/**
 * Report a failure that no number of retries can fix.
 *
 * The fingerprint is explicit so every occurrence of a cause lands in one issue rather than one per
 * user or guild, which is what made the old dead-letter flood unreadable.
 */
function reportTerminalFailure(
  envelope: DiscordAsyncEnvelope,
  meta: { msg_id: number; enqueued_at: string },
  error: unknown,
  classification: { httpStatus?: number; code?: number; reason?: string },
  parentScope: Sentry.Scope,
  disposition: TerminalDisposition
) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.log(
    `[reportTerminalFailure] ${envelope.method} failed terminally (${classification.reason ?? "unclassified"}), not retrying (${disposition}): ${errorMessage}`
  );

  // Cloned, so the terminal fingerprint and level cannot leak into any later event captured on the
  // caller's scope — including the ones from the add_member_role path, which carries on after
  // reporting a failed invite.
  const scope = parentScope.clone();
  scope.setTag("terminal", "true");
  scope.setTag("terminal_disposition", disposition);
  scope.setTag("discord_error_code", String(classification.code ?? "none"));
  scope.setContext("terminal_failure", {
    method: envelope.method,
    reason: classification.reason,
    http_status: classification.httpStatus,
    discord_error_code: classification.code,
    error_message: errorMessage,
    retry_count: envelope.retry_count ?? 0,
    original_msg_id: meta.msg_id,
    enqueued_at: meta.enqueued_at,
    class_id: envelope.class_id,
    disposition
  });
  scope.setFingerprint([
    "discord-terminal",
    envelope.method,
    String(classification.code ?? classification.httpStatus ?? "unknown")
  ]);
  // A dead-lettered failure is waiting for a person; a recorded one is already in front of the
  // instructor who can act on it.
  scope.setLevel(disposition === "dead-lettered" ? "error" : "warning");

  Sentry.captureMessage(
    `Discord ${envelope.method} cannot succeed and will not be retried: ${classification.reason ?? errorMessage}`,
    scope
  );
}

// ============================================================================
// Per-guild circuit breaker
// ============================================================================

/*
 * Why the breaker is keyed on the guild, and why it matters more here than the org breaker does in
 * github-async-worker.
 *
 * The GitHub worker authenticates as a per-org installation, so an org with a broken installation
 * exhausts its own rate limit and nobody else's. Discord is the opposite: ONE bot token serves every
 * course on the platform, and Discord's 50-requests-per-second primary limit is charged against that
 * token, not against the guild. A single misconfigured guild -- bot removed, channel-view permission
 * revoked, stale discord_server_id -- therefore turns every enrolled student into a 403/50001 and
 * spends the whole platform's Discord budget rediscovering the same fact. 557 of the 594 dead-letter
 * rows on 2026-08-11 were exactly that: one guild's 403, once per enrolled student.
 *
 * So a storm of permission errors from one guild parks that guild, and every other course keeps its
 * share of the shared token.
 */

/** The only breaker scope in use. Matches the `scope` column written by open_discord_circuit. */
const DISCORD_CIRCUIT_SCOPE_GUILD = "guild";

/** Floor delay applied to an envelope deferred by an open breaker, matching the GitHub worker. */
const CIRCUIT_OPEN_REQUEUE_SECONDS = 180;

/**
 * Ceiling on a single circuit deferral, matching the six-hour cap open_discord_circuit escalates to.
 * A deferral is meant to end when the breaker's window ends, so anything longer than the longest
 * window the breaker can set would be a stale `open_until` rather than a real wait.
 */
const CIRCUIT_MAX_REQUEUE_SECONDS = 21600;

/**
 * How many times an envelope may be deferred by an open breaker before it is dead-lettered.
 *
 * Counted separately from `retry_count` on purpose. A deferral is not a failed attempt -- no Discord
 * call was made and nothing went wrong with this message -- and sharing the ordinary retry budget
 * meant a guild parked for the breaker's own 30-minute window burned all five retries in 15 minutes
 * and dead-lettered work the breaker was successfully protecting. Ten breaker windows is days of
 * patience at the six-hour cap, and still a bound: a guild nobody ever fixes ends up as DLQ evidence
 * rather than an envelope circulating forever.
 */
const MAX_CIRCUIT_DEFERRALS = 10;

/**
 * An envelope carrying the circuit-deferral counter.
 *
 * Declared here rather than on DiscordAsyncEnvelope because only this worker writes or reads it: it
 * is set when the worker requeues its own message and is absent from every enqueue the rest of the
 * platform performs.
 */
type CircuitDeferrableEnvelope = DiscordAsyncEnvelope & { circuit_deferrals?: number };

/** How long to park an envelope whose guild is open, given the breaker's own deadline. */
function circuitDeferralSeconds(openUntil: string | null | undefined): number {
  if (!openUntil) return CIRCUIT_OPEN_REQUEUE_SECONDS;
  const remainingMs = new Date(openUntil).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) return CIRCUIT_OPEN_REQUEUE_SECONDS;
  // A few seconds past the deadline, so the envelope does not come back to a breaker that is still
  // open by a rounding error and spend a deferral on it.
  const untilOpenEnds = Math.ceil(remainingMs / 1000) + 5;
  return Math.min(CIRCUIT_MAX_REQUEUE_SECONDS, Math.max(CIRCUIT_OPEN_REQUEUE_SECONDS, untilOpenEnds));
}

/** Window and count that define "a storm" rather than one misconfigured channel. */
const PERMISSION_ERROR_WINDOW_MINUTES = 5;
const PERMISSION_ERROR_TRIP_THRESHOLD = 10;

/** How long a tripped guild is parked. Escalated further by open_discord_circuit on repeat trips. */
const CIRCUIT_OPEN_SECONDS = 1800;

type UntypedRpcResult<T> = { data: T | null; error: { message: string } | null };

/**
 * Call an RPC that is not in the generated `Database` type yet.
 *
 * The circuit-breaker RPCs arrive in the same change as this code, and SupabaseTypes.d.ts is
 * regenerated from the database rather than from the migration, so it does not know them until a
 * `npm run client-local` after this migration is applied. Same escape hatch the metrics function
 * uses for vacuum_health_check, kept in one place instead of an `as never` per call site.
 */
function untypedRpc<T>(
  adminSupabase: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown>
): Promise<UntypedRpcResult<T>> {
  const client = adminSupabase.schema("public") as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => Promise<UntypedRpcResult<T>>;
  };
  return client.rpc(fn, args);
}

/**
 * Cache of class -> guild, for the methods whose args do not name a guild.
 *
 * send_message and update_message carry only a channel_id, so the guild has to come from the class.
 * Without a cache that is one extra round trip per message envelope on the hot path -- every help
 * request, every regrade, every discussion notification -- purely to consult a breaker that is
 * closed 99.9% of the time. One minute of staleness only affects which key a breaker is read under,
 * and a class that changes its Discord server has its queued work dropped by the per-handler
 * guild checks anyway.
 */
const GUILD_BY_CLASS_TTL_MS = 60_000;
const guildByClass = new Map<number, { guildId: string | null; cachedAt: number }>();

/** The guild an envelope's work lands in, or undefined when it is not guild-scoped. */
async function resolveGuildId(
  adminSupabase: SupabaseClient<Database>,
  envelope: DiscordAsyncEnvelope
): Promise<string | undefined> {
  // register_commands is application-global and batch_role_sync spans every guild, so neither is
  // gated: parking them on one guild's behalf would stop the sweep that serves all the others.
  if (envelope.method === "register_commands" || envelope.method === "batch_role_sync") return undefined;

  const args = envelope.args as { guild_id?: string; channel_id?: string };
  if (typeof args?.guild_id === "string" && args.guild_id !== "") return args.guild_id;

  if (!envelope.class_id) return undefined;

  // A channel-scoped envelope with no guild_id of its own cannot be attributed to the class's
  // *current* guild without checking that the channel still belongs to it.
  //
  // The case that matters: a class moves from guild A to guild B while send_message /
  // update_message envelopes for A's channels are still queued. Those envelopes carry only a
  // channel_id, so resolving through class_id would hand them B's guild id -- and then ten stale
  // 403s from A would open B's breaker and park the fresh role and channel work for the server the
  // course just moved to. Blaming a guild for another guild's failures is worse than not gating
  // these envelopes at all.
  //
  // clear_discord_roles_on_server_change deletes discord_channels on a move, so a channel that is
  // still tracked for this class is one in the class's present guild, and a stale one has no row.
  if (typeof args?.channel_id === "string" && args.channel_id !== "") {
    const { data: tracked, error: trackedError } = await adminSupabase
      .from("discord_channels")
      .select("id")
      .eq("class_id", envelope.class_id)
      .eq("discord_channel_id", args.channel_id)
      .maybeSingle();
    if (trackedError) {
      console.warn(`[resolveGuildId] Could not verify channel ${args.channel_id}:`, trackedError);
      return undefined;
    }
    if (!tracked) {
      console.log(
        `[resolveGuildId] Channel ${args.channel_id} is not tracked for class ${envelope.class_id}; not attributing this envelope to the class's current guild`
      );
      return undefined;
    }
  }

  const cached = guildByClass.get(envelope.class_id);
  if (cached && Date.now() - cached.cachedAt < GUILD_BY_CLASS_TTL_MS) {
    return cached.guildId ?? undefined;
  }

  const { data, error } = await adminSupabase
    .from("classes")
    .select("discord_server_id")
    .eq("id", envelope.class_id)
    .maybeSingle();
  if (error) {
    // Not fatal, and deliberately not cached: an unreadable class means the breaker cannot be
    // consulted for this envelope, which is strictly better than failing the operation over it.
    console.warn(`[resolveGuildId] Could not resolve guild for class ${envelope.class_id}:`, error);
    return undefined;
  }

  const guildId = data?.discord_server_id ?? null;
  guildByClass.set(envelope.class_id, { guildId, cachedAt: Date.now() });
  return guildId ?? undefined;
}

/** Whether this guild is currently parked. */
async function isGuildCircuitOpen(
  adminSupabase: SupabaseClient<Database>,
  guildId: string,
  scope: Sentry.Scope
): Promise<{ open: boolean; reason?: string; openUntil?: string | null }> {
  const { data, error } = await untypedRpc<Array<{ state?: string; open_until?: string | null }>>(
    adminSupabase,
    "get_discord_circuit",
    { p_scope: DISCORD_CIRCUIT_SCOPE_GUILD, p_key: guildId }
  );
  if (error) {
    // Fail open. A breaker that cannot be read must not become a breaker that blocks everything.
    console.warn(`[isGuildCircuitOpen] Could not read circuit for guild ${guildId}: ${error.message}`);
    Sentry.addBreadcrumb({ message: `Discord circuit read failed for guild ${guildId}`, level: "warning" });
    return { open: false };
  }
  const row = Array.isArray(data) && data.length > 0 ? data[0] : undefined;
  if (!row || row.state !== "open") return { open: false };
  if (row.open_until && new Date(row.open_until) <= new Date()) return { open: false };
  scope.setTag("circuit_open_until", row.open_until ?? "indefinite");
  return {
    open: true,
    reason: row.open_until ? `open until ${row.open_until}` : "open",
    openUntil: row.open_until ?? null
  };
}

/**
 * Count one bot-permission failure against a guild, and park the guild if they are a storm.
 *
 * Only permission and configuration failures are counted, via the shared classifier: a 429 is
 * handled by the existing backoff and a 404 on one member says nothing about the guild. Counting
 * everything would park a healthy guild for one student's deleted account.
 *
 * Cannot throw, for the same reason isGuildCircuitOpen fails open. Both call sites are error paths:
 * one is the outer catch of processEnvelope, where a rejection here would escape the catch entirely
 * and leave the message unarchived with no requeue and no dead-letter row, and the other is the
 * cannot_invite branch, where it would replace a recorded terminal failure with a bookkeeping error
 * that then gets classified retriable. Losing a breaker sample is the cheaper failure.
 */
async function noteGuildPermissionFailure(
  adminSupabase: SupabaseClient<Database>,
  guildId: string,
  method: string,
  error: unknown,
  scope: Sentry.Scope
): Promise<void> {
  try {
    await recordGuildPermissionFailure(adminSupabase, guildId, method, error, scope);
  } catch (bookkeepingError) {
    // Breadcrumb rather than an event: this is attached to whatever the original failure captures,
    // and on its own it is not worth an issue of its own.
    console.warn(`[noteGuildPermissionFailure] Breaker accounting failed for guild ${guildId}:`, bookkeepingError);
    Sentry.addBreadcrumb({
      message: `Discord breaker accounting failed for guild ${guildId}: ${
        bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError)
      }`,
      level: "warning"
    });
  }
}

async function recordGuildPermissionFailure(
  adminSupabase: SupabaseClient<Database>,
  guildId: string,
  method: string,
  error: unknown,
  scope: Sentry.Scope
): Promise<void> {
  const classification = classifyDiscordError(error);
  const errorMessage = error instanceof Error ? error.message : String(error);

  const recorded = await untypedRpc<null>(adminSupabase, "record_discord_async_error", {
    p_guild_id: guildId,
    p_method: method,
    p_error_data: {
      method,
      error_message: errorMessage,
      error_type: error instanceof Error ? error.constructor.name : "Unknown",
      http_status: classification.httpStatus ?? null,
      discord_error_code: classification.code ?? null
    }
  });
  if (recorded.error) {
    // Reported and swallowed: losing a breaker sample must not change the outcome of the operation
    // that produced it.
    console.warn(`[noteGuildPermissionFailure] Could not record error for guild ${guildId}: ${recorded.error.message}`);
    return;
  }

  const counted = await untypedRpc<number>(adminSupabase, "check_discord_error_threshold", {
    p_guild_id: guildId,
    p_window_minutes: PERMISSION_ERROR_WINDOW_MINUTES
  });
  if (counted.error) {
    console.warn(`[noteGuildPermissionFailure] Could not count errors for guild ${guildId}: ${counted.error.message}`);
    return;
  }

  const errorCount = typeof counted.data === "number" ? counted.data : 0;
  if (errorCount < PERMISSION_ERROR_TRIP_THRESHOLD) return;

  const opened = await untypedRpc<number>(adminSupabase, "open_discord_circuit", {
    p_scope: DISCORD_CIRCUIT_SCOPE_GUILD,
    p_key: guildId,
    p_event: "permission_storm",
    p_retry_after_seconds: CIRCUIT_OPEN_SECONDS,
    p_reason:
      `${errorCount} Discord permission errors in ${PERMISSION_ERROR_WINDOW_MINUTES} minutes ` +
      `(latest: ${method} -> ${classification.reason ?? errorMessage})`
  });
  if (opened.error) {
    console.error(`[noteGuildPermissionFailure] Could not open circuit for guild ${guildId}: ${opened.error.message}`);
    Sentry.captureMessage(`Failed to open Discord circuit for guild ${guildId}`, { level: "error" });
    return;
  }

  const tripCount = typeof opened.data === "number" ? opened.data : 0;
  const tripScope = scope.clone();
  tripScope.setTag("circuit_breaker_reason", "permission_storm");
  tripScope.setTag("guild_id", guildId);
  tripScope.setContext("discord_circuit_trip", {
    guild_id: guildId,
    method,
    error_count: errorCount,
    window_minutes: PERMISSION_ERROR_WINDOW_MINUTES,
    open_seconds: CIRCUIT_OPEN_SECONDS,
    trip_count: tripCount,
    latest_error: errorMessage
  });
  // One issue per guild, however many envelopes hit the threshold at once.
  tripScope.setFingerprint(["discord-circuit-open", guildId]);
  tripScope.setLevel("error");
  Sentry.captureMessage(
    `Discord circuit breaker open for guild ${guildId}: ${errorCount} permission errors in ` +
      `${PERMISSION_ERROR_WINDOW_MINUTES} minutes. A Discord server admin needs to restore the bot's access.`,
    tripScope
  );
}

// ============================================================================
// Slash Command Registration
// ============================================================================

/** Deadline for the raw membership-check fetch, matching DiscordWrapper's own fetch timeout. */
const MEMBERSHIP_CHECK_TIMEOUT_MS = 10000;

/**
 * A failure the worker itself knows cannot be retried, whatever Discord said.
 *
 * `classifyDiscordError` reads Discord's own status and codes, so it cannot see a condition the
 * handler created -- a Discord resource that exists but could neither be recorded nor removed, where
 * another attempt would make a second one before failing the same way. Following the GitHub worker's
 * `NonRetryableGitHubError`, which the outer catch branches on with `instanceof`.
 */
class NonRetriableWorkerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "NonRetriableWorkerError";
  }
}

/**
 * How many membership checks may tell us nothing in a row before the run is abandoned.
 *
 * One inconclusive lookup is ordinary and should not cost the rest of the roster its sync. Three in
 * a row is an outage or a bad token, and continuing means one failing request per enrollment -- at
 * up to MEMBERSHIP_CHECK_TIMEOUT_MS each -- before archiving as though the sweep had succeeded.
 */
const MAX_CONSECUTIVE_UNKNOWN = 3;

const SLASH_COMMANDS = [
  {
    name: "sync-roles",
    description: "Sync your Pawtograder roles in this Discord server",
    type: 1, // CHAT_INPUT (slash command)
    dm_permission: false,
    default_member_permissions: null,
    contexts: [0], // 0 = GUILD (server only)
    integration_types: [0] // 0 = GUILD_INSTALL
  }
];

type CommandResult = {
  command: string;
  success: boolean;
  id?: string;
  error?: string;
};

async function registerSlashCommands(scope: Sentry.Scope): Promise<CommandResult[]> {
  const applicationId = Deno.env.get("DISCORD_APPLICATION_ID");
  const botToken = Deno.env.get("DISCORD_BOT_TOKEN");

  if (!applicationId || !botToken) {
    console.error("[registerSlashCommands] Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN");
    return [{ command: "*", success: false, error: "Missing Discord configuration" }];
  }

  const results: CommandResult[] = [];

  for (const command of SLASH_COMMANDS) {
    try {
      const response = await fetch(`${discordApiBase()}/applications/${applicationId}/commands`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(command)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[registerSlashCommands] Failed to register ${command.name}:`, errorText);
        results.push({ command: command.name, success: false, error: `${response.status}: ${errorText}` });
      } else {
        const data = await response.json();
        console.log(`[registerSlashCommands] Registered ${command.name} with ID ${data.id}`);
        results.push({ command: command.name, success: true, id: data.id });
      }
    } catch (error) {
      console.error(`[registerSlashCommands] Exception registering ${command.name}:`, error);
      results.push({
        command: command.name,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}

// ============================================================================
// Batch Role Sync
// ============================================================================

type UserRoleRecord = {
  user_id: string;
  class_id: number;
  role: Database["public"]["Enums"]["app_role"];
  discord_id: string;
  discord_server_id: string;
  /** Whether this course has opted in to student Discord invitations. Defaults false. */
  student_join_enabled: boolean;
};

type BatchSyncResult = {
  summary: {
    total: number;
    synced: number;
    not_in_guild: number;
    invite_created: number;
    cannot_invite: number;
    errors: number;
  };
};

type MembershipCheck =
  | { result: "member" }
  | { result: "not_member" }
  /** The bot cannot read this guild at all, which no student can resolve. */
  | { result: "forbidden"; status: number }
  /** Discord has no such guild: the class's discord_server_id is wrong, or the bot was removed. */
  | { result: "unknown_guild" }
  /** Discord is rate limiting this route. Nothing else in the run will fare better. */
  | { result: "rate_limited"; retryAfterMs: number }
  /** The check failed for a reason that says nothing about the user. */
  | { result: "unknown"; cause: string; status?: number };

/**
 * Whether the bot sees a user in a guild.
 *
 * `unknown` and `forbidden` are kept apart from `not_member` on purpose. A network error or a 5xx says
 * nothing about the user, and treating it as "not a member" would record a wrong state and hand the
 * student an invite they do not need. A 403 says something about the bot.
 */
async function checkGuildMembership(
  guildId: string,
  discordUserId: string,
  botToken: string
): Promise<MembershipCheck> {
  // This is a raw fetch rather than a DiscordWrapper call, so it has to supply its own deadline:
  // without one a single stalled connection blocks the whole per-record loop, and because the batch
  // is itself a queue message, pgmq redelivers it while the first run is still hanging.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMBERSHIP_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${discordApiBase()}/guilds/${guildId}/members/${discordUserId}`, {
      method: "GET",
      headers: { Authorization: `Bot ${botToken}` },
      signal: controller.signal
    });
    // Read before the body is discarded below. Discord sends seconds, possibly fractional.
    const retryAfterHeader = response.status === 429 ? response.headers.get("retry-after") : null;

    // A 404 is the one status whose body decides what it means: 10007 Unknown Member is about this
    // user, 10004 Unknown Guild is about the class's discord_server_id being wrong or the bot having
    // been removed. Read only for 404, so the ordinary paths keep discarding the body untouched.
    let notFoundCode: number | undefined;
    if (response.status === 404) {
      try {
        const parsed = (await response.json()) as { code?: number };
        notFoundCode = typeof parsed?.code === "number" ? parsed.code : undefined;
      } catch {
        // Unparseable body: fall through as a user-scoped miss, which is the safer reading. Treating
        // it as an unknown guild would take the whole class off the roster on a malformed response.
        notFoundCode = undefined;
      }
    } else {
      // The body is never read on the other branches. Left dangling it holds the connection out of
      // the pool for one roster's worth of responses at a time, and Deno warns that response bodies
      // were not consumed. Cancelling releases it immediately.
      await response.body?.cancel();
    }

    if (response.status === 200) return { result: "member" };
    if (response.status === 404) {
      // Cached at guild scope by the caller. Read as not_member it cost one doomed lookup per
      // enrolled user per hour for a guild Discord does not have: only the follow-on invite was
      // short-circuited, because guildInviteFailures is consulted after the membership cache.
      if (notFoundCode === DISCORD_UNKNOWN_GUILD) return { result: "unknown_guild" };
      return { result: "not_member" };
    }
    if (response.status === 429) {
      const parsed = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : Number.NaN;
      // A minute when Discord does not say. Guessing short would resume straight back into the
      // window; the caller abandons the run either way, so erring long costs only a later retry.
      const retryAfterMs = Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed * 1000) : 60_000;
      return { result: "rate_limited", retryAfterMs };
    }
    // 403 only. A 401 means the bot token is wrong or mid-rotation, which the classifier treats as
    // retriable — calling it `forbidden` here would record every candidate as cannot_invite and tell
    // instructors to change server permissions that are not the problem.
    if (response.status === 403) return { result: "forbidden", status: response.status };
    return { result: "unknown", cause: `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { result: "unknown", cause: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create and store a Discord invite for a user who is not in the guild.
 *
 * `guildInviteFailures` carries a guild that has already failed this run. Without it a bot that
 * cannot list channels produces one failing invite attempt per enrolled user per hour — 557 of the
 * 594 dead-letter rows on 2026-08-11 were that one 403, repeated. One attempt per guild per run is
 * enough to learn the same thing.
 */
async function ensureInviteForUser(
  adminSupabase: SupabaseClient<Database>,
  record: UserRoleRecord,
  guildInviteFailures: Map<string, { code?: number; reason: string }>,
  scope: Sentry.Scope
): Promise<"created" | "not_offered" | "cannot_invite" | "error"> {
  // Checked before the cached guild failure below. A staff invite that failed earlier in this run
  // populates guildInviteFailures for the guild, and every later student would then be recorded
  // cannot_invite -- a red permissions alert for invitations the course has deliberately switched
  // off, with the outcome depending on the order candidates happen to arrive in.
  if (!record.student_join_enabled && record.role === "student") {
    await recordMembershipStatus(
      adminSupabase,
      {
        classId: record.class_id,
        userId: record.user_id,
        observedDiscordId: record.discord_id,
        guildId: record.discord_server_id,
        state: "not_joined",
        detail: "Student Discord invitations are turned off for this course"
      },
      scope
    );
    return "not_offered";
  }

  const knownFailure = guildInviteFailures.get(record.discord_server_id);
  if (knownFailure) {
    await recordMembershipStatus(
      adminSupabase,
      {
        classId: record.class_id,
        userId: record.user_id,
        observedDiscordId: record.discord_id,
        guildId: record.discord_server_id,
        state: "cannot_invite",
        discordErrorCode: knownFailure.code,
        detail: knownFailure.reason
      },
      scope
    );
    return "cannot_invite";
  }

  // Re-read rather than trusting the snapshot the candidate query took at the start of the run. A
  // large roster spends minutes in this loop, and an instructor who switches the feature off during
  // it would otherwise keep having invitations created for the rest of the sweep. The envelope path
  // already reads the flag immediately before doing invitation work.
  const { data: stillEnabled, error: flagRecheckError } = await adminSupabase.rpc("discord_student_join_enabled", {
    p_class_id: record.class_id
  });
  if (flagRecheckError) {
    throw flagRecheckError;
  }
  if (!stillEnabled && record.role === "student") {
    await recordMembershipStatus(
      adminSupabase,
      {
        classId: record.class_id,
        userId: record.user_id,
        observedDiscordId: record.discord_id,
        guildId: record.discord_server_id,
        state: "not_joined",
        detail: "Student Discord invitations are turned off for this course"
      },
      scope
    );
    return "not_offered";
  }

  try {
    // Same courtesy delay the membership check uses. createGuildInvite is two Discord calls (list
    // channels, then create), and a class where nobody has joined yet reaches here once per enrolled
    // student back to back — enough to rate-limit the bot for every other class in the same run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const invite = await discord.createGuildInvite(record.discord_server_id, 604800, 5, scope); // 7 days, 5 uses
    const expiresAt = new Date(Date.now() + 604800 * 1000);

    const claimedUrl = await claimInvite(
      adminSupabase,
      {
        userId: record.user_id,
        classId: record.class_id,
        guildId: record.discord_server_id,
        code: invite.code,
        url: invite.url,
        expiresAt
      },
      scope
    );

    await recordMembershipStatus(
      adminSupabase,
      {
        classId: record.class_id,
        userId: record.user_id,
        observedDiscordId: record.discord_id,
        guildId: record.discord_server_id,
        state: "not_joined",
        detail: `Invite ${claimedUrl} is waiting to be used`
      },
      scope
    );
    return "created";
  } catch (error) {
    const classification = classifyDiscordError(error);
    const reason = error instanceof Error ? error.message : String(error);

    if (classification.terminal) {
      // Any terminal cause belongs here, not just a permission one: Unknown Guild (10004), Unknown
      // Channel (10003) and a malformed request are equally unfixable by retrying, and letting them
      // fall through to the error path below would repeat the same doomed call every hour.
      // isBotPermissionProblem only decides how the detail is worded.
      const detail = isBotPermissionProblem(error)
        ? reason
        : `Discord rejected the invite request (${classification.reason ?? "terminal error"}): ${reason}`;

      // Remember it for the rest of this run so the remaining users in this guild cost nothing, and
      // record it against the user so an instructor sees who is stuck.
      guildInviteFailures.set(record.discord_server_id, { code: classification.code, reason: detail });
      await recordMembershipStatus(
        adminSupabase,
        {
          classId: record.class_id,
          userId: record.user_id,
          observedDiscordId: record.discord_id,
          guildId: record.discord_server_id,
          state: "cannot_invite",
          discordErrorCode: classification.code,
          detail
        },
        scope
      );
      return "cannot_invite";
    }

    // Retriable, so abandon the run rather than working through the roster. A 429, a timeout, a
    // 401 or a Discord 5xx is a condition affecting the bot, not this student: returning "error"
    // here let the caller move on and make the same failing call for every remaining candidate,
    // discarding the Retry-After each time. Rethrown, it reaches processEnvelope's non-terminal
    // path, which requeues the whole batch with backoff. Same reasoning as the 429 on the
    // membership lookup.
    console.error(`[ensureInviteForUser] Invite creation failed for guild ${record.discord_server_id}:`, error);
    scope.setContext("invite_creation_error", {
      guild_id: record.discord_server_id,
      class_id: record.class_id,
      error_message: reason
    });
    throw error;
  }
}

async function processBatchRoleSync(
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope
): Promise<BatchSyncResult> {
  const emptySummary = { total: 0, synced: 0, not_in_guild: 0, invite_created: 0, cannot_invite: 0, errors: 1 };

  const botToken = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!botToken) {
    console.error("[processBatchRoleSync] Missing DISCORD_BOT_TOKEN");
    return { summary: emptySummary };
  }

  // Candidates come from an RPC rather than a client-side query so the active-class scoping lives in
  // one place. This query used to run against every class that had ever had a Discord server: 76% of
  // classes have ended, and their students were re-checked every hour forever.
  const { data, error } = await adminSupabase.rpc("get_discord_role_sync_candidates");

  if (error) {
    console.error("[processBatchRoleSync] Error fetching candidates:", error);
    scope.setContext("batch_sync_error", { error: error.message });
    Sentry.captureException(error, scope);
    return { summary: emptySummary };
  }

  const records: UserRoleRecord[] = (data ?? []).flatMap((record) =>
    record.discord_id && record.discord_server_id
      ? [
          {
            user_id: record.user_id,
            class_id: record.class_id,
            role: record.role,
            discord_id: record.discord_id,
            discord_server_id: record.discord_server_id,
            // The RPC computes this per class; false unless the course has opted in.
            student_join_enabled: record.student_join_enabled === true
          }
        ]
      : []
  );

  console.log(`[processBatchRoleSync] Found ${records.length} user-role records in active classes to process`);

  const summary = {
    total: records.length,
    synced: 0,
    not_in_guild: 0,
    invite_created: 0,
    cannot_invite: 0,
    errors: 0
  };

  // Cache membership checks per guild/user
  const membershipCache = new Map<string, MembershipCheck>();
  // A 403 is a fact about the guild, not the user, so it is cached at guild scope. Keyed per user it
  // would still cost one failing request per enrolled student: hundreds an hour for one broken guild,
  // which is the same unbounded work this change exists to remove.
  const forbiddenGuilds = new Map<string, number>();
  // Likewise guild scope, and for the same reason. A 404 carrying Unknown Guild says the class's
  // discord_server_id names a server Discord does not have, so no lookup for any other student in it
  // can do anything but 404 too.
  const unknownGuilds = new Set<string>();
  // Guilds whose invite creation has already failed this run, so the failure costs one call, not one
  // call per enrolled student.
  const guildInviteFailures = new Map<string, { code?: number; reason: string }>();
  // Consecutive membership checks that told us nothing. Distinguishes one bad request from an
  // outage; see the `unknown` branch below.
  let consecutiveUnknown = 0;

  for (const record of records) {
    const cacheKey = `${record.discord_server_id}:${record.discord_id}`;
    const knownForbidden = forbiddenGuilds.get(record.discord_server_id);
    const knownUnknownGuild = unknownGuilds.has(record.discord_server_id);

    // Check membership if not cached, and never for a guild already known to be unreachable this run.
    if (knownForbidden === undefined && !knownUnknownGuild && !membershipCache.has(cacheKey)) {
      const membership = await checkGuildMembership(record.discord_server_id, record.discord_id, botToken);

      // Abandon the whole run. This route is rate limited per bot, not per guild or per user, so
      // every remaining candidate would get the same 429 after a 50ms pause -- hundreds of requests
      // that deepen the window rather than wait it out, and none of them learn anything. Thrown so
      // the envelope takes processEnvelope's existing rate-limit path: the message is requeued with
      // backoff derived from the delay Discord asked for, instead of the batch reporting success and
      // archiving with most of the roster unchecked. The message wording is what detectRateLimit and
      // parseRetryAfterSeconds match on.
      if (membership.result === "rate_limited") {
        throw new Error(
          `Discord rate limit: retry after ${membership.retryAfterMs}ms on the guild member lookup ` +
            `(abandoned batch role sync after ${summary.synced + summary.not_in_guild} of ${records.length} records)`
        );
      }

      membershipCache.set(cacheKey, membership);
      if (membership.result === "forbidden") {
        forbiddenGuilds.set(record.discord_server_id, membership.status);
      }
      if (membership.result === "unknown_guild") {
        unknownGuilds.add(record.discord_server_id);
      }
      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const membership: MembershipCheck =
      knownForbidden !== undefined
        ? { result: "forbidden", status: knownForbidden }
        : knownUnknownGuild
          ? { result: "unknown_guild" }
          : membershipCache.get(cacheKey)!;

    if (membership.result === "unknown_guild") {
      // Recorded per user, unlike the 403 above. A 403 says nothing about whether a student joined,
      // but a guild Discord does not have holds nobody: no invite can be created into it and no role
      // can be applied, so cannot_invite is accurate for every enrolled user rather than a guess.
      // remediationFor() already words 10004 as a wrong server ID rather than a missing permission.
      const reason = `Discord has no server with the ID configured for this course (${record.discord_server_id})`;
      guildInviteFailures.set(record.discord_server_id, { code: DISCORD_UNKNOWN_GUILD, reason });
      await recordMembershipStatus(
        adminSupabase,
        {
          classId: record.class_id,
          userId: record.user_id,
          observedDiscordId: record.discord_id,
          guildId: record.discord_server_id,
          state: "cannot_invite",
          discordErrorCode: DISCORD_UNKNOWN_GUILD,
          detail: reason
        },
        scope
      );
      summary.cannot_invite++;
      continue;
    }

    if (membership.result === "unknown") {
      // Nothing was learned about this user, so nothing is recorded and nothing is enqueued.
      summary.errors++;

      // A 401 is bot-wide: the token is wrong or mid-rotation, so no candidate in any class will
      // fare better. Abandoning immediately is the difference between one failed request and one
      // per enrollment, every hour, until someone notices.
      if (membership.status === 401) {
        throw new Error(`Discord rejected the bot token (401) on the guild member lookup: ${membership.cause}`);
      }

      // Anything else transient -- a 5xx, a network error, a 10s timeout -- is only bot-wide if it
      // keeps happening. Three in a row is enough to stop rather than spend the rest of the roster
      // discovering the same outage one 10-second timeout at a time. Thrown so processEnvelope
      // requeues the batch with backoff instead of archiving a sweep that checked almost nobody.
      consecutiveUnknown++;
      if (consecutiveUnknown >= MAX_CONSECUTIVE_UNKNOWN) {
        throw new Error(
          `Discord membership lookups failed ${consecutiveUnknown} times in a row (${membership.cause}); ` +
            `abandoned batch role sync after ${summary.synced + summary.not_in_guild} of ${records.length} records`
        );
      }
      continue;
    }

    // Any decisive answer clears the run of failures, so only a genuine streak trips the check above.
    consecutiveUnknown = 0;

    if (membership.result === "forbidden") {
      // The bot cannot read this guild's members, so it certainly cannot invite anyone into it.
      // Remember the guild so the invite path below does not try either, and let the one-per-run
      // Sentry summary below carry the signal.
      //
      // Deliberately NOT recorded against the student. A 403 on the member lookup is a fact about
      // the bot's access to the guild and says nothing about any individual user, exactly as for
      // `unknown` above. Writing cannot_invite here would overwrite the in_guild rows of students
      // who *are* in the server, and the roster would then tell an instructor that students who
      // joined weeks ago "cannot join until a Discord server admin grants it".
      const reason = `Discord returned ${membership.status} for the guild member lookup; the bot cannot read this server`;
      guildInviteFailures.set(record.discord_server_id, { reason });
      summary.cannot_invite++;
      continue;
    }

    if (membership.result === "member") {
      // User is in guild, enqueue role sync
      try {
        const { error: syncError } = await adminSupabase.rpc("enqueue_discord_role_sync", {
          p_user_id: record.user_id,
          p_class_id: record.class_id,
          p_role: record.role,
          p_action: "add"
        });

        if (syncError) {
          console.error(`[processBatchRoleSync] Error enqueueing sync:`, syncError);
          summary.errors++;
        } else {
          summary.synced++;
        }

        // Recorded whether or not the enqueue succeeded: the membership check is what established
        // that the user is in the guild, and a failed enqueue says nothing about that. Leaving it
        // inside the success branch would strand a stale not_joined or cannot_invite on the roster
        // for as long as the enqueue keeps failing.
        await recordMembershipStatus(
          adminSupabase,
          {
            classId: record.class_id,
            userId: record.user_id,
            observedDiscordId: record.discord_id,
            guildId: record.discord_server_id,
            state: "in_guild"
          },
          scope
        );
      } catch (e) {
        console.error(`[processBatchRoleSync] Exception enqueueing sync:`, e);
        summary.errors++;
      }
      continue;
    }

    // The user is not in the guild, which no role operation can fix — adding a role to a non-member
    // returns 404 however many times it is attempted. So nothing is enqueued here. The membership
    // check above runs again next hour, and the user picks up their roles once they join.
    const { data: existingInvite, error: existingInviteError } = await adminSupabase
      .from("discord_invites")
      .select("id")
      .eq("user_id", record.user_id)
      .eq("class_id", record.class_id)
      .eq("guild_id", record.discord_server_id)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    // A failed read is not the same as no invite, and reading only `data` conflated them. On a
    // schema-cache miss or a transient database error the worker would mint a fresh Discord invite
    // and overwrite the single tracking row, leaving the previous invite live in Discord with
    // nothing pointing at it -- while the student's link changed underneath them for no reason.
    // Thrown before the external mutation, so the batch requeues and re-reads.
    if (existingInviteError) {
      throw existingInviteError;
    }

    if (existingInvite) {
      summary.not_in_guild++;
      await recordMembershipStatus(
        adminSupabase,
        {
          classId: record.class_id,
          userId: record.user_id,
          observedDiscordId: record.discord_id,
          guildId: record.discord_server_id,
          state: "not_joined",
          detail: "An unused invite is already outstanding"
        },
        scope
      );
      continue;
    }

    const inviteResult = await ensureInviteForUser(adminSupabase, record, guildInviteFailures, scope);
    if (inviteResult === "created") {
      summary.invite_created++;
    } else if (inviteResult === "not_offered") {
      // Counted as an ordinary not-in-guild outcome. The course has not opted in, so no invitation
      // was owed and nothing failed.
      summary.not_in_guild++;
    } else if (inviteResult === "cannot_invite") {
      summary.cannot_invite++;
    } else {
      summary.errors++;
    }
  }

  if (guildInviteFailures.size > 0) {
    // One event per run naming the guilds an admin needs to fix, rather than one per affected student.
    const summaryScope = scope.clone();
    summaryScope.setContext("discord_invite_permission_failures", {
      guild_ids: [...guildInviteFailures.keys()],
      reasons: [...guildInviteFailures.values()].map((f) => f.reason)
    });
    summaryScope.setFingerprint(["discord-batch-role-sync", "invite-permission-denied"]);
    summaryScope.setLevel("warning");
    Sentry.captureMessage(
      `Discord bot cannot create invites in ${guildInviteFailures.size} guild(s); affected students cannot be invited until an admin grants access`,
      summaryScope
    );
  }

  // A run where nothing could be checked has no other trace: the `unknown` branch records nothing
  // and only increments a counter, and the invite summary above never fires because the loop never
  // reaches the invite path. A revoked or rotated DISCORD_BOT_TOKEN produces exactly this shape --
  // every lookup 401s -- and would otherwise cost one request per candidate per hour, silently.
  if (summary.total > 0 && summary.errors === summary.total) {
    const deadRunScope = scope.clone();
    deadRunScope.setContext("discord_batch_role_sync_all_failed", {
      total: summary.total,
      errors: summary.errors
    });
    deadRunScope.setFingerprint(["discord-batch-role-sync", "all-membership-checks-failed"]);
    deadRunScope.setLevel("error");
    Sentry.captureMessage(
      `Discord batch role sync could not check any of ${summary.total} candidates; the bot token or Discord API is likely unavailable`,
      deadRunScope
    );
  }

  return { summary };
}

export async function processEnvelope(
  adminSupabase: SupabaseClient<Database>,
  envelope: DiscordAsyncEnvelope,
  meta: { msg_id: number; enqueued_at: string },
  _scope: Sentry.Scope
): Promise<boolean> {
  console.log(
    `[processEnvelope] Starting processing msg_id=${meta.msg_id}, method=${envelope.method}, retry_count=${envelope.retry_count ?? 0}`
  );
  console.log(`[processEnvelope] Envelope:`, JSON.stringify(envelope, null, 2));

  const scope = _scope?.clone();
  scope.setTag("msg_id", String(meta.msg_id));
  scope.setTag("async_method", envelope.method);
  if (envelope.class_id) scope.setTag("class_id", String(envelope.class_id));
  if (envelope.debug_id) scope.setTag("debug_id", envelope.debug_id);

  // Which guild this envelope's work lands in, resolved once and reused by the breaker check here
  // and by the failure accounting in the catch below. Guarded because it runs BEFORE the main
  // try/catch: a database blip resolving the guild must not escape processEnvelope, which would skip
  // the requeue/dead-letter machinery entirely and leave the message to reappear on every visibility
  // timeout with nothing recorded.
  let guildId: string | undefined;
  try {
    guildId = await resolveGuildId(adminSupabase, envelope);
  } catch (e) {
    console.warn(`[processEnvelope] Could not resolve guild for msg ${meta.msg_id}:`, e);
  }
  if (guildId) scope.setTag("guild_id", guildId);

  // Circuit breaker. A parked guild's work is deferred before any Discord call is made, which is the
  // whole point: the shared bot token's rate limit is what a permission storm actually consumes.
  if (guildId) {
    try {
      const circuit = await isGuildCircuitOpen(adminSupabase, guildId, scope);
      if (circuit.open) {
        scope.setTag("circuit_state", "open");
        scope.setTag("circuit_scope", DISCORD_CIRCUIT_SCOPE_GUILD);
        const deferrals = (envelope as CircuitDeferrableEnvelope).circuit_deferrals ?? 0;
        scope.setTag("circuit_deferrals", String(deferrals));

        // Deferrals have their own budget, not `retry_count`'s. The breaker parks a guild for 30
        // minutes and escalates to six hours, while five requeues at the 180s floor is fifteen
        // minutes -- so charging deferrals to the retry budget dead-lettered work while the breaker
        // was doing exactly what it was built to do. What ends an envelope now is the breaker still
        // being open after MAX_CIRCUIT_DEFERRALS full windows, which means nobody is coming to fix
        // the server and the DLQ row is the honest outcome.
        if (deferrals >= MAX_CIRCUIT_DEFERRALS) {
          const error = new Error(
            `Discord circuit breaker open for guild ${guildId} after ${deferrals} deferrals (${circuit.reason ?? "open"})`
          );
          console.log(`[processEnvelope] ${error.message}; dead-lettering msg ${meta.msg_id}`);
          if (await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope)) {
            if (!(await archiveMessage(adminSupabase, meta.msg_id, scope))) {
              await deleteMessage(adminSupabase, meta.msg_id, scope);
            }
          } else {
            console.error(`[processEnvelope] Failed to send message ${meta.msg_id} to DLQ, leaving unarchived`);
            scope.setContext("dlq_archive_skipped", { msg_id: meta.msg_id, reason: "DLQ send failed" });
            Sentry.captureMessage(`Message ${meta.msg_id} not archived due to DLQ failure`, { level: "error" });
          }
          return false;
        }

        // Parked until the breaker's own deadline rather than a fixed 180s: waking earlier only
        // reads a still-open breaker and spends another deferral, and the floor still applies when
        // `open_until` is missing or nearly past.
        const delaySeconds = circuitDeferralSeconds(circuit.openUntil);
        console.log(
          `[processEnvelope] Circuit open for guild ${guildId}; requeuing msg ${meta.msg_id} in ${delaySeconds}s (deferral ${deferrals + 1}/${MAX_CIRCUIT_DEFERRALS})`
        );
        // retry_count is deliberately carried through unchanged; only the deferral count moves.
        const deferred: CircuitDeferrableEnvelope = { ...envelope, circuit_deferrals: deferrals + 1 };
        // Archived only once the replacement is stored, as everywhere else in this worker.
        if (await requeueWithoutRetry(adminSupabase, deferred, delaySeconds, scope)) {
          await archiveMessage(adminSupabase, meta.msg_id, scope);
        }
        return false;
      }
    } catch (e) {
      // A breaker that cannot be consulted must not stop work: continue as though it were closed.
      console.warn(`[processEnvelope] Circuit breaker check failed for guild ${guildId}:`, e);
      Sentry.captureException(e, scope);
    }
  }

  try {
    switch (envelope.method) {
      case "send_message": {
        const args = envelope.args as SendMessageArgs;
        console.log(`[processEnvelope] Processing send_message to channel ${args.channel_id}`);
        console.log(`[processEnvelope] Message content:`, args.content?.substring(0, 100));
        Sentry.addBreadcrumb({ message: `Sending Discord message to channel ${args.channel_id}`, level: "info" });

        // Check if a message already exists for this resource (handles race conditions)
        // If so, convert to an update operation instead of creating a duplicate
        if (envelope.resource_type && envelope.resource_id && envelope.class_id) {
          try {
            const { data: existingMessage, error: lookupError } = await adminSupabase
              .from("discord_messages")
              .select("discord_message_id, discord_channel_id")
              .eq("class_id", envelope.class_id)
              .eq("resource_type", envelope.resource_type)
              .eq("resource_id", envelope.resource_id)
              .single();

            if (!lookupError && existingMessage) {
              console.log(
                `[processEnvelope] Found existing message ${existingMessage.discord_message_id} for resource, converting to update`
              );
              // Convert to update operation
              const updateArgs: UpdateMessageArgs = {
                channel_id: existingMessage.discord_channel_id,
                message_id: existingMessage.discord_message_id,
                content: args.content,
                embeds: args.embeds,
                allowed_mentions: args.allowed_mentions
              };

              // Add deep link to embed before updating
              const appUrl = Deno.env.get("APP_URL");
              if (appUrl && updateArgs.embeds && updateArgs.embeds.length > 0) {
                let deepLinkUrl: string | undefined;
                if (envelope.resource_type === "help_request") {
                  deepLinkUrl = `https://${appUrl}/course/${envelope.class_id}/office-hours/request/${envelope.resource_id}`;
                } else if (envelope.resource_type === "regrade_request") {
                  const { data: regradeRequest } = await adminSupabase
                    .from("submission_regrade_requests")
                    .select("assignment_id, submission_id")
                    .eq("id", envelope.resource_id)
                    .single();
                  if (regradeRequest) {
                    deepLinkUrl = `https://${appUrl}/course/${envelope.class_id}/assignments/${regradeRequest.assignment_id}/submissions/${regradeRequest.submission_id}/files#regrade-request-${envelope.resource_id}`;
                  }
                }
                if (deepLinkUrl) {
                  updateArgs.embeds[0].url = deepLinkUrl;
                  const fields = updateArgs.embeds[0].fields || [];
                  const urlFieldIndex = fields.findIndex(
                    (f) => f.name.toLowerCase().includes("view") || f.name.toLowerCase().includes("link")
                  );
                  const urlField = {
                    name: "🔗 View in Pawtograder",
                    value: `[Click here](${deepLinkUrl})`,
                    inline: false
                  };
                  if (urlFieldIndex >= 0) {
                    fields[urlFieldIndex] = urlField;
                  } else {
                    fields.push(urlField);
                  }
                  updateArgs.embeds[0].fields = fields;
                }

                // Add email link if email_data is provided (always add, even if resolved)
                if (envelope.email_data && typeof envelope.email_data === "object") {
                  const emailData = envelope.email_data as {
                    student_emails?: string | null;
                    assignee_email?: string | null;
                    class_name?: string | null;
                  };
                  const studentEmails = emailData.student_emails;
                  const assigneeEmail = emailData.assignee_email;
                  const className = emailData.class_name;

                  let helpRequestUrl = "";
                  if (envelope.resource_type === "help_request" && envelope.resource_id && envelope.class_id) {
                    helpRequestUrl = `https://${appUrl}/course/${envelope.class_id}/office-hours/request/${envelope.resource_id}`;
                  }

                  // Build mailto link with course name in subject
                  const subjectText = className
                    ? `Re: [${className}] Help Request #${envelope.resource_id || ""}`
                    : `Re: Help Request #${envelope.resource_id || ""}`;
                  const subject = encodeURIComponent(subjectText);
                  const bodyParts: string[] = [];
                  if (helpRequestUrl) {
                    bodyParts.push(`View this help request in Pawtograder: ${helpRequestUrl}`);
                  }
                  bodyParts.push("");
                  bodyParts.push("---");
                  bodyParts.push("");
                  bodyParts.push("Follow-up message:");
                  const body = encodeURIComponent(bodyParts.join("\n"));

                  // Build mailto link - always include it, even if student emails are null
                  let mailtoLink: string;
                  if (studentEmails) {
                    mailtoLink = `mailto:${encodeURIComponent(studentEmails)}?subject=${subject}&body=${body}`;
                    if (assigneeEmail) {
                      mailtoLink += `&cc=${encodeURIComponent(assigneeEmail)}`;
                    }
                  } else {
                    // If no student emails, create mailto link with just subject and body
                    mailtoLink = `mailto:?subject=${subject}&body=${body}`;
                    if (assigneeEmail) {
                      mailtoLink += `&cc=${encodeURIComponent(assigneeEmail)}`;
                    }
                  }

                  const fields = updateArgs.embeds[0].fields || [];
                  const emailFieldIndex = fields.findIndex(
                    (f) => f.name.toLowerCase().includes("email") || f.name.toLowerCase().includes("📧")
                  );
                  const emailField = {
                    name: "📧 Email students",
                    value: `[Email students](${mailtoLink})`,
                    inline: false
                  };
                  if (emailFieldIndex >= 0) {
                    fields[emailFieldIndex] = emailField;
                  } else {
                    fields.push(emailField);
                  }
                  updateArgs.embeds[0].fields = fields;
                }
              }

              await discord.updateMessage(updateArgs, scope);
              console.log(`[processEnvelope] Successfully updated existing message instead of creating duplicate`);
              return true;
            }
          } catch (e) {
            // If lookup fails, proceed with creating new message
            console.log(`[processEnvelope] No existing message found, proceeding with new message`);
          }
        }

        // Add deep link URL to embed if we have resource tracking info
        if (envelope.resource_type && envelope.resource_id && envelope.class_id) {
          const appUrl = Deno.env.get("APP_URL");
          if (appUrl) {
            let deepLinkUrl: string | undefined;

            if (envelope.resource_type === "help_request") {
              // Help request URL: /course/{class_id}/office-hours/request/{help_request_id}
              deepLinkUrl = `https://${appUrl}/course/${envelope.class_id}/office-hours/request/${envelope.resource_id}`;
            } else if (envelope.resource_type === "regrade_request") {
              // For regrade requests, we need to query assignment_id and submission_id
              try {
                const { data: regradeRequest, error: regradeError } = await adminSupabase
                  .from("submission_regrade_requests")
                  .select("assignment_id, submission_id")
                  .eq("id", envelope.resource_id)
                  .single();

                if (!regradeError && regradeRequest) {
                  // Regrade request URL: /course/{class_id}/assignments/{assignment_id}/submissions/{submission_id}/files#regrade-request-{regrade_request_id}
                  deepLinkUrl = `https://${appUrl}/course/${envelope.class_id}/assignments/${regradeRequest.assignment_id}/submissions/${regradeRequest.submission_id}/files#regrade-request-${envelope.resource_id}`;
                } else {
                  console.warn(
                    `[processEnvelope] Could not fetch regrade request ${envelope.resource_id} for deep link:`,
                    regradeError
                  );
                }
              } catch (e) {
                console.error(`[processEnvelope] Error fetching regrade request for deep link:`, e);
              }
            } else if (envelope.resource_type === "discussion_thread") {
              // Discussion thread URL: /course/{class_id}/discussion/{thread_id}
              deepLinkUrl = `https://${appUrl}/course/${envelope.class_id}/discussion/${envelope.resource_id}`;
            }

            // Add URL to the first embed if it exists
            if (deepLinkUrl && args.embeds && args.embeds.length > 0) {
              args.embeds[0].url = deepLinkUrl;
              // Add a "View in Pawtograder" field if not already present
              const hasUrlField = args.embeds[0].fields?.some(
                (f) => f.name.toLowerCase().includes("view") || f.name.toLowerCase().includes("link")
              );
              if (!hasUrlField) {
                args.embeds[0].fields = [
                  ...(args.embeds[0].fields || []),
                  {
                    name: "🔗 View in Pawtograder",
                    value: `[Click here](${deepLinkUrl})`,
                    inline: false
                  }
                ];
              }
              console.log(`[processEnvelope] Added deep link to embed: ${deepLinkUrl}`);
            }
          } else {
            console.warn(`[processEnvelope] APP_URL not configured, skipping deep link`);
          }
        }

        // Add email link if email_data is provided (always add, even if resolved)
        if (envelope.email_data && typeof envelope.email_data === "object" && args.embeds && args.embeds.length > 0) {
          const emailData = envelope.email_data as {
            student_emails?: string | null;
            assignee_email?: string | null;
            class_name?: string | null;
          };
          const studentEmails = emailData.student_emails;
          const assigneeEmail = emailData.assignee_email;
          const className = emailData.class_name;

          const appUrl = Deno.env.get("APP_URL");
          let helpRequestUrl = "";
          if (appUrl && envelope.resource_type === "help_request" && envelope.resource_id && envelope.class_id) {
            helpRequestUrl = `https://${appUrl}/course/${envelope.class_id}/office-hours/request/${envelope.resource_id}`;
          }

          // Build mailto link with course name in subject
          const subjectText = className
            ? `Re: [${className}] Help Request #${envelope.resource_id || ""}`
            : `Re: Help Request #${envelope.resource_id || ""}`;
          const subject = encodeURIComponent(subjectText);
          const bodyParts: string[] = [];
          if (helpRequestUrl) {
            bodyParts.push(`View this help request in Pawtograder: ${helpRequestUrl}`);
          }
          bodyParts.push("");
          bodyParts.push("---");
          bodyParts.push("");
          bodyParts.push("Follow-up message:");
          const body = encodeURIComponent(bodyParts.join("\n"));

          // Build mailto link - always include it, even if student emails are null
          let mailtoLink: string;
          if (studentEmails) {
            mailtoLink = `mailto:${encodeURIComponent(studentEmails)}?subject=${subject}&body=${body}`;
            if (assigneeEmail) {
              mailtoLink += `&cc=${encodeURIComponent(assigneeEmail)}`;
            }
          } else {
            // If no student emails, create mailto link with just subject and body
            mailtoLink = `mailto:?subject=${subject}&body=${body}`;
            if (assigneeEmail) {
              mailtoLink += `&cc=${encodeURIComponent(assigneeEmail)}`;
            }
          }

          // Check if email field already exists
          const hasEmailField = args.embeds[0].fields?.some(
            (f) => f.name.toLowerCase().includes("email") || f.name.toLowerCase().includes("📧")
          );

          if (!hasEmailField) {
            args.embeds[0].fields = [
              ...(args.embeds[0].fields || []),
              {
                name: "📧 Email students",
                value: `[Email students](${mailtoLink})`,
                inline: false
              }
            ];
            console.log(`[processEnvelope] Added email link to embed`);
          }
        }

        const result = await discord.sendMessage(args, scope);
        console.log(`[processEnvelope] Successfully sent message, id=${result.id}, channel_id=${result.channel_id}`);

        // Store message in discord_messages table if resource tracking is provided
        // Uses RPC with upsert to handle both insert and update cases
        console.log(
          `[processEnvelope] Resource tracking check: resource_type=${envelope.resource_type}, resource_id=${envelope.resource_id}, class_id=${envelope.class_id}`
        );
        if (envelope.resource_type && envelope.resource_id && envelope.class_id) {
          console.log(
            `[processEnvelope] Storing message tracking via RPC: resource_type=${envelope.resource_type}, resource_id=${envelope.resource_id}, discord_message_id=${result.id}`
          );
          try {
            const { error: upsertError } = await adminSupabase.rpc("insert_discord_message", {
              p_class_id: envelope.class_id,
              p_discord_message_id: result.id,
              p_discord_channel_id: result.channel_id,
              p_resource_type: envelope.resource_type,
              p_resource_id: envelope.resource_id
            });

            if (upsertError) {
              console.error(`[processEnvelope] Failed to upsert message tracking:`, upsertError);
              console.error(
                `[processEnvelope] Upsert error code: ${upsertError.code}, message: ${upsertError.message}`
              );
              scope.setContext("message_tracking_error", {
                error_message: upsertError.message,
                error_code: upsertError.code
              });
              Sentry.captureException(upsertError, scope);
            } else {
              console.log(`[processEnvelope] Successfully upserted message tracking`);
            }
          } catch (e) {
            console.error(`[processEnvelope] Failed to store message tracking:`, e);
            scope.setContext("message_tracking_error", {
              error_message: e instanceof Error ? e.message : String(e)
            });
            Sentry.captureException(e, scope);
          }
        }

        console.log(`[processEnvelope] send_message completed successfully`);
        return true;
      }

      case "update_message": {
        const args = envelope.args as UpdateMessageArgs;
        console.log(
          `[processEnvelope] Processing update_message: message_id=${args.message_id}, channel_id=${args.channel_id}`
        );
        Sentry.addBreadcrumb({
          message: `Updating Discord message ${args.message_id} in channel ${args.channel_id}`,
          level: "info"
        });

        // Look up resource info from discord_messages table if not in envelope
        let resourceType = envelope.resource_type;
        let resourceId = envelope.resource_id;
        let classId = envelope.class_id;

        if (!resourceType || !resourceId || !classId) {
          try {
            const { data: messageRecord, error: lookupError } = await adminSupabase
              .from("discord_messages")
              .select("resource_type, resource_id, class_id")
              .eq("discord_message_id", args.message_id)
              .eq("discord_channel_id", args.channel_id)
              .single();

            if (!lookupError && messageRecord) {
              resourceType = messageRecord.resource_type as "help_request" | "regrade_request";
              resourceId = messageRecord.resource_id;
              classId = messageRecord.class_id;
              console.log(
                `[processEnvelope] Looked up resource info: type=${resourceType}, id=${resourceId}, class_id=${classId}`
              );
            }
          } catch (e) {
            console.warn(`[processEnvelope] Could not look up message record for deep link:`, e);
          }
        }

        // Add deep link URL to embed if we have resource tracking info
        if (resourceType && resourceId && classId) {
          const appUrl = Deno.env.get("APP_URL");
          if (appUrl) {
            let deepLinkUrl: string | undefined;

            if (resourceType === "help_request") {
              // Help request URL: /course/{class_id}/office-hours/request/{help_request_id}
              deepLinkUrl = `https://${appUrl}/course/${classId}/office-hours/request/${resourceId}`;
            } else if (resourceType === "regrade_request") {
              // For regrade requests, we need to query assignment_id and submission_id
              try {
                const { data: regradeRequest, error: regradeError } = await adminSupabase
                  .from("submission_regrade_requests")
                  .select("assignment_id, submission_id")
                  .eq("id", resourceId)
                  .single();

                if (!regradeError && regradeRequest) {
                  // Regrade request URL: /course/{class_id}/assignments/{assignment_id}/submissions/{submission_id}/files#regrade-request-{regrade_request_id}
                  deepLinkUrl = `https://${appUrl}/course/${classId}/assignments/${regradeRequest.assignment_id}/submissions/${regradeRequest.submission_id}/files#regrade-request-${resourceId}`;
                } else {
                  console.warn(
                    `[processEnvelope] Could not fetch regrade request ${resourceId} for deep link:`,
                    regradeError
                  );
                }
              } catch (e) {
                console.error(`[processEnvelope] Error fetching regrade request for deep link:`, e);
              }
            } else if (resourceType === "discussion_thread") {
              // Discussion thread URL: /course/{class_id}/discussion/{thread_id}
              deepLinkUrl = `https://${appUrl}/course/${classId}/discussion/${resourceId}`;
            }

            // Add URL to the first embed if it exists
            if (deepLinkUrl && args.embeds && args.embeds.length > 0) {
              args.embeds[0].url = deepLinkUrl;
              // Add or update "View in Pawtograder" field
              const fields = args.embeds[0].fields || [];
              const urlFieldIndex = fields.findIndex(
                (f) => f.name.toLowerCase().includes("view") || f.name.toLowerCase().includes("link")
              );
              const urlField = {
                name: "🔗 View in Pawtograder",
                value: `[Click here](${deepLinkUrl})`,
                inline: false
              };

              if (urlFieldIndex >= 0) {
                fields[urlFieldIndex] = urlField;
              } else {
                fields.push(urlField);
              }
              args.embeds[0].fields = fields;
              console.log(`[processEnvelope] Added/updated deep link in embed: ${deepLinkUrl}`);
            }
          } else {
            console.warn(`[processEnvelope] APP_URL not configured, skipping deep link`);
          }
        }

        await discord.updateMessage(args, scope);
        console.log(`[processEnvelope] update_message completed successfully`);
        return true;
      }

      case "create_channel": {
        const args = envelope.args as CreateChannelArgs;
        console.log(
          `[processEnvelope] Processing create_channel: name=${args.name}, guild_id=${args.guild_id}, type=${args.type}`
        );
        Sentry.addBreadcrumb({
          message: `Creating Discord channel ${args.name} in guild ${args.guild_id}`,
          level: "info"
        });

        const result = await discord.createChannel(args, scope);
        console.log(`[processEnvelope] Successfully created channel, id=${result.id}`);

        // Store channel in discord_channels table if class_id is provided
        if (envelope.class_id) {
          // channel_type is required - if not provided, log error but don't fail
          if (!envelope.channel_type) {
            console.error(
              `[processEnvelope] Missing channel_type in envelope for create_channel, cannot track channel`
            );
            scope.setContext("channel_tracking_error", {
              error_message: "Missing channel_type in envelope",
              envelope_method: envelope.method,
              class_id: envelope.class_id
            });
            Sentry.captureMessage("create_channel envelope missing channel_type", {
              level: "warning",
              tags: { method: envelope.method, class_id: String(envelope.class_id) }
            });
          } else {
            console.log(
              `[processEnvelope] Storing channel tracking: class_id=${envelope.class_id}, channel_type=${envelope.channel_type}, resource_id=${envelope.resource_id ?? "null"}`
            );
            try {
              await adminSupabase.from("discord_channels").insert({
                class_id: envelope.class_id,
                discord_channel_id: result.id,
                channel_type: envelope.channel_type,
                resource_id: envelope.resource_id ?? null
              });
              console.log(`[processEnvelope] Successfully stored channel tracking`);
            } catch (e) {
              console.error(`[processEnvelope] Failed to store channel tracking:`, e);
              // Log but don't fail - channel was created successfully
              scope.setContext("channel_tracking_error", {
                error_message: e instanceof Error ? e.message : String(e),
                channel_type: envelope.channel_type,
                resource_id: envelope.resource_id
              });
              Sentry.captureException(e, scope);
            }
          }
        }

        console.log(`[processEnvelope] create_channel completed successfully`);
        return true;
      }

      case "delete_channel": {
        const args = envelope.args as DeleteChannelArgs;
        console.log(`[processEnvelope] Processing delete_channel: channel_id=${args.channel_id}`);
        Sentry.addBreadcrumb({ message: `Deleting Discord channel ${args.channel_id}`, level: "info" });

        try {
          await discord.deleteChannel(args, scope);
          console.log(`[processEnvelope] Successfully deleted channel`);
        } catch (error) {
          if (!isResourceGone(error)) {
            throw error;
          }
          // Already deleted in Discord, so the request has its intended outcome. Fall through to the
          // local cleanup below: skipping it would leave discord_channels naming a channel that no
          // longer exists, which later syncs would keep using.
          console.log(`[processEnvelope] Channel ${args.channel_id} is already gone, reconciling tracking`);
        }

        // Remove from discord_channels table
        if (envelope.class_id) {
          console.log(`[processEnvelope] Removing channel from tracking table`);
          try {
            // The result is inspected: PostgREST resolves with `{ error }` rather than throwing, so
            // the catch below never fired for a database failure. A stale discord_channels row looks
            // current, can stop a replacement being created, and routes later messages at a channel
            // that no longer exists -- which is the reconciliation this branch exists to perform.
            const { error: channelTrackingError } = await adminSupabase
              .from("discord_channels")
              .delete()
              .eq("discord_channel_id", args.channel_id);
            if (channelTrackingError) {
              throw channelTrackingError;
            }
            console.log(`[processEnvelope] Successfully removed channel from tracking`);
          } catch (e) {
            console.error(`[processEnvelope] Failed to remove channel from tracking:`, e);
            // Log but don't fail - channel was deleted successfully
            scope.setContext("channel_tracking_error", {
              error_message: e instanceof Error ? e.message : String(e)
            });
            Sentry.captureException(e, scope);
          }
        }

        console.log(`[processEnvelope] delete_channel completed successfully`);
        return true;
      }

      case "create_role": {
        const args = envelope.args as CreateRoleArgs;
        console.log(`[processEnvelope] Processing create_role: name=${args.name}, guild_id=${args.guild_id}`);
        Sentry.addBreadcrumb({
          message: `Creating Discord role ${args.name} in guild ${args.guild_id}`,
          level: "info"
        });

        // Superseded envelopes are dropped before any Discord call. A class that moves from guild A
        // to guild B leaves A's create_role messages queued, and the server-change trigger only
        // clears the tracking rows -- so the old worker would create a role in A and store it, and
        // because the replacement stores with ON CONFLICT DO NOTHING the stale row can win, leaving
        // the class pairing guild B with a role from A and B's role deleted as surplus.
        if (envelope.class_id) {
          const { data: classRow, error: classLookupError } = await adminSupabase
            .from("classes")
            .select("discord_server_id")
            .eq("id", envelope.class_id)
            .maybeSingle();
          if (classLookupError) {
            throw classLookupError;
          }
          if (classRow?.discord_server_id !== args.guild_id) {
            console.log(
              `[processEnvelope] Dropping create_role for guild ${args.guild_id}; class ${envelope.class_id} now uses ${classRow?.discord_server_id ?? "no server"}`
            );
            return true;
          }
        }

        const result = await discord.createRole(args, scope);
        console.log(`[processEnvelope] Successfully created role, id=${result.id}`);

        // Store role in discord_roles table if class_id and role_type are provided
        if (envelope.class_id && envelope.role_type) {
          console.log(
            `[processEnvelope] Storing role tracking: class_id=${envelope.class_id}, role_type=${envelope.role_type}`
          );
          // The result is inspected rather than caught: PostgREST resolves with `{ error }` instead
          // of throwing, so the previous try/catch could never fire for a database failure. The role
          // existed in Discord, the tracking row did not, and the message archived as a success --
          // after which the repair path saw neither a row nor a queued message and made another role.
          //
          // Revalidated and inserted in one statement. The preflight check above cannot cover the
          // Discord call that sits between it and this write, so a class that moves servers midway
          // would otherwise have guild A's role stored after the trigger cleared the rows -- and
          // because this stores without overwriting, that stale row would win and guild B's role be
          // removed as surplus.
          const { data: storeRows, error: trackingError } = await adminSupabase.rpc("store_discord_role_if_current", {
            p_class_id: envelope.class_id,
            p_role_type: envelope.role_type,
            p_discord_role_id: result.id,
            p_guild_id: args.guild_id
          });
          const storeResult = storeRows?.[0];

          if (!trackingError && storeResult && !storeResult.stored) {
            // Either the class has moved on, or another worker tracked its role first. Both mean
            // this role is surplus and belongs to nobody, so it is removed rather than left in the
            // guild with nothing referring to it.
            const why = storeResult.superseded ? "the class changed server" : "another worker won the race";
            console.log(`[processEnvelope] Discarding role ${result.id}: ${why}`);
            try {
              await discord.deleteRole({ guild_id: args.guild_id, role_id: result.id }, scope);
            } catch (surplusError) {
              if (!isResourceGone(surplusError)) {
                scope.setContext("role_surplus_cleanup_failed", {
                  discord_role_id: result.id,
                  guild_id: args.guild_id,
                  reason: why
                });
                throw new NonRetriableWorkerError(
                  `Surplus Discord role ${result.id} could not be removed from guild ${args.guild_id}`,
                  { cause: surplusError }
                );
              }
            }
            return true;
          }

          if (trackingError) {
            console.error(`[processEnvelope] Failed to store role tracking:`, trackingError);
            scope.setContext("role_tracking_error", {
              error_message: trackingError.message,
              discord_role_id: result.id
            });

            // Compensate before rethrowing. Retrying create_role makes another Discord role, so
            // without this every attempt stacks one more untracked role in the guild -- exactly what
            // failing loudly is meant to prevent.
            try {
              await discord.deleteRole({ guild_id: args.guild_id, role_id: result.id }, scope);
              console.log(`[processEnvelope] Rolled back untracked Discord role ${result.id}`);
            } catch (rollbackError) {
              // Already gone is the state the rollback was trying to reach, so it succeeded. Treating
              // a 404 as a failed compensation dead-lettered a repair that had left nothing behind --
              // no role and no tracking row -- and denied the tracking error the ordinary retry that
              // would have recreated both.
              if (isResourceGone(rollbackError)) {
                console.log(`[processEnvelope] Role ${result.id} was already gone; rollback complete`);
                throw trackingError;
              }

              console.error(`[processEnvelope] Could not roll back role ${result.id}:`, rollbackError);
              scope.setContext("role_rollback_failed", {
                discord_role_id: result.id,
                guild_id: args.guild_id,
                error_message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              });

              // Not retriable. A retry re-runs createRole before reaching this cleanup, so a rollback
              // outage would leave one untracked role in the guild per attempt before the envelope
              // finally dead-letters. Once both the tracking write and its compensation have failed,
              // the only safe move is to stop and let a human look at the one role already made.
              throw new NonRetriableWorkerError(
                `Discord role ${result.id} was created in guild ${args.guild_id} but could not be tracked or removed`,
                { cause: trackingError }
              );
            }

            throw trackingError;
          }
          console.log(`[processEnvelope] Successfully stored role tracking`);

          // Outside the insert's transaction, so this sees the sibling create_role workers the
          // trigger on discord_roles could not. Without it a class whose three roles are created
          // concurrently ends with all three rows and nobody assigned to them.
          // Retried in place. Only the last worker to commit sees all three roles, so this is that
          // class's one chance to fire the sync: no later insert repeats the check, an inactive class
          // has no hourly batch behind it, and a manual retry skips users already recorded in_guild.
          // A transient failure here would leave the roles created and nobody assigned to them,
          // permanently. Database-only, so retrying repeats nothing external.
          let synced = false;
          let syncError: { message: string } | null = null;
          for (let attempt = 1; attempt <= STATUS_WRITE_ATTEMPTS; attempt++) {
            const { data, error } = await adminSupabase.rpc("sync_discord_users_if_roles_complete", {
              p_class_id: envelope.class_id
            });
            if (!error) {
              synced = data === true;
              syncError = null;
              break;
            }
            syncError = error;
            if (attempt < STATUS_WRITE_ATTEMPTS) {
              await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
            }
          }

          if (syncError) {
            // Not fatal to this envelope: the role itself is created and tracked. Reported so a class
            // that ends up with roles and no assignments is visible rather than merely quiet.
            console.error(`[processEnvelope] Failed to run the existing-user sync check:`, syncError);
            scope.setContext("role_sync_check_error", {
              class_id: envelope.class_id,
              error_message: syncError.message
            });
            Sentry.captureException(syncError, scope);
          } else if (synced) {
            console.log(`[processEnvelope] All Discord roles present for class ${envelope.class_id}, synced users`);
          }
        }

        console.log(`[processEnvelope] create_role completed successfully`);
        return true;
      }

      case "delete_role": {
        const args = envelope.args as DeleteRoleArgs;
        console.log(`[processEnvelope] Processing delete_role: role_id=${args.role_id}, guild_id=${args.guild_id}`);
        Sentry.addBreadcrumb({
          message: `Deleting Discord role ${args.role_id} from guild ${args.guild_id}`,
          level: "info"
        });

        try {
          await discord.deleteRole(args, scope);
          console.log(`[processEnvelope] Successfully deleted role`);
        } catch (error) {
          if (!isResourceGone(error)) {
            throw error;
          }
          // As with delete_channel: a stale discord_roles row can stop the server-connect trigger
          // from creating a replacement, so the tracking row must go even though the API call failed.
          console.log(`[processEnvelope] Role ${args.role_id} is already gone, reconciling tracking`);
        }

        // Remove from discord_roles table if class_id is provided
        if (envelope.class_id) {
          console.log(`[processEnvelope] Removing role from tracking table`);
          try {
            // As for channels above: `{ error }` rather than a throw. A stale discord_roles row is
            // worse here, because the create trigger skips while any row exists, so it blocks the
            // repair that would replace it.
            const { error: roleTrackingError } = await adminSupabase
              .from("discord_roles")
              .delete()
              .eq("discord_role_id", args.role_id);
            if (roleTrackingError) {
              throw roleTrackingError;
            }
            console.log(`[processEnvelope] Successfully removed role from tracking`);
          } catch (e) {
            console.error(`[processEnvelope] Failed to remove role from tracking:`, e);
            scope.setContext("role_tracking_error", {
              error_message: e instanceof Error ? e.message : String(e)
            });
            Sentry.captureException(e, scope);
          }
        }

        console.log(`[processEnvelope] delete_role completed successfully`);
        return true;
      }

      case "add_member_role": {
        const args = envelope.args as AddMemberRoleArgs;
        console.log(`[processEnvelope] Processing add_member_role: user_id=${args.user_id}, role_id=${args.role_id}`);
        Sentry.addBreadcrumb({
          message: `Adding role ${args.role_id} to user ${args.user_id} in guild ${args.guild_id}`,
          level: "info"
        });

        // Superseded envelopes are dropped before any Discord call, as create_role now does. An
        // add_member_role for guild A outlives a move to guild B: applied, it grants an obsolete
        // role in the server the class left, and if the user is absent it mints a live invitation
        // into that server which the current-guild filters then hide from everyone.
        if (envelope.class_id) {
          const { data: currentClass, error: currentClassError } = await adminSupabase
            .from("classes")
            .select("discord_server_id")
            .eq("id", envelope.class_id)
            .maybeSingle();
          if (currentClassError) {
            throw currentClassError;
          }
          if (currentClass?.discord_server_id !== args.guild_id) {
            console.log(
              `[processEnvelope] Dropping add_member_role for guild ${args.guild_id}; class ${envelope.class_id} now uses ${currentClass?.discord_server_id ?? "no server"}`
            );
            return true;
          }
        }

        try {
          // First check if user is in the guild
          const member = await discord.getGuildMember(args.guild_id, args.user_id, scope);

          if (!member) {
            // The user has not joined the server. That is a permanent state until the user acts, so
            // this operation is finished either way — the invite below is a courtesy, and its failure
            // is recorded rather than retried.
            console.log(`[processEnvelope] User ${args.user_id} not in guild ${args.guild_id}, creating invite`);

            const platformUserId = envelope.class_id
              ? await lookupUserIdByDiscordId(adminSupabase, args.user_id)
              : null;

            // The course must have opted in to student invitations. The batch path checks the same
            // flag; this handler is reachable independently -- the user_roles trigger, a Discord
            // relink, the manual retry -- so without it a course with the feature off would still
            // accumulate invitations nobody can see.
            if (envelope.class_id) {
              // Which class role this envelope is for. The flag is student-scoped, and this handler
              // is reached for staff too, so the role has to be resolved before the gate applies --
              // otherwise a course with the feature off would stop inviting its graders as well.
              // args.role_id is the Discord role, which discord_roles maps back to a role_type.
              const { data: roleRow, error: roleLookupError } = await adminSupabase
                .from("discord_roles")
                .select("role_type")
                .eq("class_id", envelope.class_id)
                .eq("discord_role_id", args.role_id)
                .maybeSingle();
              if (roleLookupError) {
                throw roleLookupError;
              }

              // Fail closed. An envelope can outlive its discord_roles row -- the server-change
              // trigger deletes them while older messages are still queued -- and treating an
              // unidentifiable role as staff let a course with student invitations switched off
              // create one anyway, possibly for the guild it had just left. An opt-out that a stale
              // message can bypass is not an opt-out.
              const isStudentEnvelope = roleRow?.role_type !== "grader" && roleRow?.role_type !== "instructor";

              const { data: joinEnabled, error: joinFlagError } = isStudentEnvelope
                ? await adminSupabase.rpc("discord_student_join_enabled", { p_class_id: envelope.class_id })
                : { data: true, error: null };
              if (joinFlagError) {
                // Not assumed either way: creating an invite a course has switched off is as wrong
                // as withholding one it wants, so the envelope retries rather than guessing.
                throw joinFlagError;
              }
              if (!joinEnabled) {
                console.log(`[processEnvelope] Student invitations are off for class ${envelope.class_id}`);
                if (platformUserId) {
                  await recordMembershipStatus(
                    adminSupabase,
                    {
                      classId: envelope.class_id,
                      userId: platformUserId,
                      observedDiscordId: args.user_id,
                      guildId: args.guild_id,
                      state: "not_joined",
                      detail: "Student Discord invitations are turned off for this course"
                    },
                    scope
                  );
                }
                return true;
              }
            }

            // Reuse an invite the student already has, the way the batch path does. Without this,
            // anything that re-enqueues add_member_role -- the manual retry most of all, which exists
            // to be pressed repeatedly -- minted a fresh Discord invite and upserted it over the
            // single tracking row, changing the URL the student was given while leaving the previous
            // one live in Discord with nothing pointing at it.
            if (envelope.class_id && platformUserId) {
              const { data: outstandingInvite, error: outstandingError } = await adminSupabase
                .from("discord_invites")
                .select("invite_url")
                .eq("user_id", platformUserId)
                .eq("class_id", envelope.class_id)
                .eq("guild_id", args.guild_id)
                .eq("used", false)
                .gt("expires_at", new Date().toISOString())
                .maybeSingle();

              // As on the batch path: a failed read is not the same as no invite, and treating it as
              // one is what creates the duplicate.
              if (outstandingError) {
                throw outstandingError;
              }

              if (outstandingInvite) {
                console.log(`[processEnvelope] User ${args.user_id} already has an outstanding invite, reusing`);
                await recordMembershipStatus(
                  adminSupabase,
                  {
                    classId: envelope.class_id,
                    userId: platformUserId,
                    observedDiscordId: args.user_id,
                    guildId: args.guild_id,
                    state: "not_joined",
                    detail: `Invite ${outstandingInvite.invite_url} is waiting to be used`
                  },
                  scope
                );
                return true;
              }
            }

            try {
              const invite = await discord.createGuildInvite(args.guild_id, 604800, 5, scope); // 7 days, 5 uses
              console.log(`[processEnvelope] Created invite for user ${args.user_id}: ${invite.url}`);

              if (envelope.class_id && platformUserId) {
                const expiresAt = new Date(Date.now() + 604800 * 1000); // 7 days

                // Same claim the batch path uses. This handler and an hourly batch_role_sync can
                // reach the same absent user at once -- processBatch runs four envelopes in parallel
                // -- and both would otherwise create an invite and race to store it, leaving the
                // loser's live in Discord and pointing the student at whichever URL landed last.
                const claimedUrl = await claimInvite(
                  adminSupabase,
                  {
                    userId: platformUserId,
                    classId: envelope.class_id,
                    guildId: args.guild_id,
                    code: invite.code,
                    url: invite.url,
                    expiresAt
                  },
                  scope
                );

                console.log(
                  `[processEnvelope] Stored invite in database: user_id=${platformUserId}, class_id=${envelope.class_id}`
                );

                await recordMembershipStatus(
                  adminSupabase,
                  {
                    classId: envelope.class_id,
                    userId: platformUserId,
                    observedDiscordId: args.user_id,
                    guildId: args.guild_id,
                    state: "not_joined",
                    detail: `Invite ${claimedUrl} is waiting to be used`
                  },
                  scope
                );
              } else {
                console.warn(`[processEnvelope] No class_id or matching user, skipping invite storage`);
              }
            } catch (inviteError) {
              const classification = classifyDiscordError(inviteError);
              const reason = inviteError instanceof Error ? inviteError.message : String(inviteError);

              if (!classification.terminal) {
                // A rate limit or timeout on the invite call is worth another attempt.
                throw inviteError;
              }

              // No invite exists, and retrying will not produce one. That is cannot_invite regardless
              // of the exact cause: recording not_joined here would put the student under the alert
              // that says an invite is waiting for them, which would be false. The cause is carried in
              // discord_error_code and detail so the roster can say what actually needs doing.
              if (envelope.class_id && platformUserId) {
                await recordMembershipStatus(
                  adminSupabase,
                  {
                    classId: envelope.class_id,
                    userId: platformUserId,
                    observedDiscordId: args.user_id,
                    guildId: args.guild_id,
                    state: "cannot_invite",
                    discordErrorCode: classification.code,
                    detail: isBotPermissionProblem(inviteError)
                      ? reason
                      : `Discord rejected the invite request (${classification.reason ?? "terminal error"}): ${reason}`
                  },
                  scope
                );
              }
              // Counted toward the guild's breaker here rather than in the outer catch, because this
              // branch never reaches it: the failure is recorded against the student and the
              // envelope returns success. That makes this the single largest source of the storm the
              // breaker exists for -- a guild the bot cannot read produces one of these per enrolled
              // student, each having already cost a getGuildMember plus a channel listing.
              if (isBotPermissionProblem(inviteError)) {
                await noteGuildPermissionFailure(adminSupabase, args.guild_id, envelope.method, inviteError, scope);
              }

              // "recorded", not dead-lettered: the cannot_invite row written just above puts this in
              // front of the instructor who can fix it, and these arrive once per unjoined student
              // per run — the exact volume that made the dead letter queue unreadable.
              reportTerminalFailure(envelope, meta, inviteError, classification, scope, "recorded");
            }

            // Either way this message is done. The user is not in the guild, so there is no role to
            // add; the hourly membership check picks them up once they join.
            return true;
          }

          // User is in guild, add the role
          await discord.addMemberRole(args, scope);
          console.log(`[processEnvelope] add_member_role completed successfully`);

          // Mark any pending invites for this user/guild as used
          if (envelope.class_id) {
            try {
              const platformUserId = await lookupUserIdByDiscordId(adminSupabase, args.user_id);

              if (platformUserId) {
                const { error: markError } = await adminSupabase.rpc("mark_discord_invite_used", {
                  p_user_id: platformUserId,
                  p_guild_id: args.guild_id
                });

                if (markError) {
                  console.warn(`[processEnvelope] Failed to mark invite as used:`, markError);
                } else {
                  console.log(
                    `[processEnvelope] Marked invites as used for user_id=${platformUserId}, guild_id=${args.guild_id}`
                  );
                }

                // Clears any not_joined or cannot_invite this user was carrying.
                await recordMembershipStatus(
                  adminSupabase,
                  {
                    classId: envelope.class_id,
                    userId: platformUserId,
                    observedDiscordId: args.user_id,
                    guildId: args.guild_id,
                    state: "in_guild"
                  },
                  scope
                );
              }
            } catch (e) {
              console.error(`[processEnvelope] Error marking invite as used:`, e);
              // Don't fail the operation if marking invite fails
            }
          }

          return true;
        } catch (error) {
          // If adding role fails (e.g., user left server), log but don't fail completely
          console.error(`[processEnvelope] Failed to add member role:`, error);
          scope.setContext("add_member_role_error", {
            user_id: args.user_id,
            role_id: args.role_id,
            guild_id: args.guild_id,
            error_message: error instanceof Error ? error.message : String(error)
          });
          // Re-throw to trigger retry logic
          throw error;
        }
      }

      case "remove_member_role": {
        const args = envelope.args as RemoveMemberRoleArgs;
        console.log(
          `[processEnvelope] Processing remove_member_role: user_id=${args.user_id}, role_id=${args.role_id}`
        );
        Sentry.addBreadcrumb({
          message: `Removing role ${args.role_id} from user ${args.user_id} in guild ${args.guild_id}`,
          level: "info"
        });

        try {
          await discord.removeMemberRole(args, scope);
          console.log(`[processEnvelope] remove_member_role completed successfully`);
        } catch (error) {
          // Unknown Member is the desired end state, not a failure: the user left the server before
          // their queued removal ran, which is what an ordinary drop looks like. isResourceGone
          // deliberately excludes 10007 because for a delete_channel or delete_role it would mean
          // something else, so this is checked here rather than there -- otherwise every departure
          // dead-letters and the DLQ alert fires for work nobody needs to do.
          if (classifyDiscordError(error).code !== DISCORD_UNKNOWN_MEMBER) {
            throw error;
          }
          console.log(`[processEnvelope] User ${args.user_id} is not in guild ${args.guild_id}; removal already done`);
        }
        return true;
      }

      case "register_commands": {
        console.log(`[processEnvelope] Processing register_commands`);
        Sentry.addBreadcrumb({ message: "Registering Discord slash commands", level: "info" });

        const results = await registerSlashCommands(scope);
        const allSuccess = results.every((r) => r.success);

        if (!allSuccess) {
          const failures = results.filter((r) => !r.success);
          console.error(`[processEnvelope] Some commands failed to register:`, failures);
          scope.setContext("register_commands_failures", { failures });
        }
        return true;
      }
      case "batch_role_sync": {
        console.log(`[processEnvelope] Processing batch_role_sync`);
        Sentry.addBreadcrumb({ message: "Running batch Discord role sync", level: "info" });

        const results = await processBatchRoleSync(adminSupabase, scope);
        console.log(`[processEnvelope] batch_role_sync completed: ${JSON.stringify(results.summary)}`);
        return true;
      }
      default: {
        const unknownMethod = (envelope as DiscordAsyncEnvelope).method;
        console.error(`[processEnvelope] Unknown async method: ${unknownMethod}`);
        // Dead-lettered on the first pass, not retried. A plain Error here is classified retriable
        // (there is no Discord status or code to read), so the envelope took the 120s requeue path
        // and burned five more doomed cycles before reaching the same dead-letter row. Nothing about
        // an unknown method can change between attempts: the deploy that understood it is gone. This
        // is the path an in-flight envelope from an older deploy takes -- `add_guild_member` was
        // removed in this branch -- so it has to end with a legible reason rather than a mystery
        // retry loop. NonRetriableWorkerError is what the catch below branches on to dead-letter
        // once via sendToDeadLetterQueue.
        throw new NonRetriableWorkerError(
          `Unknown Discord async method "${unknownMethod}"; this worker deploy cannot handle it, so the envelope is dead-lettered instead of retried`
        );
      }
    }
  } catch (error) {
    console.error(`[processEnvelope] Error processing envelope:`, error);
    console.trace(error);

    // Count bot-permission failures against the guild before deciding what to do with the message.
    // These arrive once per enrolled student and are individually terminal, so without the breaker
    // each one costs its own Discord round trip on the token every other course shares.
    if (guildId && isBotPermissionProblem(error)) {
      await noteGuildPermissionFailure(adminSupabase, guildId, envelope.method, error, scope);
    }

    // A failure that cannot succeed on a later attempt is dead-lettered once, not retried. Requeueing
    // it buys five more identical failures before the same dead-letter row, and the hourly enqueue
    // brings it straight back — which is how 30,332 dead-lettered operations accumulated for ~30
    // users. What fixed that flood was removing the *retries* and recording the membership outcome as
    // state; the operations that reach here have no such record, so the DLQ row is their only durable
    // evidence and the growth signal PawtograderDiscordDLQGrowing is built on.
    const classification = classifyDiscordError(error);
    if (classification.terminal || error instanceof NonRetriableWorkerError) {
      reportTerminalFailure(envelope, meta, error, classification, scope, "dead-lettered");

      const copied = await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
      if (copied) {
        // Copying is not by itself an ending: the original is still on the queue, and this path does
        // not requeue, so nothing else removes it. Left behind it would be redelivered on every
        // visibility timeout and copied again each time, growing the table it was meant to make
        // legible. Delete is the fallback once archive has proved it cannot do it — the payload is
        // already safe in the DLQ, so nothing is lost.
        if (!(await archiveMessage(adminSupabase, meta.msg_id, scope))) {
          await deleteMessage(adminSupabase, meta.msg_id, scope);
        }
      } else {
        // Deliberately left on the queue. Ending it here would discard the only copy; redelivery
        // retries the DLQ write, and this recovers by itself once that write succeeds.
        console.error(`[processEnvelope] Failed to dead-letter terminal message ${meta.msg_id}, leaving unarchived`);
        Sentry.captureMessage(`Terminal message ${meta.msg_id} could not be dead-lettered`, { level: "error" });
      }
      return false;
    }

    const rt = detectRateLimit(error);
    console.log(`[processEnvelope] Rate limit detected: ${rt.isRateLimit}, retry_after: ${rt.retryAfter}`);
    scope.setTag("rate_limit", rt.isRateLimit ? "true" : "false");
    const errorId = Sentry.captureException(error, scope);
    console.log(`[processEnvelope] Recorded error with Sentry ID: ${errorId}`);

    // Check retry count - if >= 5, send to DLQ instead of requeuing
    const currentRetryCount = envelope.retry_count ?? 0;
    console.log(`[processEnvelope] Current retry count: ${currentRetryCount}`);

    if (currentRetryCount >= 5) {
      console.log(`[processEnvelope] Retry count >= 5, sending to DLQ`);
      const dlqSuccess = await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
      if (dlqSuccess) {
        // Same reasoning as the terminal path above: this branch does not requeue, so it never
        // increments retry_count. A failed archive here means the message comes back, lands on
        // `>= 5` again, and writes another DLQ copy every cycle.
        if (!(await archiveMessage(adminSupabase, meta.msg_id, scope))) {
          await deleteMessage(adminSupabase, meta.msg_id, scope);
        }
      } else {
        console.error(`[processEnvelope] Failed to send message ${meta.msg_id} to DLQ, leaving unarchived`);
        scope.setContext("dlq_archive_skipped", {
          msg_id: meta.msg_id,
          reason: "DLQ send failed"
        });
        Sentry.captureMessage(`Message ${meta.msg_id} not archived due to DLQ failure`, {
          level: "error"
        });
      }
      return false;
    }

    if (rt.isRateLimit) {
      const retryAfter = rt.retryAfter;
      const delay = computeBackoffSeconds(retryAfter ?? 60, currentRetryCount);
      console.log(`[processEnvelope] Rate limit hit, requeuing with delay: ${delay}s (retry_after: ${retryAfter})`);
      scope.setContext("rate_limit_detail", {
        retry_after: retryAfter,
        delay_seconds: delay,
        retry_count: currentRetryCount
      });

      // Archived only once the replacement exists. Otherwise the original is destroyed and the
      // replacement never arrived, and the operation is simply gone. Left on the queue it is
      // redelivered when its visibility timeout expires, which is the recoverable failure.
      if (await requeueWithDelay(adminSupabase, envelope, delay, scope)) {
        await archiveMessage(adminSupabase, meta.msg_id, scope);
      }
      return false;
    }

    // For non-rate-limit errors, requeue with 2-minute delay
    console.log(`[processEnvelope] Non-rate-limit error, requeuing with 2-minute delay`);
    scope.setContext("async_error", {
      method: envelope.method,
      error_message: error instanceof Error ? error.message : String(error),
      requeue_delay_seconds: 120
    });

    // Same as the rate-limit path above: the original stays until its replacement is stored.
    if (await requeueWithDelay(adminSupabase, envelope, 120, scope)) {
      await archiveMessage(adminSupabase, meta.msg_id, scope);
    }
    return false;
  }
}

export async function processBatch(adminSupabase: SupabaseClient<Database>, scope: Sentry.Scope) {
  console.log(`[processBatch] Reading from queue discord_async_calls`);
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "discord_async_calls",
    sleep_seconds: 60,
    n: 4
  });

  if (result.error) {
    console.error(`[processBatch] Error reading from queue:`, result.error);
    Sentry.captureException(result.error, scope);
    return false;
  }
  const messages = (result.data || []) as QueueMessage<DiscordAsyncEnvelope>[];
  console.log(`[processBatch] Read ${messages.length} messages from queue`);

  if (messages.length === 0) {
    console.log(`[processBatch] No messages to process`);
    return false;
  }

  console.log(`[processBatch] Processing ${messages.length} messages in parallel`);
  await Promise.allSettled(
    messages.map(async (msg) => {
      console.log(`[processBatch] Processing message ${msg.msg_id}, latency: ${toMsLatency(msg.enqueued_at)}ms`);
      const ok = await processEnvelope(
        adminSupabase,
        msg.message,
        { msg_id: msg.msg_id, enqueued_at: msg.enqueued_at },
        scope
      );
      if (ok) {
        console.log(`[processBatch] Message ${msg.msg_id} processed successfully, archiving`);
        await archiveMessage(adminSupabase, msg.msg_id, scope);
      } else {
        console.log(
          `[processBatch] Message ${msg.msg_id} processing failed, not archiving (will be requeued or sent to DLQ)`
        );
      }
    })
  );
  console.log(`[processBatch] Batch processing completed`);
  return true;
}

export async function runBatchHandler() {
  console.log(`[runBatchHandler] Starting Discord async worker batch handler`);
  const scope = new Sentry.Scope();
  scope.setTag("function", "discord_async_worker");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      `[runBatchHandler] Missing environment variables: SUPABASE_URL=${!!supabaseUrl}, SUPABASE_SERVICE_ROLE_KEY=${!!supabaseKey}`
    );
    throw new Error("Missing required environment variables");
  }

  // Loud on purpose. Every Discord mutation this loop makes -- roles created, invites minted,
  // messages posted -- goes to whatever DISCORD_API_BASE_URL names, so a run that is silently
  // pointed at a mock looks exactly like a run that succeeded against Discord. Logging it once per
  // run is what lets a local or CI run prove which one it was.
  if (isDiscordApiMocked()) {
    console.warn(`[runBatchHandler] Discord API is MOCKED: all requests go to ${discordApiBase()}`);
    scope.setTag("discord_api_mocked", "true");
  }

  console.log(`[runBatchHandler] Creating Supabase client with URL: ${supabaseUrl.substring(0, 30)}...`);
  const adminSupabase = createClient<Database>(supabaseUrl, supabaseKey);

  // Leased when Redis is configured, bounded otherwise -- see _shared/workerRun.ts.
  const run = await beginWorkerRun({
    name: "discord_async_worker",
    scope,
    idleSleepMs: 15000,
    errorSleepMs: 5000
  });
  scope.setTag("worker_run_mode", run.mode);
  console.log(`[runBatchHandler] Running in ${run.mode} mode`);

  let iteration = 0;
  try {
    while (run.shouldContinue()) {
      await run.heartbeat();
      if (!run.shouldContinue()) break;
      iteration++;
      console.log(`[runBatchHandler] Iteration ${iteration}, processing batch...`);
      try {
        const hasWork = await processBatch(adminSupabase, scope);
        if (!hasWork) {
          console.log(`[runBatchHandler] No work found`);
          if (!(await run.onIdle())) break;
        } else {
          console.log(`[runBatchHandler] Work completed, continuing immediately`);
        }
      } catch (e) {
        console.error(`[runBatchHandler] Error in batch handler:`, e);
        Sentry.captureException(e, scope);
        await run.onError();
      }
    }
  } finally {
    await run.release();
  }
}

serveWithSentryFlush((req) => {
  console.log(`[serve] Received request, method: ${req.method}, url: ${req.url}`);
  const secret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");

  if (!expectedSecret) {
    console.error(`[serve] EDGE_FUNCTION_SECRET is not configured`);
    return new Response(JSON.stringify({ error: "EDGE_FUNCTION_SECRET is not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  if (secret !== expectedSecret) {
    console.error(
      `[serve] Invalid or missing secret. Provided: ${secret ? "yes" : "no"}, Expected: ${expectedSecret ? "yes" : "no"}`
    );
    return new Response(JSON.stringify({ error: "Invalid or missing secret" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="discord_async_worker", error="invalid_token"'
      }
    });
  }

  const already_running = started;
  console.log(`[serve] Worker already running: ${already_running}`);

  if (!started) {
    console.log(`[serve] Starting batch handler`);
    started = true;
    // Reset on exit so the flag does not stay true for the isolate's whole life, which would stop
    // the worker restarting even once the underlying fault cleared. Unlike the notification and
    // gradebook processors, this loop has no consecutive-error cap: batch errors are captured,
    // delayed 5s, and retried indefinitely, so the only way out is a throw before the loop -- the
    // missing-environment-variable check. `.catch` is what makes that throw visible: nothing
    // consumes the promise handed to waitUntil, so without it the one error that can actually end
    // this worker is an unhandled rejection and never reaches Sentry.
    waitUntilWithSentryFlush(
      runBatchHandler()
        .catch((e) => {
          console.error(`[serve] Batch handler exited with an error:`, e);
          const scope = new Sentry.Scope();
          scope.setTag("function", "discord_async_worker");
          scope.setTag("error_source", "run_batch_handler_startup");
          Sentry.captureException(e, scope);
        })
        .finally(() => {
          started = false;
        })
    );
  } else {
    console.log(`[serve] Batch handler already started, skipping`);
  }

  return new Response(
    JSON.stringify({
      message: "Discord async worker started",
      already_running: already_running,
      timestamp: new Date().toISOString()
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
});
