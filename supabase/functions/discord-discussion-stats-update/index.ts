import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";

/**
 * Discord Discussion Stats Update
 *
 * This edge function is designed to be called hourly via pg_cron.
 * It updates Discord messages for discussion threads with refreshed stats
 * (reply count, likes count, answered status).
 */

interface DiscussionThread {
  id: number;
  class_id: number;
  topic_id: number;
  subject: string;
  body: string;
  is_question: boolean;
  answer: number | null;
  author: string;
  likes_count: number;
  children_count: number;
  created_at: string;
}

interface DiscussionTopic {
  id: number;
  topic: string;
  discord_channel_id: string | null;
}

// Build Discord embed for a discussion thread
function buildThreadEmbed(
  thread: DiscussionThread,
  topic: DiscussionTopic,
  authorName: string
): {
  content: string;
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
    timestamp: string;
  }>;
} {
  // Determine type emoji and label
  const typeEmoji = thread.is_question ? "❓" : "📝";
  const typeLabel = thread.is_question ? "Question" : "Note";

  // Determine status color
  // Blue for notes, orange for unanswered questions, green for answered questions
  let statusColor: number;
  if (!thread.is_question) {
    statusColor = 3447003; // Blue
  } else if (thread.answer !== null) {
    statusColor = 3066993; // Green (answered)
  } else {
    statusColor = 15105570; // Orange (unanswered question)
  }

  // Build answered status text
  let answeredText: string | null = null;
  if (thread.is_question) {
    answeredText = thread.answer !== null ? "✅ Answered" : "⏳ Awaiting Answer";
  }

  // Build message content
  const messageContent = `**${typeLabel} Updated in ${topic.topic}**`;

  // Build fields
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Author", value: authorName, inline: true },
    { name: "Type", value: `${typeEmoji} ${typeLabel}`, inline: true }
  ];

  if (answeredText) {
    fields.push({ name: "Status", value: answeredText, inline: true });
  }

  fields.push({
    name: "Stats",
    value: `💬 ${thread.children_count ?? 0} replies | ❤️ ${thread.likes_count ?? 0} likes`,
    inline: false
  });

  return {
    content: messageContent,
    embeds: [
      {
        title: `${typeEmoji} ${thread.subject}`,
        description: (thread.body || "No content").slice(0, 500),
        color: statusColor,
        fields,
        footer: { text: `Thread #${thread.id} | Topic: ${topic.topic}` },
        timestamp: thread.created_at
      }
    ]
  };
}

