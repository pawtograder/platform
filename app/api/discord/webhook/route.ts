import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { verify } from "@noble/ed25519";

/**
 * Discord webhook endpoint to handle guild member join events
 *
 * This endpoint receives webhooks from Discord when users join servers.
 * When a user joins, we:
 * 1. Mark any pending invites as used
 * 2. Enqueue role sync operations to assign their Pawtograder roles
 *
 * Discord webhook signature verification uses ed25519.
 * The signature is in the X-Signature-Ed25519 header and the timestamp
 * is in the X-Signature-Timestamp header.
 */
export async function POST(request: NextRequest) {
  const scope = Sentry.getCurrentScope();

  try {
    // Get webhook public key from environment
    // This is the public key from Discord Developer Portal → Your App → Webhooks → Your Webhook
    const webhookPublicKey = process.env.DISCORD_WEBHOOK_PUBLIC_KEY;
    if (!webhookPublicKey) {
      scope.setTag("error_type", "missing_public_key");
      Sentry.captureMessage("DISCORD_WEBHOOK_PUBLIC_KEY not configured", {
        level: "error"
      });
      return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
    }

    // Get signature headers
    const signatureHex = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");

    if (!signatureHex || !timestamp) {
      scope.setTag("error_type", "missing_signature");
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    // Get raw body for signature verification
    const body = await request.text();

    // Verify signature using ed25519
    // Discord signs: timestamp + body (as UTF-8 string)
    // Signature is hex-encoded in X-Signature-Ed25519 header
    // Public key is hex-encoded in DISCORD_WEBHOOK_PUBLIC_KEY env var
    try {
      // Convert hex strings to Uint8Array
      const signature = hexToBytes(signatureHex);
      const publicKey = hexToBytes(webhookPublicKey);

      // Message to verify: timestamp + body (as UTF-8)
      const message = new TextEncoder().encode(timestamp + body);

      // Verify signature
      const isValid = await verify(signature, message, publicKey);

      if (!isValid) {
        scope.setTag("error_type", "invalid_signature");
        scope.setContext("signature_verification", {
          signature_length: signature.length,
          message_length: message.length,
          public_key_length: publicKey.length
        });
        Sentry.captureMessage("Discord webhook signature verification failed", {
          level: "warning",
          tags: { error_type: "invalid_signature" }
        });
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch (verifyError) {
      scope.setTag("error_type", "signature_verification_error");
      scope.setContext("verification_exception", {
        error: verifyError instanceof Error ? verifyError.message : String(verifyError),
        stack: verifyError instanceof Error ? verifyError.stack : undefined
      });
      Sentry.captureException(verifyError, scope);
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }

    let payload: DiscordWebhookPayload;
    try {
      payload = JSON.parse(body) as DiscordWebhookPayload;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.error("Failed to parse Discord webhook payload:", e);
      scope.setContext("parse_error", {
        error: errorMessage
      });
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // Handle different event types
    if (payload.type === 1) {
      // PING event - Discord sends this to verify the webhook
      return NextResponse.json({ type: 1 });
    }

    if (payload.type === 0 && payload.t === "GUILD_MEMBER_ADD") {
      // User joined a guild
      const member = payload.d as DiscordGuildMember;
      const memberData = payload.d as DiscordGuildMember & { guild_id?: string };
      const guildId = member.guild_id || memberData.guild_id;
      const userId = member.user?.id;

      if (!guildId || !userId) {
        scope.setContext("invalid_event", {
          guild_id: guildId,
          user_id: userId,
          payload: JSON.stringify(payload)
        });
        return NextResponse.json({ error: "Invalid event data" }, { status: 400 });
      }

      // eslint-disable-next-line no-console
      console.log(`[Discord Webhook] User ${userId} joined guild ${guildId}`);
      scope.setTag("guild_id", guildId);
      scope.setTag("discord_user_id", userId);
      scope.setContext("guild_member_add", {
        guild_id: guildId,
        user_id: userId,
        username: member.user?.username,
        discriminator: member.user?.discriminator
      });

      // Get admin Supabase client
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!supabaseUrl || !supabaseServiceKey) {
        scope.setTag("error_type", "missing_supabase_config");
        Sentry.captureMessage("Missing Supabase configuration for Discord webhook", {
          level: "error"
        });
        return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
      }

      const adminSupabase = createAdminClient<Database>(supabaseUrl, supabaseServiceKey);

      // Find user by Discord ID
      const { data: userData, error: userError } = await adminSupabase
        .from("users")
        .select("user_id")
        .eq("discord_id", userId)
        .single();

      if (userError || !userData) {
        // User not found - they might not have linked Discord yet
        scope.setContext("user_not_found", {
          discord_id: userId,
          error: userError?.message
        });
        // Return success - we'll handle role assignment when they link Discord
        return NextResponse.json({ received: true });
      }

      // Mark invites as used for this user/guild
      try {
        const { error: markError } = await adminSupabase.rpc("mark_discord_invite_used", {
          p_user_id: userData.user_id,
          p_guild_id: guildId
        });

        if (markError) {
          // eslint-disable-next-line no-console
          console.error(`[Discord Webhook] Failed to mark invites as used:`, markError);
          scope.setContext("mark_invite_error", {
            error: markError.message
          });
        } else {
          // eslint-disable-next-line no-console
          console.log(`[Discord Webhook] Marked invites as used for user ${userData.user_id}, guild ${guildId}`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[Discord Webhook] Error marking invites:`, e);
        scope.setContext("mark_invite_exception", {
          error: e instanceof Error ? e.message : String(e)
        });
      }

      // Find all classes with this Discord server ID
      const { data: classes, error: classesError } = await adminSupabase
        .from("classes")
        .select("id")
        .eq("discord_server_id", guildId);

      if (classesError) {
        // eslint-disable-next-line no-console
        console.error(`[Discord Webhook] Failed to find classes:`, classesError);
        scope.setContext("classes_error", {
          error: classesError.message
        });
        Sentry.captureException(classesError, scope);
        return NextResponse.json({ received: true }); // Don't fail the webhook
      }

      // Enqueue role sync for each class the user has a role in
      if (classes && classes.length > 0) {
        for (const classData of classes) {
          // Get user's roles for this class
          const { data: userRoles, error: rolesError } = await adminSupabase
            .from("user_roles")
            .select("role")
            .eq("user_id", userData.user_id)
            .eq("class_id", classData.id)
            .eq("disabled", false);

          if (!rolesError && userRoles) {
            for (const userRole of userRoles) {
              // Enqueue role sync
              try {
                const { error: syncError } = await adminSupabase.rpc("enqueue_discord_role_sync", {
                  p_user_id: userData.user_id,
                  p_class_id: classData.id,
                  p_role: userRole.role,
                  p_action: "add"
                });

                if (syncError) {
                  // eslint-disable-next-line no-console
                  console.error(
                    `[Discord Webhook] Failed to enqueue role sync for user ${userData.user_id}, class ${classData.id}, role ${userRole.role}:`,
                    syncError
                  );
                  scope.setContext("role_sync_error", {
                    user_id: userData.user_id,
                    class_id: classData.id,
                    role: userRole.role,
                    error: syncError.message
                  });
                } else {
                  // eslint-disable-next-line no-console
                  console.log(
                    `[Discord Webhook] Enqueued role sync for user ${userData.user_id}, class ${classData.id}, role ${userRole.role}`
                  );
                }
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error(`[Discord Webhook] Exception enqueueing role sync:`, e);
                scope.setContext("role_sync_exception", {
                  error: e instanceof Error ? e.message : String(e)
                });
              }
            }
          }
        }
      }

      Sentry.addBreadcrumb({
        message: `Processed Discord guild member add: user ${userId} joined guild ${guildId}`,
        level: "info"
      });

      return NextResponse.json({ received: true });
    }

    // Unknown event type - log but don't fail
    const eventType = payload.t || "unknown";
    // eslint-disable-next-line no-console
    console.log(`[Discord Webhook] Unknown event type: ${payload.type}, t: ${eventType}`);
    scope.setContext("unknown_event", {
      type: payload.type,
      t: eventType,
      payload: JSON.stringify(payload).substring(0, 500)
    });

    return NextResponse.json({ received: true });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[Discord Webhook] Error processing webhook:", error);
    scope.setContext("webhook_error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    Sentry.captureException(error, scope);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Discord webhook payload types
type DiscordWebhookPayload = {
  type: number; // 1 = PING, 0 = event
  t?: string; // Event type (e.g., "GUILD_MEMBER_ADD")
  d?: DiscordGuildMember | Record<string, unknown>; // Event data
};

type DiscordGuildMember = {
  user?: {
    id: string;
    username: string;
    discriminator: string;
    avatar?: string;
  };
  guild_id?: string;
  roles?: string[];
  joined_at?: string;
};

/**
 * Convert hex string to Uint8Array
 * Handles both with and without 0x prefix
 */
function hexToBytes(hex: string): Uint8Array {
  // Remove 0x prefix if present
  const cleanHex = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;

  // Ensure even length
  if (cleanHex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${cleanHex.length}`);
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}
