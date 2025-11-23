import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

    const asyncQueueCount = queueSizes?.[0]?.async_queue_size || 0;
    const dlqQueueCount = queueSizes?.[0]?.dlq_queue_size || 0;
    const gradebookRowRecalculateQueueCount = queueSizes?.[0]?.gradebook_row_recalculate_queue_size || 0;

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

# HELP pawtograder_async_queue_size Current number of messages in the async worker queue
# TYPE pawtograder_async_queue_size gauge
pawtograder_async_queue_size ${asyncQueueCount} ${timestamp}

# HELP pawtograder_async_dlq_size Current number of messages in the async worker dead letter queue
# TYPE pawtograder_async_dlq_size gauge
pawtograder_async_dlq_size ${dlqQueueCount} ${timestamp}

# HELP pawtograder_gradebook_row_recalculate_queue_size Current number of messages in the gradebook row recalculate queue
# TYPE pawtograder_gradebook_row_recalculate_queue_size gauge
pawtograder_gradebook_row_recalculate_queue_size ${gradebookRowRecalculateQueueCount} ${timestamp}

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
