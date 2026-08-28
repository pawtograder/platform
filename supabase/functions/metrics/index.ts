import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { BottleneckLimiterSnapshot, collectBottleneckRedisSnapshots } from "../_shared/BottleneckRedisMetrics.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
// Import for side effect: this function makes Sentry calls but does not import HandlerUtils, so
// without this Sentry.init never ran and every capture was a silent no-op.
import { serveWithSentryFlush } from "../_shared/SentryInit.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";

/**
 * SCOPE: this handler serves only metrics that are cheap AND either per-pod or
 * freshness-sensitive. Global database state does NOT belong here.
 *
 * Prometheus scrapes every pod endpoint behind the functions Service, and prod pins the functions
 * HPA at 32 replicas, so a 30s ServiceMonitor interval means ~1.07 scrapes/sec of this handler.
 * Anything global gets queried 32× and emitted as 32 identical copies of the same series. Over a
 * 42-day pg_stat_statements window that made this function 77.7% of ALL production database
 * execution time:
 *
 *   database_ram_metrics()  3,036,749 calls  360.6 ms mean  77.7% of DB exec time
 *   vacuum_health_check()   3,036,995 calls   32.8 ms mean   7.1%
 *
 * database_ram_metrics() was that expensive because it scans pg_buffercache — 524,288 buffer
 * descriptors at shared_buffers = 4GB, per call, per pod.
 *
 * Both now live in the postgres_exporter's queries.yaml
 * (charts/pawtograder/templates/monitoring.yaml), which is scraped once, from one pod. The vacuum,
 * buffer-cache and dead-tuple metrics kept their exact names and labels. Connections and table
 * sizes did NOT: pawtograder_db_connections{state} is gone, and table sizes are now
 * pawtograder_table_sizes_total_bytes{relation} with a schema-qualified value. See
 * supabase/migrations/20260827120000_drop_database_ram_metrics.sql for the full mapping.
 *
 * What stays here, and why: the queue sizes and circuit breaker states below are ~0.3% of DB exec
 * time combined and drive paging alerts where scrape-interval freshness matters, and the
 * Bottleneck/Upstash snapshots read Redis rather than Postgres. Moving them is a possible follow-up,
 * not a cost problem.
 */

/** Best-effort cap for untyped RPCs so a slow DB cannot stall the scrape. */
const RPC_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Shape returned by `get_discord_circuit_breaker_statuses` (not yet on generated `Database` types).
 *
 * Exported as its own metric rather than folded into pawtograder_circuit_breaker_open: that gauge is
 * the GitHub breaker's, the existing alert rules match on its label set, and the two breakers have
 * completely different remediations — a GitHub App installation versus a Discord server admin.
 */
type DiscordCircuitRow = { scope: string; key: string; is_open: boolean; state: string; trip_count: number };

type RpcRowResult<T> = { data: T | null; error: { message: string } | null };

/** Call RPCs not yet present on generated `Database` / unwrap thenable builders for `withTimeout`. */
function rpcUntyped<T>(client: ReturnType<typeof createClient<Database>>, fnName: string): Promise<RpcRowResult<T>> {
  const sb = client as unknown as { rpc: (name: string) => Promise<RpcRowResult<T>> };
  return sb.rpc(fnName);
}

