import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
// Import for side effect: this function makes Sentry calls but does not import HandlerUtils, so
// without this Sentry.init never ran and every capture was a silent no-op.
import { serveWithSentryFlush } from "../_shared/SentryInit.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import {
  AUTHOR_ID_IN_BATCH_SIZE,
  chunkIds,
  countUnresolvedAuthorMessages,
  fetchAuthorNamesInChunks
} from "./idBatching.ts";

/**
 * Discord Discussion Stats Update
 *
 * This edge function is designed to be called hourly via pg_cron.
 * It updates Discord messages for discussion threads with refreshed stats
 * (reply count, likes count, answered status).
 */

/**
 * Max numeric (bigint) ids per `.in()` filter.
 *
 * To be clear about what was and was not broken: the query that failed in production
 * on 2026-09-07 was the *author* lookup, whose ids are UUIDs (see idBatching.ts). The
 * thread and topic lookups were within budget — a 9-digit id plus its separator costs
 * ~10 bytes, so the 500 ids of a full batch is ~5 KB, and `cli/utils/pagingLimits.ts`
 * documents numeric id lists at 1000 per filter as fine. There was no second live
 * defect here.
 *
 * They are chunked anyway so that neither lookup's URI depends on `batchSize` staying
 * at 500: raising the batch size is an obvious future tuning knob, and at 1000+ ids
 * these filters would start approaching the same limit for the same reason. Bounding
 * them now also means both lookups in this function read the same way, so nobody has
 * to work out which one is safe.
 */
const NUMERIC_ID_IN_BATCH_SIZE = 200;

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

/** Build a compact stats snapshot for change detection */
function buildStatsSnapshot(thread: DiscussionThread): Record<string, unknown> {
  return {
    likes_count: thread.likes_count ?? 0,
    children_count: thread.children_count ?? 0,
    is_question: thread.is_question,
    has_answer: thread.answer !== null
  };
}

/** Returns true if the current stats differ from the last-synced snapshot */
function statsChanged(
  current: Record<string, unknown>,
  lastSynced: Record<string, unknown> | null | undefined
): boolean {
  if (!lastSynced) return true; // never synced before
  return (
    current.likes_count !== lastSynced.likes_count ||
    current.children_count !== lastSynced.children_count ||
    current.is_question !== lastSynced.is_question ||
    current.has_answer !== lastSynced.has_answer
  );
}

