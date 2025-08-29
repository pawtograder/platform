import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

interface ClassMetrics {
  class_id: number;
  class_name: string;
  class_slug: string;
  workflow_runs_total: number;
  workflow_runs_completed: number;
  workflow_runs_failed: number;
  workflow_runs_in_progress: number;
  workflow_errors_total: number;
  submissions_total: number;
  submissions_recent_24h: number;
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

    // Get all class metrics using the secure function (single call)
    const { data: metricsData, error: metricsError } = (await supabase.rpc("get_all_class_metrics")) as unknown as {
      data: ClassMetrics[];
      error: Error;
    };

    if (metricsError) {
      console.error("Error fetching class metrics:", metricsError);
      throw new Error("Failed to fetch class metrics");
    }

    if (!metricsData || metricsData.length === 0) {
      return new Response("# No active classes found\n", {
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }
      });
    }

    // Convert the JSON response to our metrics format
    const metrics: ClassMetrics[] = metricsData.map((classData: ClassMetrics) => ({
      class_id: classData.class_id,
      class_name: classData.class_name,
      class_slug: classData.class_slug,
      workflow_runs_total: classData.workflow_runs_total || 0,
      workflow_runs_completed: classData.workflow_runs_completed || 0,
      workflow_runs_failed: classData.workflow_runs_failed || 0,
      workflow_runs_in_progress: classData.workflow_runs_in_progress || 0,
      workflow_errors_total: classData.workflow_errors_total || 0,
      submissions_total: classData.submissions_total || 0,
      submissions_recent_24h: classData.submissions_recent_24h || 0
    }));

    // Generate Prometheus metrics format
    const prometheusOutput = generatePrometheusOutput(metrics);

    return new Response(prometheusOutput, {
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

function generatePrometheusOutput(metrics: ClassMetrics[]): string {
  const timestamp = Math.floor(Date.now()); // Use milliseconds since epoch

  let output = `# HELP pawtograder_info Information about Pawtograder instance
# TYPE pawtograder_info gauge
pawtograder_info{version="1.0.0"} 1 ${timestamp}

# HELP pawtograder_workflow_runs_total Total number of workflow runs per class
# TYPE pawtograder_workflow_runs_total counter
`;

  // Workflow runs total
  for (const metric of metrics) {
    output += `pawtograder_workflow_runs_total{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric.workflow_runs_total} ${timestamp}\n`;
  }

  output += `
# HELP pawtograder_workflow_runs_completed Total number of completed workflow runs per class
# TYPE pawtograder_workflow_runs_completed counter
`;

  // Workflow runs completed
  for (const metric of metrics) {
    output += `pawtograder_workflow_runs_completed{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric.workflow_runs_completed} ${timestamp}\n`;
  }

  output += `
# HELP pawtograder_workflow_runs_failed Total number of failed workflow runs per class
# TYPE pawtograder_workflow_runs_failed counter
`;

  // Workflow runs failed
  for (const metric of metrics) {
    output += `pawtograder_workflow_runs_failed{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric.workflow_runs_failed} ${timestamp}\n`;
  }

  output += `
# HELP pawtograder_workflow_runs_in_progress Current number of workflow runs in progress per class
# TYPE pawtograder_workflow_runs_in_progress gauge
`;

  // Workflow runs in progress
  for (const metric of metrics) {
    output += `pawtograder_workflow_runs_in_progress{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric.workflow_runs_in_progress} ${timestamp}\n`;
  }

  output += `
# HELP pawtograder_workflow_errors_total Total number of workflow errors per class
# TYPE pawtograder_workflow_errors_total counter
`;

  // Workflow errors
  for (const metric of metrics) {
    output += `pawtograder_workflow_errors_total{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric.workflow_errors_total} ${timestamp}\n`;
  }

  output += `
# HELP pawtograder_submissions_total Total number of active submissions per class
# TYPE pawtograder_submissions_total counter
`;

  // Submissions total
  for (const metric of metrics) {
    output += `pawtograder_submissions_total{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric.submissions_total} ${timestamp}\n`;
  }

  output += `
# HELP pawtograder_submissions_recent_24h Number of submissions created in the last 24 hours per class
# TYPE pawtograder_submissions_recent_24h gauge
`;

  // Recent submissions
  for (const metric of metrics) {
    output += `pawtograder_submissions_recent_24h{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric.submissions_recent_24h} ${timestamp}\n`;
  }

  return output;
}

function escapeLabel(value: string): string {
  // Escape special characters in Prometheus labels
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

Deno.serve(async (req) => {
  // Only allow GET requests
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Bearer token authentication if METRICS_TOKEN is set
  const metricsToken = Deno.env.get("METRICS_TOKEN");
  if (metricsToken) {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return new Response("Unauthorized: Missing Authorization header", { status: 401 });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return new Response("Unauthorized: Invalid Authorization header format", { status: 401 });
    }

    const providedToken = authHeader.slice(7); // Remove "Bearer " prefix

    // Use constant-time comparison if available, otherwise direct string compare
    let isValidToken = false;
    try {
      // Try to use crypto.subtle for constant-time comparison
      const encoder = new TextEncoder();
      const expectedBytes = encoder.encode(metricsToken);
      const providedBytes = encoder.encode(providedToken);

      if (expectedBytes.length !== providedBytes.length) {
        isValidToken = false;
      } else {
        const expectedHash = await crypto.subtle.digest("SHA-256", expectedBytes);
        const providedHash = await crypto.subtle.digest("SHA-256", providedBytes);
        isValidToken = new Uint8Array(expectedHash).every((byte, i) => byte === new Uint8Array(providedHash)[i]);
      }
    } catch {
      // Fallback to direct string comparison if crypto.subtle is not available
      isValidToken = providedToken === metricsToken;
    }

    if (!isValidToken) {
      return new Response("Unauthorized: Invalid token", { status: 401 });
    }
  }

  return await generatePrometheusMetrics();
});
