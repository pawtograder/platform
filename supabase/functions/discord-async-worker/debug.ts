#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { DiscordAsyncEnvelope } from "../_shared/DiscordAsyncTypes.ts";

// Import the processEnvelope function directly from the main worker
import { processEnvelope } from "./index.ts";

async function debugProcessEnvelope(envelopeJson: string) {
  const scope = new Sentry.Scope();
  scope.setTag("function", "discord_async_worker_debug");
  scope.setTag("debug_mode", "true");

  try {
    // Parse the envelope JSON
    let envelope: DiscordAsyncEnvelope;
    try {
      envelope = JSON.parse(envelopeJson);
    } catch (error) {
      console.error("❌ Invalid JSON:", error instanceof Error ? error.message : String(error));
      console.log("\n📝 Example envelope:");
      console.log(
        JSON.stringify(
          {
            method: "send_message",
            class_id: 123,
            debug_id: "debug-test",
            args: {
              channel_id: "123456789012345678",
              content: "Test message",
              embeds: [
                {
                  title: "Test Embed",
                  description: "This is a test",
                  color: 3447003
                }
              ]
            },
            resource_type: "help_request",
            resource_id: 456
          },
          null,
          2
        )
      );
      return;
    }

    // Validate envelope structure
    if (!envelope.method || !envelope.args) {
      console.error("❌ Invalid envelope structure. Must have 'method' and 'args' fields");
      console.error("Received:", JSON.stringify(envelope, null, 2));
      return;
    }

    console.log("🚀 Processing envelope:", JSON.stringify(envelope, null, 2));
    console.log("⏱️  Started at:", new Date().toISOString());

    // Check required environment variables
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ Missing required environment variables:");
      if (!supabaseUrl) console.error("  - SUPABASE_URL");
      if (!supabaseKey) console.error("  - SUPABASE_SERVICE_ROLE_KEY");
      return;
    }

    console.log("✅ Environment variables configured");
    console.log(`   SUPABASE_URL: ${supabaseUrl.substring(0, 30)}...`);

    const adminSupabase = createClient<Database>(supabaseUrl, supabaseKey);

    // Create debug metadata
    const meta = {
      msg_id: -1, // Debug mode, no real message ID
      enqueued_at: new Date().toISOString()
    };

    // Add debug tags to scope
    scope.setTag("async_method", envelope.method);
    if (envelope.class_id) scope.setTag("class_id", String(envelope.class_id));
    if (envelope.debug_id) scope.setTag("debug_id", envelope.debug_id);

    console.log("📋 Method:", envelope.method);
    if (envelope.class_id) console.log("🏫 Class ID:", envelope.class_id);
    if (envelope.debug_id) console.log("🔍 Debug ID:", envelope.debug_id);
    if (envelope.retry_count !== undefined) console.log("🔄 Retry Count:", envelope.retry_count);
    console.log("");

    // Call the actual processEnvelope function from index.ts
    console.log("🔄 Calling processEnvelope...");
    const success = await processEnvelope(adminSupabase, envelope, meta, scope);

    console.log("");
    console.log("⏱️  Completed at:", new Date().toISOString());

    if (success) {
      console.log("✅ Operation completed successfully");
    } else {
      console.log("❌ Operation failed - check logs above for details");
    }

    console.log("");
    console.log("📊 Debug Info:");
    console.log("  - Used same processEnvelope function as production worker");
    console.log("  - Message ID:", meta.msg_id, "(debug mode)");
    console.log("  - Enqueued at:", meta.enqueued_at);
  } catch (error) {
    console.error("💥 Unexpected error:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("Stack trace:", error.stack);
    }
    Sentry.captureException(error, scope);
  }
}

// Main CLI logic
async function main() {
  const args = Deno.args;

  if (args.length === 0) {
    console.log("🔧 Discord Async Worker Debug Tool");
    console.log("");
    console.log("Usage:");
    console.log("  deno run --allow-net --allow-env --allow-read debug.ts '<envelope-json>'");
    console.log("");
    console.log("Example (send_message):");
    console.log(
      `  deno run --allow-net --allow-env --allow-read debug.ts '${JSON.stringify({
        method: "send_message",
        class_id: 123,
        debug_id: "debug-test",
        args: {
          channel_id: "123456789012345678",
          content: "Test message",
          embeds: [
            {
              title: "Test Embed",
              description: "This is a test",
              color: 3447003
            }
          ]
        },
        resource_type: "help_request",
        resource_id: 456
      })}'`
    );
    console.log("");
    console.log("Example (create_channel):");
    console.log(
      `  deno run --allow-net --allow-env --allow-read debug.ts '${JSON.stringify({
        method: "create_channel",
        class_id: 123,
        debug_id: "debug-test",
        args: {
          guild_id: "123456789012345678",
          name: "test-channel",
          type: 0
        }
      })}'`
    );
    console.log("");
    console.log("Environment variables required:");
    console.log("  - SUPABASE_URL");
    console.log("  - SUPABASE_SERVICE_ROLE_KEY");
    console.log("");
    console.log("💡 Tip: You can also pipe JSON from a file:");
    console.log("  echo '{...}' | deno run --allow-net --allow-env --allow-read debug.ts");
    return;
  }

  let envelopeJson: string;

  if (args[0] === "-" || args.length === 0) {
    // Read from stdin
    const chunks = [];
    const reader = Deno.stdin.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const decoder = new TextDecoder();
    envelopeJson = decoder.decode(combined).trim();
  } else {
    // Use command line argument
    envelopeJson = args[0];
  }

  if (!envelopeJson) {
    console.error("❌ No envelope JSON provided");
    return;
  }

  await debugProcessEnvelope(envelopeJson);
}

// Check if this script is being run directly
if (import.meta.main) {
  await main();
}
