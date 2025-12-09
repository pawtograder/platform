import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
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

async function archiveMessage(adminSupabase: SupabaseClient<Database>, msgId: number, scope: Sentry.Scope) {
  console.log(`[archiveMessage] Archiving message ${msgId}`);
  try {
    await adminSupabase.schema("pgmq_public").rpc("archive", {
      queue_name: "discord_async_calls",
      message_id: msgId
    });
    console.log(`[archiveMessage] Successfully archived message ${msgId}`);
  } catch (error) {
    console.error(`[archiveMessage] Failed to archive message ${msgId}:`, error);
    scope.setContext("archive_error", {
      msg_id: msgId,
      error_message: error instanceof Error ? error.message : String(error)
    });
    Sentry.captureException(error, scope);
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
  const err = error as { message?: string };
  const msg = err?.message || "";

  if (msg.includes("rate limit") || msg.includes("429")) {
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

        const result = await discord.sendMessage(args, scope);
        console.log(`[processEnvelope] Successfully sent message, id=${result.id}, channel_id=${result.channel_id}`);

        // Store message in discord_messages table if resource tracking is provided
        if (envelope.resource_type && envelope.resource_id && envelope.class_id) {
          console.log(
            `[processEnvelope] Storing message tracking: resource_type=${envelope.resource_type}, resource_id=${envelope.resource_id}`
          );
          try {
            await adminSupabase.from("discord_messages").insert({
              class_id: envelope.class_id,
              discord_message_id: result.id,
              discord_channel_id: result.channel_id,
              resource_type: envelope.resource_type,
              resource_id: envelope.resource_id
            });
            console.log(`[processEnvelope] Successfully stored message tracking`);
          } catch (e) {
            console.error(`[processEnvelope] Failed to store message tracking:`, e);
            // Log but don't fail - message was sent successfully
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

        await discord.deleteChannel(args, scope);
        console.log(`[processEnvelope] Successfully deleted channel`);

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

        await discord.deleteRole(args, scope);
        console.log(`[processEnvelope] Successfully deleted role`);

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
            // User is not in the guild - create an invite link
            console.log(`[processEnvelope] User ${args.user_id} not in guild ${args.guild_id}, creating invite`);
            const invite = await discord.createGuildInvite(args.guild_id, 604800, 1, scope); // 7 days, 1 use

            // Log the invite - in production, you might want to send this via email or store it
            console.log(`[processEnvelope] Created invite for user ${args.user_id}: ${invite.url}`);
            scope.setContext("discord_invite_created", {
              user_id: args.user_id,
              guild_id: args.guild_id,
              invite_code: invite.code,
              invite_url: invite.url
            });
            Sentry.captureMessage(`Discord invite created for user not in server: ${invite.url}`, {
              level: "info",
              tags: { user_id: args.user_id, guild_id: args.guild_id }
            });

            // Don't fail - the invite was created, user can join later
            // The role will be added when they join and the sync runs again
            return true;
          }

          // User is in guild, add the role
          await discord.addMemberRole(args, scope);
          console.log(`[processEnvelope] add_member_role completed successfully`);
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

      default:
        const unknownMethod = (envelope as DiscordAsyncEnvelope).method;
        console.error(`[processEnvelope] Unknown async method: ${unknownMethod}`);
        throw new Error(`Unknown async method: ${unknownMethod}`);
    }
  } catch (error) {
    console.error(`[processEnvelope] Error processing envelope:`, error);
    console.trace(error);
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
        await archiveMessage(adminSupabase, meta.msg_id, scope);
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
    Sentry.captureException(error, scope);

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

  const isRunning = true;
  let iteration = 0;
  while (isRunning) {
    iteration++;
    console.log(`[runBatchHandler] Iteration ${iteration}, processing batch...`);
    try {
      const hasWork = await processBatch(adminSupabase, scope);
      if (!hasWork) {
        console.log(`[runBatchHandler] No work found, sleeping for 15s`);
        await new Promise((resolve) => setTimeout(resolve, 15000));
      } else {
        console.log(`[runBatchHandler] Work completed, continuing immediately`);
      }
    } catch (e) {
      console.error(`[runBatchHandler] Error in batch handler:`, e);
      Sentry.captureException(e, scope);
      console.log(`[runBatchHandler] Sleeping for 5s after error`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
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
    EdgeRuntime.waitUntil(runBatchHandler());
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
