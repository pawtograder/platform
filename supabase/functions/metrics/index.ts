import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

interface ClassMetrics {
  class_id: number;
  class_name: string;
  class_slug: string;

  // Workflow metrics
  workflow_runs_total: number;
  workflow_runs_completed: number;
  workflow_runs_failed: number;
  workflow_runs_in_progress: number;
  workflow_errors_total: number;
  workflow_runs_timeout: number;

  // Workflow performance metrics
  workflow_avg_queue_time_seconds: number;
  workflow_avg_run_time_seconds: number;

  // User engagement metrics
  active_students_total: number;
  active_instructors_total: number;
  active_graders_total: number;
  students_active_7d: number;
  students_active_24h: number;

  // Assignment metrics
  assignments_total: number;
  assignments_active: number;

  // Submission metrics
  submissions_total: number;
  submissions_recent_24h: number;
  submissions_graded: number;
  submissions_pending_grading: number;

  // Grading metrics
  submission_reviews_total: number;
  submission_reviews_recent_7d: number;
  avg_grading_turnaround_hours: number;

  // Comment metrics
  submission_comments_total: number;

  // Regrade request metrics
  regrade_requests_total: number;
  regrade_requests_recent_7d: number;

  // Discussion metrics
  discussion_threads_total: number;
  discussion_posts_recent_7d: number;

  // Help request metrics
  help_requests_total: number;
  help_requests_open: number;
  help_requests_resolved_24h: number;
  help_requests_avg_resolution_minutes: number;
  help_request_messages_total: number;

  // Notification metrics
  notifications_unread: number;

  // System complexity metrics
  gradebook_columns_total: number;

  // Late token usage metrics
  late_token_usage_total: number;
  late_tokens_per_student_limit: number;

  // Video meeting metrics
  video_meeting_sessions_total: number;
  video_meeting_sessions_recent_7d: number;
  video_meeting_participants_total: number;
  video_meeting_participants_recent_7d: number;
  video_meeting_avg_duration_minutes: number;
  video_meeting_unique_users_7d: number;

  // SIS sync error metrics
  sis_sync_errors_recent: number;

  // LLM inference usage metrics
  llm_inference_total: number;
  llm_inference_recent_7d: number;
  llm_input_tokens_total: number;
  llm_output_tokens_total: number;
  llm_input_tokens_recent_7d: number;
  llm_output_tokens_recent_7d: number;
  llm_unique_accounts: number;
  llm_unique_models: number;
  llm_unique_providers: number;

  // Hint feedback metrics
  hint_feedback_total: number;
  hint_feedback_useful_total: number;
  hint_feedback_useful_percentage: number;
  hint_feedback_recent_7d: number;
  hint_feedback_with_comments: number;
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

