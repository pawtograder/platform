import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

interface WorkflowRun {
  requested_at: string | null;
  in_progress_at: string | null;
  completed_at: string | null;
}

interface Submission {
  created_at: string;
}

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

async function generatePrometheusMetrics(_req: Request): Promise<Response> {
  const scope = Sentry.getCurrentScope();
  scope?.setTag("function", "metrics");

  try {
    // Create admin client for accessing all data
    const supabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );

    // Get all active classes
    const { data: classes, error: classesError } = await supabase
      .from("classes")
      .select("id, name, slug")
      .eq("is_active", true);

    if (classesError) {
      console.error("Error fetching classes:", classesError);
      throw new Error("Failed to fetch classes");
    }

    if (!classes || classes.length === 0) {
      return new Response("# No active classes found\n", {
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }
      });
    }

    const metrics: ClassMetrics[] = [];

    // Process each class
    for (const classInfo of classes) {
      const classId = classInfo.id;

      // Get workflow statistics using the secure function (24 hour window)
      const { data: workflowStats, error: workflowError } = await supabase.rpc("get_workflow_statistics", {
        p_class_id: classId,
        p_duration_hours: 24
      });

      if (workflowError) {
        console.error(`Error fetching workflow statistics for class ${classId}:`, workflowError);
        continue;
      }

      // Extract metrics from function result
      const stats = workflowStats?.[0];
      if (!stats) {
        console.warn(`No workflow statistics found for class ${classId}`);
        continue;
      }

      const workflowRunsTotal = Number(stats.total_runs) || 0;
      const workflowRunsCompleted = Number(stats.completed_runs) || 0;
      const workflowRunsInProgress = Number(stats.in_progress_runs) || 0;
      const workflowRunsFailed = Number(stats.failed_runs) || 0;
      const workflowErrorsTotal = Number(stats.error_count) || 0;

      // Get submission metrics
      const { data: submissions, error: submissionsError } = await supabase
        .from("submissions")
        .select("created_at")
        .eq("class_id", classId)
        .eq("is_active", true);

      if (submissionsError) {
        console.error(`Error fetching submissions for class ${classId}:`, submissionsError);
        continue;
      }

      const submissionsTotal = submissions?.length || 0;

      // Calculate recent submissions (last 24 hours)
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const submissionsRecent24h =
        submissions?.filter((sub: Submission) => new Date(sub.created_at) >= twentyFourHoursAgo).length || 0;

      metrics.push({
        class_id: classId,
        class_name: classInfo.name,
        class_slug: classInfo.slug,
        workflow_runs_total: workflowRunsTotal,
        workflow_runs_completed: workflowRunsCompleted,
        workflow_runs_failed: workflowRunsFailed,
        workflow_runs_in_progress: workflowRunsInProgress,
        workflow_errors_total: workflowErrorsTotal,
        submissions_total: submissionsTotal,
        submissions_recent_24h: submissionsRecent24h
      });
    }

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
  const timestamp = Math.floor(Date.now() / 1000);

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

  // Optional: Add basic authentication or API key validation here
  // const authHeader = req.headers.get("Authorization");
  // if (!authHeader || !isValidAuth(authHeader)) {
  //   return new Response("Unauthorized", { status: 401 });
  // }

  return await generatePrometheusMetrics(req);
});