async function runStatsUpdate(
  supabase: SupabaseClient<Database>,
  scope: Sentry.Scope
): Promise<{
  processed: number;
  updated: number;
  errors: number;
}> {
  console.log("[discord-discussion-stats-update] Starting stats update");

  const stats = { processed: 0, updated: 0, errors: 0 };

  // Process messages in batches using offset-based pagination
  const batchSize = 500;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    // Fetch batch with offset-based pagination
    const { data: discordMessages, error: messagesError } = await supabase
      .from("discord_messages")
      .select("id, discord_message_id, discord_channel_id, resource_id, class_id")
      .eq("resource_type", "discussion_thread")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (messagesError) {
      console.error("[discord-discussion-stats-update] Error fetching discord messages:", messagesError);
      scope.setContext("messages_error", { error: messagesError.message });
      throw messagesError;
    }

    if (!discordMessages || discordMessages.length === 0) {
      console.log("[discord-discussion-stats-update] No more Discord messages to process");
      hasMore = false;
      break;
    }

    console.log(`[discord-discussion-stats-update] Processing batch of ${discordMessages.length} Discord messages`);

    // Get all thread IDs
    const threadIds = discordMessages.map((m) => m.resource_id);

    // Fetch all threads in one query
    // Note: No need to filter for root threads since only root threads get posted to Discord
    // (the trigger only fires for threads where root = id)
    const { data: threads, error: threadsError } = await supabase
      .from("discussion_threads")
      .select(
        "id, class_id, topic_id, subject, body, is_question, answer, author, likes_count, children_count, created_at"
      )
      .in("id", threadIds);

    if (threadsError) {
      console.error("[discord-discussion-stats-update] Error fetching threads:", threadsError);
      scope.setContext("threads_error", { error: threadsError.message });
      throw threadsError;
    }

    if (!threads || threads.length === 0) {
      console.log("[discord-discussion-stats-update] No matching threads found in this batch");
      // Move to next batch
      offset += batchSize;
      hasMore = discordMessages.length === batchSize;
      continue;
    }

    // Create thread map for quick lookup
    const threadMap = new Map<number, DiscussionThread>();
    for (const thread of threads) {
      threadMap.set(thread.id, thread as DiscussionThread);
    }

    // Get all unique topic IDs
    const topicIds = [...new Set(threads.map((t) => t.topic_id))];

    // Fetch all topics
    const { data: topics, error: topicsError } = await supabase
      .from("discussion_topics")
      .select("id, topic, discord_channel_id")
      .in("id", topicIds);

    if (topicsError) {
      console.error("[discord-discussion-stats-update] Error fetching topics:", topicsError);
      scope.setContext("topics_error", { error: topicsError.message });
      throw topicsError;
    }

    // Create topic map for quick lookup
    const topicMap = new Map<number, DiscussionTopic>();
    for (const topic of topics || []) {
      topicMap.set(topic.id, topic);
    }

    // Get all unique author IDs
    const authorIds = [...new Set(threads.map((t) => t.author))];

    // Fetch all author profiles
    const { data: authors, error: authorsError } = await supabase
      .from("profiles")
      .select("id, name")
      .in("id", authorIds);

    if (authorsError) {
      console.error("[discord-discussion-stats-update] Error fetching authors:", authorsError);
      // Don't fail, just use "Anonymous" for all
    }

    // Create author map for quick lookup
    const authorMap = new Map<string, string>();
    for (const author of authors || []) {
      authorMap.set(author.id, author.name || "Anonymous");
    }

    // Process each Discord message in the batch
    for (const msg of discordMessages) {
      stats.processed++;

      const thread = threadMap.get(msg.resource_id);
      if (!thread) {
        console.warn(`[discord-discussion-stats-update] Thread ${msg.resource_id} not found, skipping`);
        continue;
      }

      const topic = topicMap.get(thread.topic_id);
      if (!topic || !topic.discord_channel_id) {
        console.warn(
          `[discord-discussion-stats-update] Topic ${thread.topic_id} not found or not linked to Discord, skipping`
        );
        continue;
      }

      const authorName = authorMap.get(thread.author) || "Anonymous";

      try {
        // Build the updated embed
        const { content, embeds } = buildThreadEmbed(thread, topic, authorName);

        // Enqueue update message
        const { error: queueError } = await supabase.schema("pgmq_public").rpc("send", {
          queue_name: "discord_async_calls",
          message: {
            method: "update_message",
            args: {
              channel_id: msg.discord_channel_id,
              message_id: msg.discord_message_id,
              content,
              embeds
            },
            class_id: thread.class_id,
            resource_type: "discussion_thread",
            resource_id: thread.id
          } as unknown as Json
        });

        if (queueError) {
          console.error(`[discord-discussion-stats-update] Error queuing update for thread ${thread.id}:`, queueError);
          stats.errors++;
        } else {
          stats.updated++;
        }
      } catch (err) {
        console.error(`[discord-discussion-stats-update] Error processing thread ${thread.id}:`, err);
        stats.errors++;
      }
    }

    // Move to next batch
    offset += batchSize;
    hasMore = discordMessages.length === batchSize;
  }

  console.log(
    `[discord-discussion-stats-update] Completed: ${stats.processed} processed, ${stats.updated} updated, ${stats.errors} errors`
  );
  return stats;
}

// HTTP handler
Deno.serve(async (req) => {
  console.log(`[discord-discussion-stats-update] Received request: ${req.method}`);

  const scope = new Sentry.Scope();
  scope.setTag("function", "discord-discussion-stats-update");

  // Verify request has proper auth
  const secret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");
  const webhookSource = req.headers.get("x-supabase-webhook-source");

  // Allow cron job requests or requests with valid secret
  if (webhookSource !== "discord-discussion-stats-update" && secret !== expectedSecret) {
    console.error("[discord-discussion-stats-update] Unauthorized request");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error("[discord-discussion-stats-update] Missing required environment variables");
    return new Response(JSON.stringify({ error: "Missing required environment variables" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseKey);

  try {
    const stats = await runStatsUpdate(supabase, scope);

    return new Response(
      JSON.stringify({
        success: true,
        ...stats,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    console.error("[discord-discussion-stats-update] Error:", error);
    Sentry.captureException(error, scope);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString()
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
});