    // Get all class metrics, assignment metrics, and tags breakdown in parallel
    const [
      classMetricsResult,
      assignmentMetricsResult,
      tagsMetricsResult,
      breakerEventsResult,
      apiRecentMetricsResult
    ] = await Promise.all([
      supabase.rpc("get_all_class_metrics"),
      supabase.rpc("get_assignment_llm_metrics"),
      supabase.rpc("get_llm_tags_breakdown"),
      // Circuit breaker events last 24h grouped by scope/key
      supabase
        .from("github_circuit_breaker_events")
        .select("scope,key,reason,opened_at")
        .gte("opened_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      // Recent API metrics last hour
      supabase.rpc("get_github_api_metrics_recent", { p_window_seconds: 3600 })
    ]);

    const { data: metricsData, error: metricsError } = classMetricsResult as unknown as {
      data: ClassMetrics[];
      error: Error;
    };

    const { data: assignmentData } = assignmentMetricsResult as unknown as {
      data: unknown[];
      error: Error;
    };

    const { data: tagsData } = tagsMetricsResult as unknown as {
      data: unknown[];
      error: Error;
    };
    const { data: breakerEvents } = breakerEventsResult as unknown as {
      data: Array<{ scope: string; key: string; reason?: string; opened_at: string }>;
      error: Error;
    };
    const { data: apiRecent } = apiRecentMetricsResult as unknown as {
      data: Array<{ class_id: number; method: string; status_code: number; calls: number; avg_latency_ms: number }>;
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

      // Workflow metrics
      workflow_runs_total: classData.workflow_runs_total || 0,
      workflow_runs_completed: classData.workflow_runs_completed || 0,
      workflow_runs_failed: classData.workflow_runs_failed || 0,
      workflow_runs_in_progress: classData.workflow_runs_in_progress || 0,
      workflow_errors_total: classData.workflow_errors_total || 0,
      workflow_runs_timeout: classData.workflow_runs_timeout || 0,

      // Workflow performance metrics
      workflow_avg_queue_time_seconds: classData.workflow_avg_queue_time_seconds || 0,
      workflow_avg_run_time_seconds: classData.workflow_avg_run_time_seconds || 0,

      // User engagement metrics
      active_students_total: classData.active_students_total || 0,
      active_instructors_total: classData.active_instructors_total || 0,
      active_graders_total: classData.active_graders_total || 0,
      students_active_7d: classData.students_active_7d || 0,
      students_active_24h: classData.students_active_24h || 0,

      // Assignment metrics
      assignments_total: classData.assignments_total || 0,
      assignments_active: classData.assignments_active || 0,

      // Submission metrics
      submissions_total: classData.submissions_total || 0,
      submissions_recent_24h: classData.submissions_recent_24h || 0,
      submissions_graded: classData.submissions_graded || 0,
      submissions_pending_grading: classData.submissions_pending_grading || 0,

      // Grading metrics
      submission_reviews_total: classData.submission_reviews_total || 0,
      submission_reviews_recent_7d: classData.submission_reviews_recent_7d || 0,
      avg_grading_turnaround_hours: classData.avg_grading_turnaround_hours || 0,

      // Comment metrics
      submission_comments_total: classData.submission_comments_total || 0,

      // Regrade request metrics
      regrade_requests_total: classData.regrade_requests_total || 0,
      regrade_requests_recent_7d: classData.regrade_requests_recent_7d || 0,

      // Discussion metrics
      discussion_threads_total: classData.discussion_threads_total || 0,
      discussion_posts_recent_7d: classData.discussion_posts_recent_7d || 0,

      // Help request metrics
      help_requests_total: classData.help_requests_total || 0,
      help_requests_open: classData.help_requests_open || 0,
      help_requests_resolved_24h: classData.help_requests_resolved_24h || 0,
      help_requests_avg_resolution_minutes: classData.help_requests_avg_resolution_minutes || 0,
      help_request_messages_total: classData.help_request_messages_total || 0,

      // Notification metrics
      notifications_unread: classData.notifications_unread || 0,

      // System complexity metrics
      gradebook_columns_total: classData.gradebook_columns_total || 0,

      // Late token usage metrics
      late_token_usage_total: classData.late_token_usage_total || 0,
      late_tokens_per_student_limit: classData.late_tokens_per_student_limit || 0,

      // Video meeting metrics
      video_meeting_sessions_total: classData.video_meeting_sessions_total || 0,
      video_meeting_sessions_recent_7d: classData.video_meeting_sessions_recent_7d || 0,
      video_meeting_participants_total: classData.video_meeting_participants_total || 0,
      video_meeting_participants_recent_7d: classData.video_meeting_participants_recent_7d || 0,
      video_meeting_avg_duration_minutes: classData.video_meeting_avg_duration_minutes || 0,
      video_meeting_unique_users_7d: classData.video_meeting_unique_users_7d || 0,

      // SIS sync error metrics
      sis_sync_errors_recent: classData.sis_sync_errors_recent || 0,

      // LLM inference usage metrics
      llm_inference_total: classData.llm_inference_total || 0,
      llm_inference_recent_7d: classData.llm_inference_recent_7d || 0,
      llm_input_tokens_total: classData.llm_input_tokens_total || 0,
      llm_output_tokens_total: classData.llm_output_tokens_total || 0,
      llm_input_tokens_recent_7d: classData.llm_input_tokens_recent_7d || 0,
      llm_output_tokens_recent_7d: classData.llm_output_tokens_recent_7d || 0,
      llm_unique_accounts: classData.llm_unique_accounts || 0,
      llm_unique_models: classData.llm_unique_models || 0,
      llm_unique_providers: classData.llm_unique_providers || 0,

      // Hint feedback metrics
      hint_feedback_total: classData.hint_feedback_total || 0,
      hint_feedback_useful_total: classData.hint_feedback_useful_total || 0,
      hint_feedback_useful_percentage: classData.hint_feedback_useful_percentage || 0,
      hint_feedback_recent_7d: classData.hint_feedback_recent_7d || 0,
      hint_feedback_with_comments: classData.hint_feedback_with_comments || 0
    }));

    // Generate comprehensive Prometheus metrics format
    const prometheusOutput = generatePrometheusOutput(
      metrics,
      assignmentData,
      tagsData,
      breakerEvents || [],
      apiRecent || []
    );

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