async function generatePrometheusMetrics(): Promise<Response> {
  const scope = Sentry.getCurrentScope();
  scope?.setTag("function", "metrics");

  try {
    // Create admin client for accessing all data
    const supabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );

    // Query queue sizes and circuit breaker statuses using RPC functions
    const { data: queueSizes, error: queueError } = await supabase.rpc("get_async_queue_sizes");
    const { data: circuitBreakers, error: circuitBreakerError } = await supabase.rpc("get_circuit_breaker_statuses");

    if (queueError) {
      console.error("Error fetching queue sizes:", queueError);
      throw queueError;
    }

    if (circuitBreakerError) {
      console.error("Error fetching circuit breaker statuses:", circuitBreakerError);
      throw circuitBreakerError;
    }

    // The Discord breaker is read separately and non-fatally. A scrape must keep reporting queue
    // depth and the GitHub breakers even if this RPC is missing — which it is on any deployment that
    // has not yet applied the Discord breaker migration.
    let discordCircuitBreakers: DiscordCircuitRow[] | null = null;
    try {
      // Bounded: this handler answers a Prometheus scrape, so an RPC that hangs does not just lose
      // one gauge -- it stalls the whole response until the scrape times out and every metric in it
      // is lost.
      const d = await withTimeout(
        rpcUntyped<DiscordCircuitRow[]>(supabase, "get_discord_circuit_breaker_statuses"),
        RPC_TIMEOUT_MS,
        "get_discord_circuit_breaker_statuses"
      );
      if (d.error) {
        console.error("Error fetching Discord circuit breaker statuses:", d.error);
      } else {
        discordCircuitBreakers = d.data;
      }
    } catch (e) {
      console.error("Error fetching Discord circuit breaker statuses:", e);
    }

    let bottleneckSnapshots: BottleneckLimiterSnapshot[] = [];
    try {
      bottleneckSnapshots = await collectBottleneckRedisSnapshots();
    } catch (redisMetricsError) {
      console.error("Error collecting Bottleneck/Upstash metrics:", redisMetricsError);
      Sentry.captureException(redisMetricsError);
    }

    const asyncQueueCount = queueSizes?.[0]?.async_queue_size || 0;
    const asyncLowPriorityQueueCount = queueSizes?.[0]?.async_low_priority_queue_size || 0;
    const dlqQueueCount = queueSizes?.[0]?.dlq_queue_size || 0;
    const gradebookRowRecalculateQueueCount = queueSizes?.[0]?.gradebook_row_recalculate_queue_size || 0;
    const gradebookRowRecalculateDlqCount = queueSizes?.[0]?.gradebook_row_recalculate_dlq_queue_size || 0;
    const discordQueueCount = queueSizes?.[0]?.discord_queue_size || 0;
    const discordDlqQueueCount = queueSizes?.[0]?.discord_dlq_queue_size || 0;
    const notificationEmailsQueueCount = queueSizes?.[0]?.notification_emails_queue_size || 0;

    // Oldest-message age per queue. Depth alone cannot tell a healthy busy queue from a stalled
    // one, and depth thresholds need retuning every term; age is scale-free.
    const queueOldestSeconds: { queue: string; seconds: number }[] = [
      { queue: "async_calls", seconds: queueSizes?.[0]?.async_oldest_seconds || 0 },
      { queue: "async_calls_dlq", seconds: queueSizes?.[0]?.dlq_oldest_seconds || 0 },
      {
        queue: "gradebook_row_recalculate",
        seconds: queueSizes?.[0]?.gradebook_row_recalculate_oldest_seconds || 0
      },
      {
        queue: "gradebook_row_recalculate_dlq",
        seconds: queueSizes?.[0]?.gradebook_row_recalculate_dlq_oldest_seconds || 0
      },
      { queue: "discord_async_calls", seconds: queueSizes?.[0]?.discord_oldest_seconds || 0 },
      { queue: "discord_async_calls_dlq", seconds: queueSizes?.[0]?.discord_dlq_oldest_seconds || 0 },
      { queue: "async_calls_low_priority", seconds: queueSizes?.[0]?.async_low_priority_oldest_seconds || 0 },
      { queue: "notification_emails", seconds: queueSizes?.[0]?.notification_emails_oldest_seconds || 0 }
    ];

    // Generate Prometheus metrics format
    const timestamp = Date.now(); // Unix timestamp in milliseconds

    function escapeLabel(value: string): string {
      // Escape special characters in Prometheus labels
      return value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
    }

    let output = `# HELP pawtograder_info Information about Pawtograder instance
# TYPE pawtograder_info gauge
pawtograder_info{version="1.0.0"} 1 ${timestamp}

# HELP pawtograder_async_queue_size Current number of messages in the github async worker queue
# TYPE pawtograder_async_queue_size gauge
pawtograder_async_queue_size ${asyncQueueCount} ${timestamp}

# HELP pawtograder_async_low_priority_queue_size Current number of messages in the github async worker low-priority queue (bulk repo analytics)
# TYPE pawtograder_async_low_priority_queue_size gauge
pawtograder_async_low_priority_queue_size ${asyncLowPriorityQueueCount} ${timestamp}

# HELP pawtograder_async_dlq_size Current number of messages in the github async worker dead letter queue
# TYPE pawtograder_async_dlq_size gauge
pawtograder_async_dlq_size ${dlqQueueCount} ${timestamp}

# HELP pawtograder_gradebook_row_recalculate_queue_size Current number of messages in the gradebook row recalculate queue
# TYPE pawtograder_gradebook_row_recalculate_queue_size gauge
pawtograder_gradebook_row_recalculate_queue_size ${gradebookRowRecalculateQueueCount} ${timestamp}

# HELP pawtograder_gradebook_row_recalculate_dlq_size Current number of messages in the gradebook row recalculate dead letter queue
# TYPE pawtograder_gradebook_row_recalculate_dlq_size gauge
pawtograder_gradebook_row_recalculate_dlq_size ${gradebookRowRecalculateDlqCount} ${timestamp}

# HELP pawtograder_discord_queue_size Current number of messages in the discord async worker queue
# TYPE pawtograder_discord_queue_size gauge
pawtograder_discord_queue_size ${discordQueueCount} ${timestamp}

# HELP pawtograder_discord_dlq_size Current number of messages in the discord async worker dead letter queue
# TYPE pawtograder_discord_dlq_size gauge
pawtograder_discord_dlq_size ${discordDlqQueueCount} ${timestamp}

# HELP pawtograder_notification_emails_queue_size Current number of messages in the notification email queue
# TYPE pawtograder_notification_emails_queue_size gauge
pawtograder_notification_emails_queue_size ${notificationEmailsQueueCount} ${timestamp}

# HELP pawtograder_queue_oldest_message_seconds Age of the oldest message in each queue, including messages deferred by retry backoff
# TYPE pawtograder_queue_oldest_message_seconds gauge
${queueOldestSeconds
  .map((q) => `pawtograder_queue_oldest_message_seconds{queue="${escapeLabel(q.queue)}"} ${q.seconds} ${timestamp}`)
  .join("\n")}

# HELP pawtograder_circuit_breaker_open Whether a circuit breaker is currently open (1 = open, 0 = closed)
# TYPE pawtograder_circuit_breaker_open gauge
`;

    // Add circuit breaker metrics
    if (circuitBreakers && circuitBreakers.length > 0) {
      for (const cb of circuitBreakers) {
        const isOpen = cb.is_open ? 1 : 0;
        const labels = `scope="${escapeLabel(cb.scope)}",key="${escapeLabel(cb.key)}",state="${escapeLabel(cb.state)}"`;
        output += `pawtograder_circuit_breaker_open{${labels}} ${isOpen} ${timestamp}\n`;
      }
    }

    // Discord breaker, as its own gauge. An open one means a guild's work is being deferred, and
    // because one bot token serves every course, it is also the signal that one misconfigured server
    // was about to consume the platform's whole Discord rate limit.
    output += `
# HELP pawtograder_discord_circuit_breaker_open Whether a Discord per-guild circuit breaker is currently open (1 = open, 0 = closed)
# TYPE pawtograder_discord_circuit_breaker_open gauge
`;
    if (discordCircuitBreakers && discordCircuitBreakers.length > 0) {
      for (const cb of discordCircuitBreakers) {
        const isOpen = cb.is_open ? 1 : 0;
        const labels = `scope="${escapeLabel(cb.scope)}",key="${escapeLabel(cb.key)}",state="${escapeLabel(cb.state)}"`;
        output += `pawtograder_discord_circuit_breaker_open{${labels}} ${isOpen} ${timestamp}\n`;
      }
    }

    if (bottleneckSnapshots.length > 0) {
      output += `
# HELP pawtograder_bottleneck_running Total running job weight for a Bottleneck limiter (Upstash Redis)
# TYPE pawtograder_bottleneck_running gauge
# HELP pawtograder_bottleneck_concurrent_clients Number of Bottleneck clients with active running work (Redis ZSET score greater than zero)
# TYPE pawtograder_bottleneck_concurrent_clients gauge
# HELP pawtograder_bottleneck_queued Total queued jobs for a Bottleneck limiter (valid clients; matches Bottleneck queued.lua)
# TYPE pawtograder_bottleneck_queued gauge
`;

      for (const snap of bottleneckSnapshots) {
        const lid = escapeLabel(snap.limiter_id);
        const labels = `limiter_id="${lid}"`;
        output += `pawtograder_bottleneck_running{${labels}} ${snap.running} ${timestamp}\n`;
        output += `pawtograder_bottleneck_concurrent_clients{${labels}} ${snap.concurrent_clients} ${timestamp}\n`;
        output += `pawtograder_bottleneck_queued{${labels}} ${snap.queued} ${timestamp}\n`;
      }
    }

    // Global database state (pawtograder_vacuum_alert, pawtograder_db_buffer_cache*,
    // pawtograder_db_dead_tuples, pawtograder_db_connections, pawtograder_db_table_total_bytes) is
    // deliberately NOT emitted here — see the scope note at the top of this file. It comes from the
    // postgres_exporter's queries.yaml in charts/pawtograder/templates/monitoring.yaml, scraped once
    // instead of once per functions pod. Connections and table sizes were already exported there as
    // pawtograder_db_connections_{used,max,reserved} and pawtograder_table_sizes_{total,heap}_bytes.

    output += "\n";

    return new Response(output, {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      }
    });
  } catch (error) {
    console.error("Error generating metrics:", error);
    Sentry.captureException(error);

    return new Response("# Error generating metrics\n", {
      status: 500,
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }
    });
  }
}

// Authentication helper function
async function authenticateRequest(req: Request): Promise<boolean> {
  const metricsToken = Deno.env.get("METRICS_TOKEN");
  if (!metricsToken) return true; // No auth required

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const providedToken = authHeader.slice(7);

  // Use constant-time comparison if available
  try {
    const encoder = new TextEncoder();
    const expectedBytes = encoder.encode(metricsToken);
    const providedBytes = encoder.encode(providedToken);

    if (expectedBytes.length !== providedBytes.length) return false;

    const expectedHash = await crypto.subtle.digest("SHA-256", expectedBytes);
    const providedHash = await crypto.subtle.digest("SHA-256", providedBytes);
    return new Uint8Array(expectedHash).every((byte, i) => byte === new Uint8Array(providedHash)[i]);
  } catch {
    return providedToken === metricsToken;
  }
}

serveWithSentryFlush(async (req) => {
  // Only allow GET requests
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Check authentication
  if (!(await authenticateRequest(req))) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Single endpoint with all metrics
  return await generatePrometheusMetrics();
});