async function runStatsUpdate(
  supabase: SupabaseClient<Database>,
  scope: Sentry.Scope
): Promise<{
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
}> {
  console.log("[discord-discussion-stats-update] Starting stats update");

  const stats = { processed: 0, updated: 0, skipped: 0, errors: 0 };

  // Process messages in batches using offset-based pagination
  const batchSize = 500;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    // Fetch batch with offset-based pagination (include last_synced_stats for change detection)
    const { data: discordMessages, error: messagesError } = await supabase
      .from("discord_messages")
      .select("id, discord_message_id, discord_channel_id, resource_id, class_id, last_synced_stats")
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

    // Fetch the threads in id chunks. A missing thread means we cannot build an embed
    // at all, so a failure here still aborts the run as it always has.
    const threads: DiscussionThread[] = [];
    for (const threadIdChunk of chunkIds(threadIds, NUMERIC_ID_IN_BATCH_SIZE)) {
      const { data: threadChunk, error: threadsError } = await supabase
        .from("discussion_threads")
        .select(
          "id, class_id, topic_id, subject, body, is_question, answer, author, likes_count, children_count, created_at"
        )
        .in("id", threadIdChunk);

      if (threadsError) {
        console.error("[discord-discussion-stats-update] Error fetching threads:", threadsError);
        scope.setContext("threads_error", { error: threadsError.message });
        throw threadsError;
      }

      threads.push(...((threadChunk ?? []) as DiscussionThread[]));
    }

    if (threads.length === 0) {
      console.log("[discord-discussion-stats-update] No matching threads found in this batch");
      offset += batchSize;
      hasMore = discordMessages.length === batchSize;
      continue;
    }

    // Create thread map for quick lookup
    const threadMap = new Map<number, DiscussionThread>();
    for (const thread of threads) {
      threadMap.set(thread.id, thread);
    }

    // Get all unique topic IDs
    const topicIds = [...new Set(threads.map((t) => t.topic_id))];

    // Fetch the topics in id chunks. Without the topic we have no Discord channel to
    // update, so a failure here aborts the run as it always has.
    const topicMap = new Map<number, DiscussionTopic>();
    for (const topicIdChunk of chunkIds(topicIds, NUMERIC_ID_IN_BATCH_SIZE)) {
      const { data: topics, error: topicsError } = await supabase
        .from("discussion_topics")
        .select("id, topic, discord_channel_id")
        .in("id", topicIdChunk);

      if (topicsError) {
        console.error("[discord-discussion-stats-update] Error fetching topics:", topicsError);
        scope.setContext("topics_error", { error: topicsError.message });
        throw topicsError;
      }

      for (const topic of topics ?? []) {
        topicMap.set(topic.id, topic);
      }
    }

    // Get all unique author IDs
    const authorIds = [...new Set(threads.map((t) => t.author))];

    // Fetch author profiles in UUID-sized chunks. This is the query that logged
    // "URI too long" in production on 2026-09-07: all ~280 author UUIDs went into one
    // `.in()` filter, which is ~10 KB of query string. A failed chunk is counted, not
    // thrown: the author name is decoration on the embed, and aborting an hourly cron
    // run over it would discard the queued updates for every other batch.
    const authorLookup = await fetchAuthorNamesInChunks(authorIds, AUTHOR_ID_IN_BATCH_SIZE, (chunk) =>
      supabase.from("profiles").select("id, name").in("id", chunk)
    );

    if (authorLookup.failedChunks > 0) {
      console.error(
        `[discord-discussion-stats-update] Error fetching authors: ${authorLookup.failedChunks} of ${Math.ceil(authorIds.length / AUTHOR_ID_IN_BATCH_SIZE)} chunk(s) failed, ${authorLookup.failedAuthorIds.size} author(s) unresolved:`,
        authorLookup.errors
      );
      scope.setContext("authors_error", {
        failed_chunks: authorLookup.failedChunks,
        unresolved_author_count: authorLookup.failedAuthorIds.size,
        errors: authorLookup.errors
      });
      Sentry.captureException(
        new Error(`Author lookup failed for ${authorLookup.failedAuthorIds.size} author(s)`),
        scope
      );
    }

    // Every message whose author we could not resolve is an error, and it is counted
    // here rather than after the fact. Before this, the failure above only produced a
    // console line: the completion summary reported "0 errors" on a run that had just
    // failed to fetch any authors, so nothing watching that line could see it.
    stats.errors += countUnresolvedAuthorMessages(
      discordMessages.map((m) => threadMap.get(m.resource_id)?.author),
      authorLookup.failedAuthorIds
    );

    const authorMap = authorLookup.names;

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

      // If the author's chunk failed we do not know their name. Falling back to
      // "Anonymous" here would put a wrong author into the Discord embed *and* persist
      // the stats snapshot below, so the wrong name would stick until the thread's
      // stats changed again. Leaving it for the next hourly run is the safer failure.
      // Already counted in stats.errors above.
      if (authorLookup.failedAuthorIds.has(thread.author)) {
        console.warn(
          `[discord-discussion-stats-update] Author ${thread.author} unresolved (lookup chunk failed), leaving thread ${thread.id} for the next run`
        );
        continue;
      }

      // Check if stats actually changed since last sync
      const currentStats = buildStatsSnapshot(thread);
      const lastSynced = msg.last_synced_stats as Record<string, unknown> | null;

      if (!statsChanged(currentStats, lastSynced)) {
        stats.skipped++;
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
          // Persist the stats snapshot so we skip this thread next time if nothing changed
          const { error: updateError } = await supabase
            .from("discord_messages")
            .update({ last_synced_stats: currentStats as unknown as Json })
            .eq("id", msg.id);

          if (updateError) {
            console.warn(
              `[discord-discussion-stats-update] Failed to update last_synced_stats for message ${msg.id}:`,
              updateError
            );
            // Non-fatal: the update was enqueued, we'll just re-send next hour
          }

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
    `[discord-discussion-stats-update] Completed: ${stats.processed} processed, ${stats.updated} updated, ${stats.skipped} skipped (unchanged), ${stats.errors} errors`
  );
  return stats;
}

// HTTP handler
serveWithSentryFlush(async (req) => {
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