function generatePrometheusOutput(
  metrics: ClassMetrics[],
  assignmentData?: unknown[],
  tagsData?: unknown[],
  breakerEvents?: Array<{ scope: string; key: string; reason?: string; opened_at: string }>,
  apiRecent?: Array<{ class_id: number; method: string; status_code: number; calls: number; avg_latency_ms: number }>
): string {
  const timestamp = Math.floor(Date.now()); // Use milliseconds since epoch

  let output = `# HELP pawtograder_info Information about Pawtograder instance
# TYPE pawtograder_info gauge
pawtograder_info{version="1.0.0"} 1 ${timestamp}

`;

  // Helper function to generate metrics for a specific field
  const generateMetric = (name: string, help: string, type: string, field: keyof ClassMetrics) => {
    output += `# HELP ${name} ${help}
# TYPE ${name} ${type}
`;
    for (const metric of metrics) {
      output += `${name}{class_id="${metric.class_id}",class_name="${escapeLabel(metric.class_name)}",class_slug="${escapeLabel(metric.class_slug)}"} ${metric[field]} ${timestamp}\n`;
    }
    output += "\n";
  };

  // === WORKFLOW METRICS ===
  generateMetric(
    "pawtograder_workflow_runs_total",
    "Total number of workflow runs per class",
    "counter",
    "workflow_runs_total"
  );
  generateMetric(
    "pawtograder_workflow_runs_completed",
    "Total number of completed workflow runs per class",
    "counter",
    "workflow_runs_completed"
  );
  generateMetric(
    "pawtograder_workflow_runs_failed",
    "Total number of failed workflow runs per class",
    "counter",
    "workflow_runs_failed"
  );
  generateMetric(
    "pawtograder_workflow_runs_in_progress",
    "Current number of workflow runs in progress per class",
    "gauge",
    "workflow_runs_in_progress"
  );
  generateMetric(
    "pawtograder_workflow_errors_total",
    "Total number of workflow errors per class",
    "counter",
    "workflow_errors_total"
  );
  generateMetric(
    "pawtograder_workflow_runs_timeout",
    "Total number of workflow runs that timed out per class",
    "counter",
    "workflow_runs_timeout"
  );

  // === WORKFLOW PERFORMANCE METRICS ===
  generateMetric(
    "pawtograder_workflow_avg_queue_time_seconds",
    "Average time workflows wait in queue before starting (seconds)",
    "gauge",
    "workflow_avg_queue_time_seconds"
  );
  generateMetric(
    "pawtograder_workflow_avg_run_time_seconds",
    "Average workflow execution time (seconds)",
    "gauge",
    "workflow_avg_run_time_seconds"
  );

  // === USER ENGAGEMENT METRICS ===
  generateMetric(
    "pawtograder_active_students_total",
    "Total number of enrolled students per class",
    "gauge",
    "active_students_total"
  );
  generateMetric(
    "pawtograder_active_instructors_total",
    "Total number of instructors per class",
    "gauge",
    "active_instructors_total"
  );
  generateMetric(
    "pawtograder_active_graders_total",
    "Total number of graders per class",
    "gauge",
    "active_graders_total"
  );
  generateMetric(
    "pawtograder_students_active_7d",
    "Number of students active in the last 7 days per class",
    "gauge",
    "students_active_7d"
  );
  generateMetric(
    "pawtograder_students_active_24h",
    "Number of students active in the last 24 hours per class",
    "gauge",
    "students_active_24h"
  );

  // === ASSIGNMENT METRICS ===
  generateMetric(
    "pawtograder_assignments_total",
    "Total number of assignments per class",
    "gauge",
    "assignments_total"
  );
  generateMetric(
    "pawtograder_assignments_active",
    "Number of currently active assignments per class",
    "gauge",
    "assignments_active"
  );

  // === SUBMISSION METRICS ===
  generateMetric(
    "pawtograder_submissions_total",
    "Total number of active submissions per class",
    "counter",
    "submissions_total"
  );
  generateMetric(
    "pawtograder_submissions_recent_24h",
    "Number of submissions created in the last 24 hours per class",
    "gauge",
    "submissions_recent_24h"
  );
  generateMetric(
    "pawtograder_submissions_graded",
    "Number of submissions that have been graded per class",
    "gauge",
    "submissions_graded"
  );
  generateMetric(
    "pawtograder_submissions_pending_grading",
    "Number of submissions pending grading per class",
    "gauge",
    "submissions_pending_grading"
  );

  // === GRADING METRICS ===
  generateMetric(
    "pawtograder_submission_reviews_total",
    "Total number of completed submission reviews per class",
    "counter",
    "submission_reviews_total"
  );
  generateMetric(
    "pawtograder_submission_reviews_recent_7d",
    "Number of submission reviews completed in the last 7 days per class",
    "gauge",
    "submission_reviews_recent_7d"
  );
  generateMetric(
    "pawtograder_avg_grading_turnaround_hours",
    "Average time from submission to grading completion (hours)",
    "gauge",
    "avg_grading_turnaround_hours"
  );

  // === COMMENT METRICS ===
  generateMetric(
    "pawtograder_submission_comments_total",
    "Total number of submission comments (all types) per class",
    "counter",
    "submission_comments_total"
  );

  // === REGRADE REQUEST METRICS ===
  generateMetric(
    "pawtograder_regrade_requests_total",
    "Total number of regrade requests per class",
    "counter",
    "regrade_requests_total"
  );
  generateMetric(
    "pawtograder_regrade_requests_recent_7d",
    "Number of regrade requests in the last 7 days per class",
    "gauge",
    "regrade_requests_recent_7d"
  );

  // === DISCUSSION METRICS ===
  generateMetric(
    "pawtograder_discussion_threads_total",
    "Total number of discussion threads per class",
    "counter",
    "discussion_threads_total"
  );
  generateMetric(
    "pawtograder_discussion_posts_recent_7d",
    "Number of discussion posts in the last 7 days per class",
    "gauge",
    "discussion_posts_recent_7d"
  );

  // === HELP REQUEST METRICS ===
  generateMetric(
    "pawtograder_help_requests_total",
    "Total number of help requests per class",
    "counter",
    "help_requests_total"
  );
  generateMetric(
    "pawtograder_help_requests_open",
    "Number of currently open help requests per class",
    "gauge",
    "help_requests_open"
  );
  generateMetric(
    "pawtograder_help_requests_resolved_24h",
    "Number of help requests resolved in the last 24 hours per class",
    "gauge",
    "help_requests_resolved_24h"
  );
  generateMetric(
    "pawtograder_help_requests_avg_resolution_minutes",
    "Average help request resolution time (minutes)",
    "gauge",
    "help_requests_avg_resolution_minutes"
  );
  generateMetric(
    "pawtograder_help_request_messages_total",
    "Total number of help request messages per class",
    "counter",
    "help_request_messages_total"
  );

  // === NOTIFICATION METRICS ===
  generateMetric(
    "pawtograder_notifications_unread",
    "Number of unread notifications per class",
    "gauge",
    "notifications_unread"
  );

  // === SYSTEM COMPLEXITY METRICS ===
  generateMetric(
    "pawtograder_gradebook_columns_total",
    "Total number of gradebook columns per class (complexity indicator)",
    "gauge",
    "gradebook_columns_total"
  );

  // === LATE TOKEN USAGE METRICS ===
  generateMetric(
    "pawtograder_late_token_usage_total",
    "Total number of late tokens used per class",
    "counter",
    "late_token_usage_total"
  );
  generateMetric(
    "pawtograder_late_tokens_per_student_limit",
    "Late token limit per student per class",
    "gauge",
    "late_tokens_per_student_limit"
  );

  // === VIDEO MEETING METRICS ===
  generateMetric(
    "pawtograder_video_meeting_sessions_total",
    "Total number of video meeting sessions per class",
    "counter",
    "video_meeting_sessions_total"
  );
  generateMetric(
    "pawtograder_video_meeting_sessions_recent_7d",
    "Number of video meeting sessions in the last 7 days per class",
    "gauge",
    "video_meeting_sessions_recent_7d"
  );
  generateMetric(
    "pawtograder_video_meeting_participants_total",
    "Total number of video meeting participants per class",
    "counter",
    "video_meeting_participants_total"
  );
  generateMetric(
    "pawtograder_video_meeting_participants_recent_7d",
    "Number of video meeting participants in the last 7 days per class",
    "gauge",
    "video_meeting_participants_recent_7d"
  );
  generateMetric(
    "pawtograder_video_meeting_avg_duration_minutes",
    "Average video meeting duration in minutes per class",
    "gauge",
    "video_meeting_avg_duration_minutes"
  );
  generateMetric(
    "pawtograder_video_meeting_unique_users_7d",
    "Number of unique users in video meetings in the last 7 days per class",
    "gauge",
    "video_meeting_unique_users_7d"
  );

  // === SIS SYNC ERROR METRICS ===
  generateMetric(
    "pawtograder_sis_sync_errors_recent",
    "Number of recent SIS sync errors per class (enabled syncs with error status)",
    "gauge",
    "sis_sync_errors_recent"
  );

  // === LLM INFERENCE USAGE METRICS ===
  generateMetric(
    "pawtograder_llm_inference_total",
    "Total number of LLM inference requests per class",
    "counter",
    "llm_inference_total"
  );
  generateMetric(
    "pawtograder_llm_inference_recent_7d",
    "Number of LLM inference requests in the last 7 days per class",
    "gauge",
    "llm_inference_recent_7d"
  );
  generateMetric(
    "pawtograder_llm_input_tokens_total",
    "Total number of input tokens consumed per class",
    "counter",
    "llm_input_tokens_total"
  );
  generateMetric(
    "pawtograder_llm_output_tokens_total",
    "Total number of output tokens generated per class",
    "counter",
    "llm_output_tokens_total"
  );
  generateMetric(
    "pawtograder_llm_input_tokens_recent_7d",
    "Number of input tokens consumed in the last 7 days per class",
    "gauge",
    "llm_input_tokens_recent_7d"
  );
  generateMetric(
    "pawtograder_llm_output_tokens_recent_7d",
    "Number of output tokens generated in the last 7 days per class",
    "gauge",
    "llm_output_tokens_recent_7d"
  );
  generateMetric(
    "pawtograder_llm_unique_accounts",
    "Number of unique LLM accounts used per class",
    "gauge",
    "llm_unique_accounts"
  );
  generateMetric(
    "pawtograder_llm_unique_models",
    "Number of unique LLM models used per class",
    "gauge",
    "llm_unique_models"
  );
  generateMetric(
    "pawtograder_llm_unique_providers",
    "Number of unique LLM providers used per class",
    "gauge",
    "llm_unique_providers"
  );

  // === HINT FEEDBACK METRICS ===
  generateMetric(
    "pawtograder_hint_feedback_total",
    "Total number of hint feedback responses per class",
    "counter",
    "hint_feedback_total"
  );
  generateMetric(
    "pawtograder_hint_feedback_useful_total",
    "Number of hint feedback responses marked as useful per class",
    "counter",
    "hint_feedback_useful_total"
  );
  generateMetric(
    "pawtograder_hint_feedback_useful_percentage",
    "Percentage of hint feedback marked as useful per class",
    "gauge",
    "hint_feedback_useful_percentage"
  );
  generateMetric(
    "pawtograder_hint_feedback_recent_7d",
    "Number of hint feedback responses in the last 7 days per class",
    "gauge",
    "hint_feedback_recent_7d"
  );
  generateMetric(
    "pawtograder_hint_feedback_with_comments",
    "Number of hint feedback responses with written comments per class",
    "counter",
    "hint_feedback_with_comments"
  );

  // === ASSIGNMENT-LEVEL METRICS ===
  if (assignmentData && assignmentData.length > 0) {
    output += `# HELP pawtograder_assignment_llm_inference_total Total LLM inference requests per assignment
# TYPE pawtograder_assignment_llm_inference_total counter
`;
    for (const assignment of assignmentData) {
      const assignmentRecord = assignment as Record<string, unknown>;
      const labels = `assignment_id="${assignmentRecord.assignment_id}",assignment_title="${escapeLabel(String(assignmentRecord.assignment_title))}",class_id="${assignmentRecord.class_id}",class_name="${escapeLabel(String(assignmentRecord.class_name))}",class_slug="${escapeLabel(String(assignmentRecord.class_slug))}"`;
      output += `pawtograder_assignment_llm_inference_total{${labels}} ${assignmentRecord.llm_inference_total || 0} ${timestamp}\n`;
    }
    output += "\n";

    output += `# HELP pawtograder_assignment_llm_input_tokens_total Total input tokens consumed per assignment
# TYPE pawtograder_assignment_llm_input_tokens_total counter
`;
    for (const assignment of assignmentData) {
      const assignmentRecord = assignment as Record<string, unknown>;
      const labels = `assignment_id="${assignmentRecord.assignment_id}",assignment_title="${escapeLabel(String(assignmentRecord.assignment_title))}",class_id="${assignmentRecord.class_id}",class_name="${escapeLabel(String(assignmentRecord.class_name))}",class_slug="${escapeLabel(String(assignmentRecord.class_slug))}"`;
      output += `pawtograder_assignment_llm_input_tokens_total{${labels}} ${assignmentRecord.llm_input_tokens_total || 0} ${timestamp}\n`;
    }
    output += "\n";

    output += `# HELP pawtograder_assignment_llm_output_tokens_total Total output tokens generated per assignment
# TYPE pawtograder_assignment_llm_output_tokens_total counter
`;
    for (const assignment of assignmentData) {
      const assignmentRecord = assignment as Record<string, unknown>;
      const labels = `assignment_id="${assignmentRecord.assignment_id}",assignment_title="${escapeLabel(String(assignmentRecord.assignment_title))}",class_id="${assignmentRecord.class_id}",class_name="${escapeLabel(String(assignmentRecord.class_name))}",class_slug="${escapeLabel(String(assignmentRecord.class_slug))}"`;
      output += `pawtograder_assignment_llm_output_tokens_total{${labels}} ${assignmentRecord.llm_output_tokens_total || 0} ${timestamp}\n`;
    }
    output += "\n";

    output += `# HELP pawtograder_assignment_hint_feedback_total Total hint feedback responses per assignment
# TYPE pawtograder_assignment_hint_feedback_total counter
`;
    for (const assignment of assignmentData) {
      const assignmentRecord = assignment as Record<string, unknown>;
      const labels = `assignment_id="${assignmentRecord.assignment_id}",assignment_title="${escapeLabel(String(assignmentRecord.assignment_title))}",class_id="${assignmentRecord.class_id}",class_name="${escapeLabel(String(assignmentRecord.class_name))}",class_slug="${escapeLabel(String(assignmentRecord.class_slug))}"`;
      output += `pawtograder_assignment_hint_feedback_total{${labels}} ${assignmentRecord.hint_feedback_total || 0} ${timestamp}\n`;
    }
    output += "\n";

    output += `# HELP pawtograder_assignment_hint_feedback_useful_percentage Percentage of useful hint feedback per assignment
# TYPE pawtograder_assignment_hint_feedback_useful_percentage gauge
`;
    for (const assignment of assignmentData) {
      const assignmentRecord = assignment as Record<string, unknown>;
      const labels = `assignment_id="${assignmentRecord.assignment_id}",assignment_title="${escapeLabel(String(assignmentRecord.assignment_title))}",class_id="${assignmentRecord.class_id}",class_name="${escapeLabel(String(assignmentRecord.class_name))}",class_slug="${escapeLabel(String(assignmentRecord.class_slug))}"`;
      output += `pawtograder_assignment_hint_feedback_useful_percentage{${labels}} ${assignmentRecord.hint_feedback_useful_percentage || 0} ${timestamp}\n`;
    }
    output += "\n";
  }

  // === TAG-BASED EXPERIMENTAL METRICS ===
  if (tagsData && tagsData.length > 0) {
    output += `# HELP pawtograder_llm_inference_by_tags LLM inference requests broken down by experimental tags
# TYPE pawtograder_llm_inference_by_tags counter
`;
    for (const tag of tagsData) {
      const tagRecord = tag as Record<string, unknown>;
      const tagLabels = Object.entries((tagRecord.tags as Record<string, unknown>) || {})
        .map(([key, value]) => `tag_${key}="${escapeLabel(String(value))}"`)
        .join(",");

      const baseLabels = `class_id="${tagRecord.class_id}",class_name="${escapeLabel(String(tagRecord.class_name))}",class_slug="${escapeLabel(String(tagRecord.class_slug))}",provider="${escapeLabel(String(tagRecord.provider))}",model="${escapeLabel(String(tagRecord.model))}",account="${escapeLabel(String(tagRecord.account))}"`;
      const fullLabels = tagLabels ? `${baseLabels},${tagLabels}` : baseLabels;

      output += `pawtograder_llm_inference_by_tags{${fullLabels}} ${tagRecord.inference_count || 0} ${timestamp}\n`;
    }
    output += "\n";

    output += `# HELP pawtograder_llm_input_tokens_by_tags Input tokens consumed broken down by experimental tags
# TYPE pawtograder_llm_input_tokens_by_tags counter
`;
    for (const tag of tagsData) {
      const tagRecord = tag as Record<string, unknown>;
      const tagLabels = Object.entries((tagRecord.tags as Record<string, unknown>) || {})
        .map(([key, value]) => `tag_${key}="${escapeLabel(String(value))}"`)
        .join(",");

      const baseLabels = `class_id="${tagRecord.class_id}",class_name="${escapeLabel(String(tagRecord.class_name))}",class_slug="${escapeLabel(String(tagRecord.class_slug))}",provider="${escapeLabel(String(tagRecord.provider))}",model="${escapeLabel(String(tagRecord.model))}",account="${escapeLabel(String(tagRecord.account))}"`;
      const fullLabels = tagLabels ? `${baseLabels},${tagLabels}` : baseLabels;

      output += `pawtograder_llm_input_tokens_by_tags{${fullLabels}} ${tagRecord.input_tokens || 0} ${timestamp}\n`;
    }
    output += "\n";

    output += `# HELP pawtograder_llm_output_tokens_by_tags Output tokens generated broken down by experimental tags
# TYPE pawtograder_llm_output_tokens_by_tags counter
`;
    for (const tag of tagsData) {
      const tagRecord = tag as Record<string, unknown>;
      const tagLabels = Object.entries((tagRecord.tags as Record<string, unknown>) || {})
        .map(([key, value]) => `tag_${key}="${escapeLabel(String(value))}"`)
        .join(",");

      const baseLabels = `class_id="${tagRecord.class_id}",class_name="${escapeLabel(String(tagRecord.class_name))}",class_slug="${escapeLabel(String(tagRecord.class_slug))}",provider="${escapeLabel(String(tagRecord.provider))}",model="${escapeLabel(String(tagRecord.model))}",account="${escapeLabel(String(tagRecord.account))}"`;
      const fullLabels = tagLabels ? `${baseLabels},${tagLabels}` : baseLabels;

      output += `pawtograder_llm_output_tokens_by_tags{${fullLabels}} ${tagRecord.output_tokens || 0} ${timestamp}\n`;
    }
    output += "\n";
  }

  // === CIRCUIT BREAKER METRICS ===
  if (breakerEvents && breakerEvents.length > 0) {
    output += `# HELP pawtograder_github_circuit_breaker_trips_total Number of circuit breaker trips (last 24h)
# TYPE pawtograder_github_circuit_breaker_trips_total counter
`;
    const grouped: Record<string, number> = {};
    for (const evt of breakerEvents) {
      const key = `${evt.scope}|${evt.key}|${evt.reason ?? "unspecified"}`;
      grouped[key] = (grouped[key] || 0) + 1;
    }
    for (const [k, count] of Object.entries(grouped)) {
      const [scope, breakerKey, reason] = k.split("|");
      output += `pawtograder_github_circuit_breaker_trips_total{scope="${escapeLabel(scope)}",key="${escapeLabel(breakerKey)}",reason="${escapeLabel(reason)}"} ${count} ${timestamp}\n`;
    }
    output += "\n";
  }

  // === ASYNC GITHUB API RECENT METRICS (last hour) ===
  if (apiRecent && apiRecent.length > 0) {
    output += `# HELP pawtograder_github_api_calls_recent Number of API calls in the last hour per class/method/status
# TYPE pawtograder_github_api_calls_recent counter
`;
    for (const row of apiRecent) {
      output += `pawtograder_github_api_calls_recent{class_id="${row.class_id}",method="${escapeLabel(row.method)}",status_code="${row.status_code}"} ${row.calls} ${timestamp}\n`;
    }
    output += "\n";

    output += `# HELP pawtograder_github_api_avg_latency_ms_recent Average latency in ms for API calls in the last hour per class/method/status
# TYPE pawtograder_github_api_avg_latency_ms_recent gauge
`;
    for (const row of apiRecent) {
      output += `pawtograder_github_api_avg_latency_ms_recent{class_id="${row.class_id}",method="${escapeLabel(row.method)}",status_code="${row.status_code}"} ${row.avg_latency_ms ?? 0} ${timestamp}\n`;
    }
    output += "\n";
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
