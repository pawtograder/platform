import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { verify } from "@noble/ed25519";

/**
 * Discord Interactions endpoint for handling slash commands
 *
 * This endpoint receives interactions from Discord when users invoke
 * slash commands like /sync-roles.
 *
 * Discord interaction types:
 * - 1: PING (verification)
 * - 2: APPLICATION_COMMAND (slash commands)
 * - 3: MESSAGE_COMPONENT (buttons, selects)
 * - 4: APPLICATION_COMMAND_AUTOCOMPLETE
 * - 5: MODAL_SUBMIT
 *
 * Response types:
 * - 1: PONG
 * - 4: CHANNEL_MESSAGE_WITH_SOURCE
 * - 5: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
 * - 6: DEFERRED_UPDATE_MESSAGE
 * - 7: UPDATE_MESSAGE
 */
export async function POST(request: NextRequest) {
  const scope = Sentry.getCurrentScope();
  scope.setTag("endpoint", "discord_interactions");

  try {
    // Get public key from environment
    // This is from Discord Developer Portal → Your App → General Information → Public Key
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      scope.setTag("error_type", "missing_public_key");
      Sentry.captureMessage("DISCORD_PUBLIC_KEY not configured", {
        level: "error"
      });
      return NextResponse.json({ error: "Interactions not configured" }, { status: 500 });
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
    try {
      const signature = hexToBytes(signatureHex);
      const pubKeyBytes = hexToBytes(publicKey);
      const message = new TextEncoder().encode(timestamp + body);
      const isValid = await verify(signature, message, pubKeyBytes);

      if (!isValid) {
        scope.setTag("error_type", "invalid_signature");
        Sentry.captureMessage("Discord interactions signature verification failed", {
          level: "warning"
        });
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch (verifyError) {
      scope.setTag("error_type", "signature_verification_error");
      Sentry.captureException(verifyError, scope);
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(body) as DiscordInteraction;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Failed to parse Discord interaction:", e);
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    scope.setContext("interaction", {
      type: interaction.type,
      command_name: interaction.data?.name,
      guild_id: interaction.guild_id,
      user_id: interaction.member?.user?.id || interaction.user?.id
    });

    // Handle PING (type 1) - Discord verification
    if (interaction.type === 1) {
      return NextResponse.json({ type: 1 }); // PONG
    }

    // Handle APPLICATION_COMMAND (type 2) - Slash commands
    if (interaction.type === 2 && interaction.data?.name === "sync-roles") {
      return await handleSyncRolesCommand(interaction, scope);
    }

    // Unknown interaction type - acknowledge but don't process
    // eslint-disable-next-line no-console
    console.log(
      `[Discord Interactions] Unknown interaction type: ${interaction.type}, name: ${interaction.data?.name}`
    );

    return NextResponse.json({
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: {
        content: "Unknown command",
        flags: 64 // EPHEMERAL
      }
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[Discord Interactions] Error:", error);
    Sentry.captureException(error, scope);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Handle the /sync-roles slash command
 * This syncs the user's Pawtograder roles in the current Discord server
 */
async function handleSyncRolesCommand(interaction: DiscordInteraction, scope: Sentry.Scope): Promise<NextResponse> {
  const guildId = interaction.guild_id;
  const discordUserId = interaction.member?.user?.id || interaction.user?.id;

  if (!guildId) {
    return NextResponse.json({
      type: 4,
      data: {
        content: "❌ This command can only be used in a server.",
        flags: 64
      }
    });
  }

  if (!discordUserId) {
    return NextResponse.json({
      type: 4,
      data: {
        content: "❌ Could not identify user.",
        flags: 64
      }
    });
  }

  // Get Supabase client
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    scope.setTag("error_type", "missing_supabase_config");
    Sentry.captureMessage("Missing Supabase configuration for Discord interactions", {
      level: "error"
    });
    return NextResponse.json({
      type: 4,
      data: {
        content: "❌ Server configuration error. Please contact an administrator.",
        flags: 64
      }
    });
  }

  const adminSupabase = createAdminClient<Database>(supabaseUrl, supabaseServiceKey);

  // Find user by Discord ID
  const { data: userData, error: userError } = await adminSupabase
    .from("users")
    .select("user_id, name")
    .eq("discord_id", discordUserId)
    .single();

  if (userError || !userData) {
    return NextResponse.json({
      type: 4,
      data: {
        content:
          "❌ Your Discord account is not linked to a Pawtograder account.\n\n" +
          "Please link your Discord account in Pawtograder first:\n" +
          "1. Go to any course in Pawtograder\n" +
          "2. Navigate to **Discord** in the course menu\n" +
          "3. Click **Link Discord Account**",
        flags: 64
      }
    });
  }

  // Find classes with this Discord server
  const { data: classes, error: classesError } = await adminSupabase
    .from("classes")
    .select("id, name, slug")
    .eq("discord_server_id", guildId);

  if (classesError) {
    scope.setContext("classes_error", { error: classesError.message });
    Sentry.captureException(classesError, scope);
    return NextResponse.json({
      type: 4,
      data: {
        content: "❌ Error finding classes. Please try again later.",
        flags: 64
      }
    });
  }

  if (!classes || classes.length === 0) {
    return NextResponse.json({
      type: 4,
      data: {
        content:
          "❌ This Discord server is not connected to any Pawtograder classes.\n\n" +
          "Ask your instructor to connect this server in the course settings.",
        flags: 64
      }
    });
  }

  // Get user's roles for these classes and enqueue sync
  let syncedCount = 0;
  const syncedClasses: string[] = [];

  for (const classData of classes) {
    const { data: userRoles, error: rolesError } = await adminSupabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user_id)
      .eq("class_id", classData.id)
      .eq("disabled", false);

    if (rolesError) {
      // eslint-disable-next-line no-console
      console.error(`[Discord Interactions] Error fetching roles for class ${classData.id}:`, rolesError);
      continue;
    }

    if (userRoles && userRoles.length > 0) {
      for (const userRole of userRoles) {
        try {
          const { error: syncError } = await adminSupabase.rpc("enqueue_discord_role_sync", {
            p_user_id: userData.user_id,
            p_class_id: classData.id,
            p_role: userRole.role,
            p_action: "add"
          });

          if (syncError) {
            // eslint-disable-next-line no-console
            console.error(`[Discord Interactions] Error enqueueing sync:`, syncError);
          } else {
            syncedCount++;
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[Discord Interactions] Exception enqueueing sync:`, e);
        }
      }

      syncedClasses.push(classData.name || classData.slug || `Class ${classData.id}`);
    }
  }

  // Also mark any pending invites as used
  try {
    await adminSupabase.rpc("mark_discord_invite_used", {
      p_user_id: userData.user_id,
      p_guild_id: guildId
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[Discord Interactions] Error marking invites as used:", e);
  }

  if (syncedCount === 0) {
    return NextResponse.json({
      type: 4,
      data: {
        content:
          "⚠️ You don't have any roles to sync in this server.\n\n" +
          "Make sure you're enrolled in a class that uses this Discord server.",
        flags: 64
      }
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `[Discord Interactions] Synced ${syncedCount} roles for user ${userData.user_id} (${userData.name}) in guild ${guildId}`
  );

  Sentry.addBreadcrumb({
    message: `Discord role sync initiated: ${syncedCount} roles for user ${discordUserId}`,
    level: "info"
  });

  return NextResponse.json({
    type: 4,
    data: {
      content:
        `✅ Role sync initiated!\n\n` +
        `**Classes:** ${syncedClasses.join(", ")}\n` +
        `**Roles queued:** ${syncedCount}\n\n` +
        `Your roles should be assigned within a minute.`,
      flags: 64
    }
  });
}

// Discord interaction types
type DiscordInteraction = {
  type: number; // 1 = PING, 2 = APPLICATION_COMMAND, etc.
  id: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user?: {
      id: string;
      username: string;
      discriminator: string;
    };
    roles?: string[];
  };
  user?: {
    id: string;
    username: string;
    discriminator: string;
  };
  data?: {
    id: string;
    name: string;
    options?: Array<{
      name: string;
      value: string | number | boolean;
    }>;
  };
  token: string;
};

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${cleanHex.length}`);
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}
