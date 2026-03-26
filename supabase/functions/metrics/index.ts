import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { BottleneckLimiterSnapshot, collectBottleneckRedisSnapshots } from "../_shared/BottleneckRedisMetrics.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

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

    let bottleneckSnapshots: BottleneckLimiterSnapshot[] = [];
    try {
      bottleneckSnapshots = await collectBottleneckRedisSnapshots();
    } catch (redisMetricsError) {
      console.error("Error collecting Bottleneck/Upstash metrics:", redisMetricsError);
      Sentry.captureException(redisMetricsError);
    }

    const { data: vacuumHealth, error: vacuumError } = await supabase.rpc("vacuum_health_check");
    const { data: ramMetrics, error: ramError } = await supabase.rpc("database_ram_metrics");

    if (vacuumError) {
      console.error("Error fetching vacuum health:", vacuumError);
      Sentry.captureException(vacuumError);
    }

    if (ramError) {
      console.error("Error fetching RAM metrics:", ramError);
      Sentry.captureException(ramError);
    }

    const asyncQueueCount = queueSizes?.[0]?.async_queue_size || 0;
    const dlqQueueCount = queueSizes?.[0]?.dlq_queue_size || 0;
    const gradebookRowRecalculateQueueCount = queueSizes?.[0]?.gradebook_row_recalculate_queue_size || 0;
    const discordQueueCount = queueSizes?.[0]?.discord_queue_size || 0;
    const discordDlqQueueCount = queueSizes?.[0]?.discord_dlq_queue_size || 0;

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

# HELP pawtograder_async_dlq_size Current number of messages in the github async worker dead letter queue
# TYPE pawtograder_async_dlq_size gauge
pawtograder_async_dlq_size ${dlqQueueCount} ${timestamp}

# HELP pawtograder_gradebook_row_recalculate_queue_size Current number of messages in the gradebook row recalculate queue
# TYPE pawtograder_gradebook_row_recalculate_queue_size gauge
pawtograder_gradebook_row_recalculate_queue_size ${gradebookRowRecalculateQueueCount} ${timestamp}

# HELP pawtograder_discord_queue_size Current number of messages in the discord async worker queue
# TYPE pawtograder_discord_queue_size gauge
pawtograder_discord_queue_size ${discordQueueCount} ${timestamp}

# HELP pawtograder_discord_dlq_size Current number of messages in the discord async worker dead letter queue
# TYPE pawtograder_discord_dlq_size gauge
pawtograder_discord_dlq_size ${discordDlqQueueCount} ${timestamp}

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

    // Vacuum health metrics
    output += `
# HELP pawtograder_vacuum_alert Vacuum health alert (1 = active alert). Labels: check, severity, table_name
# TYPE pawtograder_vacuum_alert gauge
`;
    if (vacuumError) {
      const errMsg = vacuumError.message ?? String(vacuumError);
      const errLabel = escapeLabel(errMsg.length > 800 ? `${errMsg.slice(0, 800)}...` : errMsg);
      const labels = `check="${escapeLabel("rpc_failed")}",severity="${escapeLabel("error")}",table_name="${escapeLabel("none")}",error="${errLabel}"`;
      output += `pawtograder_vacuum_alert{${labels}} 1 ${timestamp}\n`;
    } else if (vacuumHealth && vacuumHealth.length > 0) {
      for (const row of vacuumHealth) {
        const labels = `check="${escapeLabel(row.check_name)}",severity="${escapeLabel(row.severity)}",table_name="${escapeLabel(row.relname)}"`;
        output += `pawtograder_vacuum_alert{${labels}} 1 ${timestamp}\n`;
      }
    } else {
      output += `pawtograder_vacuum_alert{check="none",severity="ok",table_name="none"} 0 ${timestamp}\n`;
    }

    // Database RAM metrics
    if (ramMetrics && ramMetrics.length > 0) {
      const metricDefs: Record<string, string> = {
        buffer_cache_bytes: "Bytes of shared buffer cache used by a table/index",
        buffer_cache_total_used_bytes: "Total bytes of shared buffer cache in use",
        connections: "Number of database connections by state",
        table_total_bytes: "Total size of a table including indexes and TOAST",
        dead_tuples: "Number of dead tuples in a table"
      };

      // Group by metric name and emit HELP/TYPE once per metric
      const grouped = new Map<string, typeof ramMetrics>();
      for (const row of ramMetrics) {
        const existing = grouped.get(row.metric_name) || [];
        existing.push(row);
        grouped.set(row.metric_name, existing);
      }

      for (const [metricName, rows] of grouped) {
        const promName = `pawtograder_db_${metricName}`;
        const help = metricDefs[metricName] || metricName;
        output += `\n# HELP ${promName} ${help}\n# TYPE ${promName} gauge\n`;
        for (const row of rows) {
          const ml =
            row.metric_labels && typeof row.metric_labels === "object" ? row.metric_labels : {};
          const labels = Object.entries(ml as Record<string, string>)
            .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
            .join(",");
          const labelStr = labels ? `{${labels}}` : "";
          output += `${promName}${labelStr} ${row.metric_value} ${timestamp}\n`;
        }
      }
    }

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

Deno.serve(async (req) => {
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
