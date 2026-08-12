import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
// Import for side effect: this function makes Sentry calls but does not import HandlerUtils, so
// without this Sentry.init never ran and every capture was a silent no-op.
import "../_shared/SentryInit.ts";
import type {
  DiscordAsyncEnvelope,
  SendMessageArgs,
  UpdateMessageArgs,
  CreateChannelArgs,
  DeleteChannelArgs,
  CreateRoleArgs,
  DeleteRoleArgs,
  AddMemberRoleArgs,
  RemoveMemberRoleArgs,
  AddGuildMemberArgs
} from "../_shared/DiscordAsyncTypes.ts";
import * as discord from "../_shared/DiscordWrapper.ts";
import { beginWorkerRun } from "../_shared/workerRun.ts";
import {
  classifyDiscordError,
  isBotPermissionProblem,
  isRateLimitError,
  isResourceGone
} from "../_shared/DiscordErrorClassification.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

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

async function requeueWithDelay(
  adminSupabase: SupabaseClient<Database>,
  envelope: DiscordAsyncEnvelope,
  delaySeconds: number,
  scope: Sentry.Scope
) {
  const newRetryCount = (envelope.retry_count ?? 0) + 1;
  console.log(
    `[requeueWithDelay] Requeuing envelope with method=${envelope.method}, retry_count=${newRetryCount}, delay=${delaySeconds}s`
  );
  const newEnvelope: DiscordAsyncEnvelope = {
    ...envelope,
    retry_count: newRetryCount
  };
  const result = await adminSupabase.schema("pgmq_public").rpc("send", {
    queue_name: "discord_async_calls",
    message: newEnvelope as unknown as Json,
    sleep_seconds: delaySeconds
  });
  if (result.error) {
    console.error(`[requeueWithDelay] Failed to requeue:`, result.error);
    scope.setContext("requeue_error", { error_message: result.error.message, delay_seconds: delaySeconds });
    Sentry.captureException(result.error, scope);
  } else {
    console.log(`[requeueWithDelay] Successfully requeued envelope`);
  }
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
  },
  scope: Sentry.Scope
): Promise<void> {
  try {
    const { error } = await adminSupabase.rpc("record_discord_membership_status", {
      p_class_id: args.classId,
      p_user_id: args.userId,
      p_guild_id: args.guildId,
      p_state: args.state,
      p_discord_error_code: args.discordErrorCode,
      p_detail: args.detail
    });
    if (error) {
      throw error;
    }
    console.log(
      `[recordMembershipStatus] Recorded ${args.state} for user ${args.userId} in class ${args.classId} (guild ${args.guildId})`
    );
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
// Slash Command Registration
// ============================================================================

const DISCORD_API_BASE = "https://discord.com/api/v10";
/** Deadline for the raw membership-check fetch, matching DiscordWrapper's own fetch timeout. */
const MEMBERSHIP_CHECK_TIMEOUT_MS = 10000;

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
      const response = await fetch(`${DISCORD_API_BASE}/applications/${applicationId}/commands`, {
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
  /** Discord is rate limiting this route. Nothing else in the run will fare better. */
  | { result: "rate_limited"; retryAfterMs: number }
  /** The check failed for a reason that says nothing about the user. */
  | { result: "unknown" };

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
    const response = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/members/${discordUserId}`, {
      method: "GET",
      headers: { Authorization: `Bot ${botToken}` },
      signal: controller.signal
    });
    // Read before the body is discarded below. Discord sends seconds, possibly fractional.
    const retryAfterHeader = response.status === 429 ? response.headers.get("retry-after") : null;

    // The body is never read on any branch. Left dangling it holds the connection out of the pool
    // for one roster's worth of responses at a time, and Deno warns that response bodies were not
    // consumed. Cancelling releases it immediately.
    await response.body?.cancel();

    if (response.status === 200) return { result: "member" };
    if (response.status === 404) return { result: "not_member" };
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
    return { result: "unknown" };
  } catch {
    return { result: "unknown" };
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
): Promise<"created" | "cannot_invite" | "error"> {
  const knownFailure = guildInviteFailures.get(record.discord_server_id);
  if (knownFailure) {
    await recordMembershipStatus(
      adminSupabase,
      {
        classId: record.class_id,
        userId: record.user_id,
        guildId: record.discord_server_id,
        state: "cannot_invite",
        discordErrorCode: knownFailure.code,
        detail: knownFailure.reason
      },
      scope
    );
    return "cannot_invite";
  }

  try {
    // Same courtesy delay the membership check uses. createGuildInvite is two Discord calls (list
    // channels, then create), and a class where nobody has joined yet reaches here once per enrolled
    // student back to back — enough to rate-limit the bot for every other class in the same run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const invite = await discord.createGuildInvite(record.discord_server_id, 604800, 5, scope); // 7 days, 5 uses
    const expiresAt = new Date(Date.now() + 604800 * 1000);

    const { error: inviteError } = await adminSupabase.from("discord_invites").upsert(
      {
        user_id: record.user_id,
        class_id: record.class_id,
        guild_id: record.discord_server_id,
        invite_code: invite.code,
        invite_url: invite.url,
        expires_at: expiresAt.toISOString(),
        used: false
      },
      { onConflict: "user_id,class_id,guild_id" }
    );

    if (inviteError) {
      // Rethrown, matching the envelope path: an invite nobody can find is no invite at all, since
      // PendingInvites reads discord_invites and the student never sees a URL without the row.
      // Swallowed, this run moved on and the next one found no stored invite, minted another, and
      // failed to store that too -- one orphan Discord invite per affected student per hour, up to
      // 168 alive at once given the 7-day expiry, with the roster still reading "not checked yet".
      console.error(`[ensureInviteForUser] Failed to store invite:`, inviteError);
      scope.setContext("invite_storage_error", { error_message: inviteError.message });
      throw inviteError;
    }

    await recordMembershipStatus(
      adminSupabase,
      {
        classId: record.class_id,
        userId: record.user_id,
        guildId: record.discord_server_id,
        state: "not_joined",
        detail: `Invite ${invite.url} is waiting to be used`
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
            discord_server_id: record.discord_server_id
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
  // Guilds whose invite creation has already failed this run, so the failure costs one call, not one
  // call per enrolled student.
  const guildInviteFailures = new Map<string, { code?: number; reason: string }>();

  for (const record of records) {
    const cacheKey = `${record.discord_server_id}:${record.discord_id}`;
    const knownForbidden = forbiddenGuilds.get(record.discord_server_id);

    // Check membership if not cached, and never for a guild already known to be unreadable this run.
    if (knownForbidden === undefined && !membershipCache.has(cacheKey)) {
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
      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const membership: MembershipCheck =
      knownForbidden !== undefined ? { result: "forbidden", status: knownForbidden } : membershipCache.get(cacheKey)!;

    if (membership.result === "unknown") {
      // Nothing was learned about this user, so nothing is recorded and nothing is enqueued. The next
      // run will check again.
      summary.errors++;
      continue;
    }

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
    const { data: existingInvite } = await adminSupabase
      .from("discord_invites")
      .select("id")
      .eq("user_id", record.user_id)
      .eq("class_id", record.class_id)
      .eq("guild_id", record.discord_server_id)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (existingInvite) {
      summary.not_in_guild++;
      await recordMembershipStatus(
        adminSupabase,
        {
          classId: record.class_id,
          userId: record.user_id,
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
            await adminSupabase.from("discord_channels").delete().eq("discord_channel_id", args.channel_id);
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

        const result = await discord.createRole(args, scope);
        console.log(`[processEnvelope] Successfully created role, id=${result.id}`);

        // Store role in discord_roles table if class_id and role_type are provided
        if (envelope.class_id && envelope.role_type) {
          console.log(
            `[processEnvelope] Storing role tracking: class_id=${envelope.class_id}, role_type=${envelope.role_type}`
          );
          try {
            await adminSupabase.from("discord_roles").insert({
              class_id: envelope.class_id,
              discord_role_id: result.id,
              role_type: envelope.role_type
            });
            console.log(`[processEnvelope] Successfully stored role tracking`);
          } catch (e) {
            console.error(`[processEnvelope] Failed to store role tracking:`, e);
            scope.setContext("role_tracking_error", {
              error_message: e instanceof Error ? e.message : String(e)
            });
            Sentry.captureException(e, scope);
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
            await adminSupabase.from("discord_roles").delete().eq("discord_role_id", args.role_id);
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

            try {
              const invite = await discord.createGuildInvite(args.guild_id, 604800, 5, scope); // 7 days, 5 uses
              console.log(`[processEnvelope] Created invite for user ${args.user_id}: ${invite.url}`);

              if (envelope.class_id && platformUserId) {
                const expiresAt = new Date(Date.now() + 604800 * 1000); // 7 days

                const { error: storeError } = await adminSupabase.from("discord_invites").upsert(
                  {
                    user_id: platformUserId,
                    class_id: envelope.class_id,
                    guild_id: args.guild_id,
                    invite_code: invite.code,
                    invite_url: invite.url,
                    expires_at: expiresAt.toISOString(),
                    used: false
                  },
                  {
                    onConflict: "user_id,class_id,guild_id"
                  }
                );

                if (storeError) {
                  // An invite nobody can find is no invite at all: PendingInvites reads
                  // discord_invites, so without the row the student never sees the URL. Rethrown so
                  // the ordinary retry path gets another chance to persist it, rather than recording
                  // a status that claims an invite is waiting when none is reachable.
                  console.error(`[processEnvelope] Failed to store invite in database:`, storeError);
                  scope.setContext("invite_storage_error", {
                    error_message: storeError.message,
                    invite_code: invite.code
                  });
                  throw storeError;
                }

                console.log(
                  `[processEnvelope] Stored invite in database: user_id=${platformUserId}, class_id=${envelope.class_id}`
                );

                await recordMembershipStatus(
                  adminSupabase,
                  {
                    classId: envelope.class_id,
                    userId: platformUserId,
                    guildId: args.guild_id,
                    state: "not_joined",
                    detail: `Invite ${invite.url} is waiting to be used`
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

        await discord.removeMemberRole(args, scope);
        console.log(`[processEnvelope] remove_member_role completed successfully`);
        return true;
      }

      case "add_guild_member": {
        const args = envelope.args as AddGuildMemberArgs;
        console.log(
          `[processEnvelope] Processing add_guild_member: user_id=${args.user_id}, guild_id=${args.guild_id}`
        );
        Sentry.addBreadcrumb({
          message: `Adding user ${args.user_id} to guild ${args.guild_id}`,
          level: "info"
        });

        const result = await discord.addGuildMember(args, scope);
        console.log(`[processEnvelope] Successfully added user to guild: ${result.user.username}`);
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
        throw new Error(`Unknown async method: ${unknownMethod}`);
      }
    }
  } catch (error) {
    console.error(`[processEnvelope] Error processing envelope:`, error);
    console.trace(error);

    // A failure that cannot succeed on a later attempt is dead-lettered once, not retried. Requeueing
    // it buys five more identical failures before the same dead-letter row, and the hourly enqueue
    // brings it straight back — which is how 30,332 dead-lettered operations accumulated for ~30
    // users. What fixed that flood was removing the *retries* and recording the membership outcome as
    // state; the operations that reach here have no such record, so the DLQ row is their only durable
    // evidence and the growth signal PawtograderDiscordDLQGrowing is built on.
    const classification = classifyDiscordError(error);
    if (classification.terminal) {
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

      await requeueWithDelay(adminSupabase, envelope, delay, scope);
      await archiveMessage(adminSupabase, meta.msg_id, scope);
      return false;
    }

    // For non-rate-limit errors, requeue with 2-minute delay
    console.log(`[processEnvelope] Non-rate-limit error, requeuing with 2-minute delay`);
    scope.setContext("async_error", {
      method: envelope.method,
      error_message: error instanceof Error ? error.message : String(error),
      requeue_delay_seconds: 120
    });

    await requeueWithDelay(adminSupabase, envelope, 120, scope); // 2 minutes
    await archiveMessage(adminSupabase, meta.msg_id, scope);
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

  console.log(`[runBatchHandler] Creating Supabase client with URL: ${supabaseUrl.substring(0, 30)}...`);
  const adminSupabase = createClient<Database>(supabaseUrl, supabaseKey);

  // Leased when Redis is configured, bounded otherwise -- see _shared/workerRun.ts.
  const run = await beginWorkerRun({
    name: "discord_async_worker",
    scope,
    idleSleepMs: 15000,
    errorSleepMs: 5000
  });
  if (!run) {
    console.log(`[runBatchHandler] Another worker holds the lease; nothing to do`);
    return;
  }
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

Deno.serve((req) => {
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
    EdgeRuntime.waitUntil(
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
