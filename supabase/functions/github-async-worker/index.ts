import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import type {
  ArchiveRepoAndLockArgs,
  CreateRepoArgs,
  FetchRepoAnalyticsArgs,
  GitHubAsyncEnvelope,
  GitHubAsyncMethod,
  RerunAutograderArgs,
  SyncRepoPermissionsArgs,
  SyncRepoToHandoutArgs,
  SyncTeamArgs
} from "../_shared/GitHubAsyncTypes.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { PrimaryRateLimitError, SecondaryRateLimitError, getCreateContentLimiter } from "../_shared/GitHubWrapper.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { syncRepositoryToHandout, getFirstCommit } from "../_shared/GitHubSyncHelpers.ts";
// Declare EdgeRuntime for type safety
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

// Guard to prevent multiple concurrent batch handlers per runtime instance
let started = false;

type QueueMessage<T> = {
  msg_id: number;
  read_ct: number;
  vt: string;
  enqueued_at: string;
  message: T;
};

function toMsLatency(enqueuedAt: string): number {
  try {
    const start = new Date(enqueuedAt).getTime();
    const end = Date.now();
    return Math.max(0, end - start);
  } catch {
    return 0;
  }
}

const PGMQ_ARCHIVE_MAX_ATTEMPTS = 3;

/**
 * Moves a processed message from the active queue to PGMQ archive.
 * Retries on transient failures. Returns false if the message could still be in the queue (will redeliver after VT).
 */
async function archiveMessage(
  adminSupabase: SupabaseClient<Database>,
  msgId: number,
  scope: Sentry.Scope,
  queueName: string = "async_calls"
): Promise<boolean> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PGMQ_ARCHIVE_MAX_ATTEMPTS; attempt++) {
    try {
      const { error } = await adminSupabase.schema("pgmq_public").rpc("archive", {
        queue_name: queueName,
        message_id: msgId
      });

      if (error) {
        lastError = error;
        console.warn(
          `[pgmq] archive attempt ${attempt}/${PGMQ_ARCHIVE_MAX_ATTEMPTS} failed msg_id=${msgId} queue=${queueName}: ${error.message}`
        );
      } else {
        if (attempt > 1) {
          console.log(`[pgmq] archived msg_id=${msgId} queue=${queueName} (after ${attempt} attempts)`);
        } else {
          console.log(`[pgmq] archived msg_id=${msgId} queue=${queueName}`);
        }
        return true;
      }
    } catch (error) {
      lastError = error;
      console.warn(
        `[pgmq] archive attempt ${attempt}/${PGMQ_ARCHIVE_MAX_ATTEMPTS} threw msg_id=${msgId} queue=${queueName}:`,
        error
      );
    }

    if (attempt < PGMQ_ARCHIVE_MAX_ATTEMPTS) {
      const backoffMs = 150 * Math.pow(3, attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(
    `[pgmq] archive FAILED after ${PGMQ_ARCHIVE_MAX_ATTEMPTS} attempts msg_id=${msgId} queue=${queueName}: ${errMsg}`
  );
  scope.setContext("archive_error", {
    msg_id: msgId,
    queue_name: queueName,
    attempts: PGMQ_ARCHIVE_MAX_ATTEMPTS,
    error_message: errMsg
  });
  scope.setTag("pgmq_archive_failed", "true");
  Sentry.captureException(lastError instanceof Error ? lastError : new Error(String(lastError)), scope);
  return false;
}

function recordMetric(
  adminSupabase: SupabaseClient<Database>,
  params: {
    method: GitHubAsyncMethod;
    status_code: number;
    class_id?: number;
    debug_id?: string;
    enqueued_at?: string;
    log_id?: number;
  },
  scope: Sentry.Scope
) {
  const latency_ms = params.enqueued_at ? toMsLatency(params.enqueued_at) : undefined;

  // Fire-and-forget metric logging - don't let metric failures affect delivery status
  if (params.log_id) {
    // Update existing log record
    const log_result = adminSupabase.schema("public").rpc("update_api_gateway_call", {
      p_log_id: params.log_id,
      p_status_code: params.status_code,
      p_latency_ms: latency_ms
    });
    log_result.then((result) => {
      if (result.error) {
        console.error(result.error);
        Sentry.captureException(result.error, scope);
      }
    });
  } else {
    // Create new log record (fallback for backward compatibility)
    const log_result = adminSupabase.schema("public").rpc("log_api_gateway_call", {
      p_method: params.method,
      p_status_code: params.status_code,
      p_class_id: params.class_id,
      p_debug_id: params.debug_id,
      p_message_processed_at: new Date().toISOString(),
      p_latency_ms: latency_ms
    });
    log_result.then((result) => {
      if (result.error) {
        console.error(result.error);
        Sentry.captureException(result.error, scope);
      }
    });
  }
}

function parseRetryAfterSeconds(error: unknown): number | undefined {
  const err = error as {
    response?: { headers?: Record<string, string> };
    headers?: Record<string, string>;
    message?: string;
  };
  const headers = err?.response?.headers || (err as { headers?: Record<string, string> })?.headers;
  const retryAfter = headers?.["retry-after"] || headers?.["Retry-After"];
  if (retryAfter) {
    const seconds = parseInt(String(retryAfter), 10);
    if (!isNaN(seconds) && seconds >= 0) return seconds;
  }
  // If structured SecondaryRateLimitError with retryAfter, use it
  if (
    (error instanceof SecondaryRateLimitError || error instanceof PrimaryRateLimitError) &&
    typeof (error as { retryAfter?: number }).retryAfter === "number"
  ) {
    return (error as { retryAfter?: number }).retryAfter;
  }
  return undefined;
}

function isSecondaryRateLimit(error: unknown): boolean {
  return error instanceof SecondaryRateLimitError;
}

function isPrimaryRateLimit(error: unknown): boolean {
  return error instanceof PrimaryRateLimitError;
}

function getHeaders(error: unknown): Record<string, string> | undefined {
  const err = error as { response?: { headers?: Record<string, string> } };
  const h = err?.response?.headers;
  if (!h) return undefined;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v);
  return lower;
}

function detectRateLimitType(error: unknown): {
  type: "secondary" | "primary" | "extreme" | null;
  retryAfter?: number;
  installationId?: string;
} {
  if (isSecondaryRateLimit(error)) return { type: "secondary", retryAfter: parseRetryAfterSeconds(error) };
  if (isPrimaryRateLimit(error)) return { type: "primary", retryAfter: parseRetryAfterSeconds(error) };
  const err = error as { status?: number; message?: string; name?: string };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const headers = getHeaders(error);
  const retryAfter = headers ? parseInt(headers["retry-after"] || "", 10) : NaN;
  const remaining = headers ? parseInt(headers["x-ratelimit-remaining"] || "", 10) : NaN;
  const msg = (err?.message || "").toLowerCase();

  // Handle AggregateError from Octokit - "API rate limit exceeded for installation ID XYZ"
  if (
    err?.name === "AggregateError" ||
    (err?.message && err.message.toLowerCase().includes("api rate limit exceeded for installation id"))
  ) {
    const installationMatch = err.message?.match(/installation id (\d+)/i);
    const installationId = installationMatch ? installationMatch[1] : undefined;
    return { type: "secondary", retryAfter: 60, installationId };
  }

  if (status === 429) return { type: "secondary", retryAfter: isNaN(retryAfter) ? undefined : retryAfter };
  if (status === 403) {
    if (
      !isNaN(retryAfter) &&
      (isNaN(remaining) || remaining > 0 || msg.includes("secondary rate limit") || msg.includes("abuse"))
    ) {
      return { type: "secondary", retryAfter };
    }
    if (!isNaN(remaining) && remaining === 0) {
      return { type: "extreme", retryAfter: isNaN(retryAfter) ? undefined : retryAfter };
    }
  }
  return { type: null };
}

function computeBackoffSeconds(baseSeconds: number | undefined, retryCount: number): number {
  const base = Math.max(5, baseSeconds ?? 60);
  const exp = Math.min(6, Math.max(0, retryCount));
  const backoff = Math.min(900, base * Math.pow(2, exp));
  const jitter = Math.floor(Math.random() * Math.floor(backoff / 4));
  return backoff + jitter;
}

async function requeueWithDelay(
  adminSupabase: SupabaseClient<Database>,
  envelope: GitHubAsyncEnvelope,
  delaySeconds: number,
  scope: Sentry.Scope,
  queueName: string = "async_calls"
) {
  const newEnvelope: GitHubAsyncEnvelope = {
    ...envelope,
    retry_count: (envelope.retry_count ?? 0) + 1
  };
  const result = await adminSupabase.schema("pgmq_public").rpc("send", {
    queue_name: queueName,
    message: newEnvelope as unknown as Json,
    sleep_seconds: delaySeconds
  });
  if (result.error) {
    scope.setContext("requeue_error", { error_message: result.error.message, delay_seconds: delaySeconds });
    Sentry.captureException(result.error, scope);
  }
}

async function sendToDeadLetterQueue(
  adminSupabase: SupabaseClient<Database>,
  envelope: GitHubAsyncEnvelope,
  meta: { msg_id: number; enqueued_at: string },
  error: unknown,
  scope: Sentry.Scope
): Promise<boolean> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error ? error.constructor.name : "Unknown";
  const retryCount = envelope.retry_count ?? 0;

  // Send to DLQ queue
  try {
    const dlqResult = await adminSupabase.schema("pgmq_public").rpc("send", {
      queue_name: "async_calls_dlq",
      message: envelope as unknown as Json,
      sleep_seconds: 0
    });
    if (dlqResult.error) {
      scope.setContext("dlq_send_error", {
        error_message: dlqResult.error.message,
        original_msg_id: meta.msg_id
      });
      Sentry.captureException(dlqResult.error, scope);
      // Log to Sentry with comprehensive context before returning
      scope.setTag("dlq", "true");
      scope.setTag("retry_count", String(retryCount));
      scope.setContext("dead_letter_queue", {
        original_msg_id: meta.msg_id,
        method: envelope.method,
        retry_count: retryCount,
        error_message: errorMessage,
        error_type: errorType,
        enqueued_at: meta.enqueued_at,
        class_id: envelope.class_id,
        debug_id: envelope.debug_id,
        log_id: envelope.log_id
      });
      Sentry.captureMessage(
        `Failed to send message to dead letter queue after ${retryCount} retries: ${envelope.method}`,
        {
          level: "error",
          tags: {
            dlq: "true",
            method: envelope.method,
            retry_count: String(retryCount)
          }
        }
      );
      return false;
    }
  } catch (e) {
    scope.setContext("dlq_send_exception", {
      error_message: e instanceof Error ? e.message : String(e),
      original_msg_id: meta.msg_id
    });
    Sentry.captureException(e, scope);
    // Log to Sentry with comprehensive context before returning
    scope.setTag("dlq", "true");
    scope.setTag("retry_count", String(retryCount));
    scope.setContext("dead_letter_queue", {
      original_msg_id: meta.msg_id,
      method: envelope.method,
      retry_count: retryCount,
      error_message: errorMessage,
      error_type: errorType,
      enqueued_at: meta.enqueued_at,
      class_id: envelope.class_id,
      debug_id: envelope.debug_id,
      log_id: envelope.log_id
    });
    Sentry.captureMessage(
      `Failed to send message to dead letter queue after ${retryCount} retries: ${envelope.method}`,
      {
        level: "error",
        tags: {
          dlq: "true",
          method: envelope.method,
          retry_count: String(retryCount)
        }
      }
    );
    return false;
  }

  // Record in DLQ tracking table
  try {
    const queryBuilder = adminSupabase.from("async_worker_dlq_messages" as never);
    const { error: insertError } = await queryBuilder.insert({
      original_msg_id: meta.msg_id,
      method: envelope.method,
      envelope: envelope as unknown as Json,
      error_message: errorMessage,
      error_type: errorType,
      retry_count: retryCount,
      last_error_context: {
        error_message: errorMessage,
        error_type: errorType,
        enqueued_at: meta.enqueued_at,
        failed_at: new Date().toISOString()
      } as unknown as Json,
      class_id: envelope.class_id,
      debug_id: envelope.debug_id,
      log_id: envelope.log_id
    });

    if (insertError) {
      scope.setContext("dlq_table_insert_error", {
        error_message: insertError.message,
        original_msg_id: meta.msg_id
      });
      Sentry.captureException(insertError, scope);
      // Log to Sentry with comprehensive context before returning
      scope.setTag("dlq", "true");
      scope.setTag("retry_count", String(retryCount));
      scope.setContext("dead_letter_queue", {
        original_msg_id: meta.msg_id,
        method: envelope.method,
        retry_count: retryCount,
        error_message: errorMessage,
        error_type: errorType,
        enqueued_at: meta.enqueued_at,
        class_id: envelope.class_id,
        debug_id: envelope.debug_id,
        log_id: envelope.log_id
      });
      Sentry.captureMessage(
        `Failed to insert message into DLQ tracking table after ${retryCount} retries: ${envelope.method}`,
        {
          level: "error",
          tags: {
            dlq: "true",
            method: envelope.method,
            retry_count: String(retryCount)
          }
        }
      );
      return false;
    }
  } catch (e) {
    scope.setContext("dlq_table_insert_exception", {
      error_message: e instanceof Error ? e.message : String(e),
      original_msg_id: meta.msg_id
    });
    Sentry.captureException(e, scope);
    // Log to Sentry with comprehensive context before returning
    scope.setTag("dlq", "true");
    scope.setTag("retry_count", String(retryCount));
    scope.setContext("dead_letter_queue", {
      original_msg_id: meta.msg_id,
      method: envelope.method,
      retry_count: retryCount,
      error_message: errorMessage,
      error_type: errorType,
      enqueued_at: meta.enqueued_at,
      class_id: envelope.class_id,
      debug_id: envelope.debug_id,
      log_id: envelope.log_id
    });
    Sentry.captureMessage(
      `Failed to insert message into DLQ tracking table after ${retryCount} retries: ${envelope.method}`,
      {
        level: "error",
        tags: {
          dlq: "true",
          method: envelope.method,
          retry_count: String(retryCount)
        }
      }
    );
    return false;
  }

  // Log to Sentry with comprehensive context
  scope.setTag("dlq", "true");
  scope.setTag("retry_count", String(retryCount));
  scope.setContext("dead_letter_queue", {
    original_msg_id: meta.msg_id,
    method: envelope.method,
    retry_count: retryCount,
    error_message: errorMessage,
    error_type: errorType,
    enqueued_at: meta.enqueued_at,
    class_id: envelope.class_id,
    debug_id: envelope.debug_id,
    log_id: envelope.log_id
  });

  Sentry.captureMessage(`Message sent to dead letter queue after ${retryCount} retries: ${envelope.method}`, {
    level: "error",
    tags: {
      dlq: "true",
      method: envelope.method,
      retry_count: String(retryCount)
    }
  });

  return true;
}

async function recordGitHubAsyncError(
  adminSupabase: SupabaseClient<Database>,
  org: string,
  method: GitHubAsyncMethod,
  error: unknown,
  scope: Sentry.Scope
) {
  try {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorData = {
      method,
      error_message: errorMessage,
      error_type: error instanceof Error ? error.constructor.name : "Unknown"
    };

    await adminSupabase.schema("public").rpc("record_github_async_error", {
      p_org: org,
      p_method: method,
      p_error_data: errorData as unknown as Json
    });
  } catch (e) {
    scope.setContext("error_recording_failed", {
      original_error: error instanceof Error ? error.message : String(error),
      recording_error: e instanceof Error ? e.message : String(e)
    });
    Sentry.captureException(e, scope);
  }
}

async function checkAndTripErrorCircuitBreaker(
  adminSupabase: SupabaseClient<Database>,
  org: string,
  method: GitHubAsyncMethod,
  scope: Sentry.Scope
): Promise<boolean> {
  try {
    const result = await adminSupabase.schema("public").rpc("check_github_error_threshold", {
      p_org: org,
      p_threshold: 5,
      p_window_minutes: 5
    });

    if (result.error) {
      Sentry.captureException(result.error, scope);
      return false;
    }

    const errorCount = result.data as number;
    if (errorCount >= 20) {
      // Trip the circuit breaker for 8 hours - scoped to this method
      const circuitKey = `${org}:${method}`;
      const tripResult = await adminSupabase.schema("public").rpc("open_github_circuit", {
        p_scope: "org_method",
        p_key: circuitKey,
        p_event: "error_threshold",
        p_retry_after_seconds: 28800, // 8 hours
        p_reason: `Error threshold exceeded for ${method}: ${errorCount} errors in 5 minutes`
      });
      Sentry.captureMessage(`Opened BIG circuit breaker for ${method}`);

      if (!tripResult.error) {
        // Log special error to Sentry
        scope.setTag("circuit_breaker_reason", "error_threshold");
        scope.setContext("error_threshold_breach", {
          org,
          method,
          error_count: errorCount,
          window_minutes: 5,
          circuit_duration_hours: 8
        });

        Sentry.captureMessage(
          `GitHub async worker circuit breaker tripped for org ${org} method ${method}: error threshold exceeded. Circuit open for 8 hours.`,
          {
            level: "error"
          }
        );

        return true;
      }
    }

    return false;
  } catch (e) {
    scope.setContext("circuit_check_error", {
      org,
      method,
      error_message: e instanceof Error ? e.message : String(e)
    });
    Sentry.captureException(e, scope);
    return false;
  }
}

export async function processEnvelope(
  adminSupabase: SupabaseClient<Database>,
  envelope: GitHubAsyncEnvelope,
  meta: { msg_id: number; enqueued_at: string; queue_name?: string },
  _scope: Sentry.Scope
): Promise<boolean> {
  const queueName = meta.queue_name ?? "async_calls";
  const scope = _scope?.clone();
  scope.setTag("msg_id", String(meta.msg_id));
  scope.setTag("async_api_log_id", envelope.log_id);
  scope.setTag("async_method", envelope.method);
  if (envelope.class_id) scope.setTag("class_id", String(envelope.class_id));
  if (envelope.debug_id) scope.setTag("debug_id", envelope.debug_id);
  // Circuit breaker: check both org-level and method-specific circuits
  try {
    const org = ((): string | undefined => {
      if (envelope.method === "create_repo") return (envelope.args as CreateRepoArgs).org;
      if (envelope.method === "sync_student_team" || envelope.method === "sync_staff_team")
        return (envelope.args as SyncTeamArgs).org;
      if (envelope.method === "sync_repo_permissions" || envelope.method === "archive_repo_and_lock")
        return (envelope.args as SyncRepoPermissionsArgs | ArchiveRepoAndLockArgs).org;
      if (envelope.method === "rerun_autograder") {
        const repo = (envelope.args as RerunAutograderArgs).repository;
        return repo.split("/")[0];
      }
      if (envelope.method === "sync_repo_to_handout") {
        const repo = (envelope.args as SyncRepoToHandoutArgs).repository_full_name;
        return repo.split("/")[0];
      }
      if (envelope.method === "fetch_repo_analytics") return (envelope.args as FetchRepoAnalyticsArgs).org;
      throw new Error(`Unknown method, ignoring circuit breaker, seems dangerous. ${envelope.method}`);
    })();
    if (org) {
      // Check org-level circuit breaker first (highest priority - blocks everything)
      const orgCirc = await adminSupabase.schema("public").rpc("get_github_circuit", {
        p_scope: "org",
        p_key: org
      });
      if (!orgCirc.error && Array.isArray(orgCirc.data) && orgCirc.data.length > 0) {
        const row = orgCirc.data[0] as { state?: string; open_until?: string };
        if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
          // Check retry count - if >= 5, send to DLQ instead of requeuing
          const currentRetryCount = envelope.retry_count ?? 0;
          if (currentRetryCount >= 5) {
            const error = new Error(`Circuit breaker open for org ${org} after ${currentRetryCount} retries`);
            const dlqSuccess = await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
            if (dlqSuccess) {
              await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
            } else {
              console.error(`Failed to send message ${meta.msg_id} to DLQ, leaving unarchived`);
              scope.setContext("dlq_archive_skipped", {
                msg_id: meta.msg_id,
                reason: "DLQ send failed"
              });
              Sentry.captureMessage(`Message ${meta.msg_id} not archived due to DLQ failure`, {
                level: "error"
              });
            }
            return false;
          }
          const delaySeconds = 180; // minimum enforced delay while circuit open
          scope.setTag("circuit_state", "open");
          scope.setTag("circuit_scope", "org");
          await requeueWithDelay(adminSupabase, envelope, delaySeconds, scope, queueName);
          await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
          return false;
        }
      }

      // Check method-specific circuit breaker (only blocks this specific method)
      const circuitKey = `${org}:${envelope.method}`;
      const methodCirc = await adminSupabase.schema("public").rpc("get_github_circuit", {
        p_scope: "org_method",
        p_key: circuitKey
      });
      if (!methodCirc.error && Array.isArray(methodCirc.data) && methodCirc.data.length > 0) {
        const row = methodCirc.data[0] as { state?: string; open_until?: string };
        if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
          // Check retry count - if >= 5, send to DLQ instead of requeuing
          const currentRetryCount = envelope.retry_count ?? 0;
          if (currentRetryCount >= 5) {
            const error = new Error(`Circuit breaker open for ${envelope.method} after ${currentRetryCount} retries`);
            const dlqSuccess = await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
            if (dlqSuccess) {
              await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
            } else {
              console.error(`Failed to send message ${meta.msg_id} to DLQ, leaving unarchived`);
              scope.setContext("dlq_archive_skipped", {
                msg_id: meta.msg_id,
                reason: "DLQ send failed"
              });
              Sentry.captureMessage(`Message ${meta.msg_id} not archived due to DLQ failure`, {
                level: "error"
              });
            }
            return false;
          }
          const delaySeconds = 180; // minimum enforced delay while circuit open
          scope.setTag("circuit_state", "open");
          scope.setTag("circuit_scope", "org_method");
          scope.setTag("circuit_method", envelope.method);
          await requeueWithDelay(adminSupabase, envelope, delaySeconds, scope, queueName);
          await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
          return false;
        }
      }
    }
  } catch (e) {
    // circuit check failure should not break processing; continue
    Sentry.captureException(e, scope);
  }

  // Test DLQ failure injection - throw error if enabled via environment variable
  // When enabled, if a message has been retried at least once, always fail it again
  // to ensure it reaches the DLQ threshold (5 retries)
  // Protected: only enabled in non-production environments with explicit flag
  const nodeEnv = Deno.env.get("NODE_ENV");
  const injectDlqFailure = Deno.env.get("INJECT_DLQ_FAILURE");
  const retryCount = envelope.retry_count ?? 0;
  if (nodeEnv !== "production" && injectDlqFailure === "1") {
    if (retryCount >= 1 || Math.random() < 0.5) {
      const error = new Error(`DLQ test failure injection - simulating processing error (retry ${retryCount})`);
      scope.setTag("dlq_test_injection", "true");
      scope.setContext("dlq_test_injection", {
        retry_count: retryCount,
        method: envelope.method
      });
      throw error;
    }
  }

  try {
    switch (envelope.method) {
      case "sync_student_team": {
        const args = envelope.args as SyncTeamArgs;
        if (args.org === "pawtograder-playground" && args.courseSlug?.startsWith("e2e-ignore-")) {
          //No action, no metrics, no logging
          return true;
        }
        Sentry.addBreadcrumb({ message: `Syncing student team for user ${args.userId}`, level: "info" });
        if (args.userId) {
          //Make sure that the student has been invited to the org
          const { data, error } = await adminSupabase
            .from("user_roles")
            .select("invitation_date, users(github_username), classes(slug, github_org)")
            .eq("class_id", envelope.class_id || 0)
            .eq("user_id", args.userId)
            .eq("role", "student")
            .maybeSingle();
          if (error) throw error;
          if (
            data &&
            data.invitation_date === null &&
            data.users?.github_username &&
            data.classes?.github_org &&
            data.classes?.slug
          ) {
            await github.reinviteToOrgTeam(
              data.classes.github_org,
              `${data.classes.slug}-students`,
              data.users.github_username,
              scope
            );
          }
        }

        await github.syncStudentTeam(
          args.org,
          args.courseSlug,
          async () => {
            const { data, error } = await adminSupabase
              .from("user_roles")
              .select("github_org_confirmed, users(github_username)")
              .eq("class_id", envelope.class_id || 0)
              .eq("role", "student")
              .eq("disabled", false)
              .limit(1000);
            if (error) throw error;
            return (data || [])
              .filter((s) => s.users?.github_username && s.github_org_confirmed)
              .map((s) => s.users!.github_username!);
          },
          scope
        );
        // If an affected user is provided and they haven't been invited yet, ensure org invitation to students team
        if (args.userId && envelope.class_id) {
          const { data: ur, error } = await adminSupabase
            .from("user_roles")
            .select("invitation_date, users(github_username), classes(slug, github_org)")
            .eq("class_id", envelope.class_id)
            .eq("user_id", args.userId)
            .eq("role", "student")
            .single();
          if (
            !error &&
            ur &&
            ur.invitation_date === null &&
            ur.users?.github_username &&
            ur.classes?.github_org &&
            ur.classes?.slug
          ) {
            await github.reinviteToOrgTeam(
              ur.classes.github_org,
              `${ur.classes.slug}-students`,
              ur.users.github_username,
              scope
            );
          }
        }
        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: 200,
            class_id: envelope.class_id,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        return true;
      }
      case "sync_staff_team": {
        const args = envelope.args as SyncTeamArgs;
        if (args.org === "pawtograder-playground" && args.courseSlug?.startsWith("e2e-ignore-")) {
          //No action, no metrics, no logging
          return true;
        }
        Sentry.addBreadcrumb({ message: `Syncing staff team for org ${args.org}`, level: "info" });
        if (args.userId) {
          scope.setTag("user_id", args.userId);
          //Make sure that the student has been invited to the org
          const { data, error } = await adminSupabase
            .from("user_roles")
            .select("invitation_date, users(github_username), classes(slug, github_org)")
            .eq("class_id", envelope.class_id || 0)
            .eq("user_id", args.userId)
            .in("role", ["instructor", "grader"])
            .single();
          if (error) throw error;
          if (
            data &&
            data.invitation_date === null &&
            data.users?.github_username &&
            data.classes?.github_org &&
            data.classes?.slug
          ) {
            await github.reinviteToOrgTeam(
              data.classes.github_org,
              `${data.classes.slug}-staff`,
              data.users.github_username,
              scope
            );
          }
        }
        await github.syncStaffTeam(
          args.org,
          args.courseSlug,
          async () => {
            const { data, error } = await adminSupabase
              .from("user_roles")
              .select("users(github_username)")
              .eq("class_id", envelope.class_id || 0)
              .in("role", ["instructor", "grader"])
              .eq("github_org_confirmed", true)
              .limit(5000);
            if (error) throw error;
            return (data || []).map((s) => s.users!.github_username!).filter(Boolean);
          },
          scope
        );
        if (args.userId && envelope.class_id) {
          const { data: ur, error } = await adminSupabase
            .from("user_roles")
            .select("invitation_date, users(github_username), classes(slug, github_org)")
            .eq("class_id", envelope.class_id)
            .eq("user_id", args.userId)
            .in("role", ["instructor", "grader"])
            .single();
          if (
            !error &&
            ur &&
            ur.invitation_date === null &&
            ur.users?.github_username &&
            ur.classes?.github_org &&
            ur.classes?.slug
          ) {
            await github.reinviteToOrgTeam(
              ur.classes.github_org,
              `${ur.classes.slug}-staff`,
              ur.users.github_username,
              scope
            );
          }
        }
        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: 200,
            class_id: envelope.class_id,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        return true;
      }
      case "create_repo": {
        const { org, repoName, templateRepo, isTemplateRepo, courseSlug, githubUsernames } =
          envelope.args as CreateRepoArgs;
        if (
          org === "pawtograder-playground" &&
          (courseSlug?.startsWith("e2e-ignore-") || repoName.startsWith("test-e2e") || repoName.startsWith("e2e-test"))
        ) {
          //No action, no metrics, no logging
          return true;
        }
        Sentry.addBreadcrumb({ message: `Creating repo ${repoName} for org ${org}`, level: "info" });
        const limiter = getCreateContentLimiter(org);
        // createRepo patches repo settings after generate (squash merge on, template flag, branch ruleset, …).
        const headSha = await limiter.schedule(() =>
          github.createRepo(org, repoName, templateRepo, { is_template_repo: isTemplateRepo }, scope)
        );
        Sentry.addBreadcrumb({ message: `Repo created ${repoName} for org ${org}, head sha: ${headSha}` });
        await github.syncRepoPermissions(org, repoName, courseSlug, githubUsernames, scope);

        // Update repository record using the repo_id if provided (preferred method)
        try {
          const { data: latestHandoutCommit, error: latestHandoutCommitError } = await adminSupabase
            .from("assignments")
            .select("latest_template_sha")
            .eq("template_repo", templateRepo)
            .maybeSingle();
          if (latestHandoutCommitError) throw latestHandoutCommitError;
          if (envelope.repo_id) {
            // Direct update using repo_id (more efficient and reliable)
            const { error: updateError } = await adminSupabase
              .from("repositories")
              .update({
                is_github_ready: true,
                synced_repo_sha: headSha,
                synced_handout_sha: latestHandoutCommit?.latest_template_sha
              })
              .eq("id", envelope.repo_id);
            if (updateError) throw updateError;
          } else if (envelope.class_id) {
            // Fallback to old method for backward compatibility
            const fullName = `${org}/${repoName}`;
            const { error: updateError } = await adminSupabase
              .from("repositories")
              .update({
                is_github_ready: true,
                synced_repo_sha: headSha,
                synced_handout_sha: latestHandoutCommit?.latest_template_sha
              })
              .eq("class_id", envelope.class_id)
              .eq("repository", fullName);
            if (updateError) throw updateError;
          }
        } catch (e) {
          scope.setContext("repo_ready_update_error", {
            error_message: e instanceof Error ? e.message : String(e),
            repo_id: envelope.repo_id,
            class_id: envelope.class_id
          });
          Sentry.captureException(e, scope);
        }
        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: 200,
            class_id: envelope.class_id,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        return true;
      }
      case "sync_repo_permissions": {
        const { org, repo, courseSlug, githubUsernames } = envelope.args as SyncRepoPermissionsArgs;
        let repoName = repo;
        if (repoName.startsWith(org + "/")) {
          repoName = repoName.substring(org.length + 1);
        }
        if (org === "pawtograder-playground" && courseSlug?.startsWith("e2e-ignore-")) {
          //No action, no metrics, no logging
          return true;
        }
        Sentry.addBreadcrumb({ message: `Syncing repo permissions for ${repoName} in org ${org}`, level: "info" });
        //Make sure that the repo is ready. If not, we will requeue.
        //Otherwise we might race against a createRepo, and end up overwriting to the wrong githubUsernames.
        const { data: repository } = await adminSupabase
          .from("repositories")
          .select("is_github_ready")
          .eq("repository", `${org}/${repoName}`)
          .maybeSingle();
        if (!repository?.is_github_ready) {
          console.log("repo is not ready", `${org}/${repoName}`);
          return false;
        }
        await github.syncRepoPermissions(org, repoName, courseSlug, githubUsernames, scope);
        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: 200,
            class_id: envelope.class_id,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        return true;
      }
      case "archive_repo_and_lock": {
        const { org, repo } = envelope.args as ArchiveRepoAndLockArgs;
        if (org === "pawtograder-playground" && repo?.startsWith("e2e-ignore-")) {
          //No action, no metrics, no logging
          return true;
        }
        Sentry.addBreadcrumb({ message: `Archiving repo ${repo} for org ${org}`, level: "info" });
        await github.archiveRepoAndLock(org, repo, scope);
        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: 200,
            class_id: envelope.class_id,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        return true;
      }
      case "rerun_autograder": {
        const {
          submission_id,
          repository,
          sha,
          repository_check_run_id,
          triggered_by,
          repository_id,
          grader_sha,
          auto_promote,
          target_submission_id
        } = envelope.args as RerunAutograderArgs;

        // Use safe target_submission_id, falling back to submission_id if not provided
        const safeTargetSubmissionId = target_submission_id ?? submission_id;

        // Early return if neither submission_id nor target_submission_id exists
        if (!safeTargetSubmissionId) {
          throw new Error("Both submission_id and target_submission_id are missing");
        }

        scope.setTag("submission_id", String(submission_id));
        scope.setTag("repository", repository);
        scope.setTag("sha", sha);
        scope.setTag("triggered_by", triggered_by);
        scope.setTag("repository_id", String(repository_id));
        scope.setTag("requested_grader_sha", grader_sha || "(null)");
        scope.setTag("target_submission_id", String(safeTargetSubmissionId));

        Sentry.addBreadcrumb({
          message: `Rerunning autograder for submission ${submission_id} (${repository}@${sha})`,
          level: "info"
        });

        // Update repository_check_runs with rerun metadata
        const { error: updateError } = await adminSupabase
          .from("repository_check_runs")
          .update({
            triggered_by: triggered_by,
            is_regression_rerun: true,
            target_submission_id: safeTargetSubmissionId,
            requested_grader_sha: grader_sha ?? null,
            auto_promote_result: auto_promote ?? true
          })
          .eq("id", repository_check_run_id);

        if (updateError) {
          throw new Error(`Failed to update repository check run: ${updateError.message}`);
        }

        // Trigger the workflow
        await github.triggerWorkflow(repository, sha, "grade.yml", scope);

        // Clear the rerun_queued_at flag on the repository after successful trigger
        const { error: clearError } = await adminSupabase
          .from("repositories")
          .update({
            rerun_queued_at: null
          })
          .eq("id", repository_id);

        if (clearError) {
          // Log the error but don't fail the operation since the workflow was already triggered
          scope.setContext("clear_rerun_flag_error", {
            repository_id,
            error_message: clearError.message
          });
          Sentry.captureException(clearError, scope);
        }

        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: 200,
            class_id: envelope.class_id,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        return true;
      }
      case "sync_repo_to_handout": {
        const { repository_id, repository_full_name, template_repo, from_sha, to_sha } =
          envelope.args as SyncRepoToHandoutArgs;

        scope.setTag("repository_id", String(repository_id));
        scope.setTag("repository", repository_full_name);
        scope.setTag("template_repo", template_repo);
        scope.setTag("to_sha", to_sha);

        Sentry.addBreadcrumb({
          message: `Syncing ${repository_full_name} to handout SHA ${to_sha}`,
          level: "info"
        });

        try {
          // Check to see if the repo is already up to date, using first 6 chars of SHA
          const { data: currentRepo } = await adminSupabase
            .from("repositories")
            .select("synced_handout_sha, synced_repo_sha")
            .eq("id", repository_id)
            .maybeSingle();
          if (currentRepo?.synced_handout_sha?.substring(0, 6) === to_sha.substring(0, 6)) {
            Sentry.addBreadcrumb({
              message: `Repository ${repository_full_name} is already up to date`,
              level: "info"
            });
            return true;
          }

          // Get syncedRepoSha - either from DB or fetch first commit if not set
          let syncedRepoSha = currentRepo?.synced_repo_sha;
          if (!syncedRepoSha) {
            Sentry.addBreadcrumb({
              message: `No synced_repo_sha found for ${repository_full_name}, fetching first commit`,
              level: "info"
            });
            syncedRepoSha = await getFirstCommit(repository_full_name, "main", scope);
            Sentry.addBreadcrumb({
              message: `Using first commit as base: ${syncedRepoSha}`,
              level: "info"
            });
          }

          // Use the shared sync helper
          const result = await syncRepositoryToHandout({
            repositoryFullName: repository_full_name,
            templateRepo: template_repo,
            fromSha: from_sha,
            toSha: to_sha,
            syncedRepoSha,
            autoMerge: true,
            waitBeforeMerge: 2000,
            adminSupabase,
            scope
          });

          if (!result.success) {
            throw new Error(result.error || "Sync failed");
          }

          // Update repository with sync status
          if (result.no_changes) {
            const { error: updateError } = await adminSupabase
              .from("repositories")
              .update({
                synced_handout_sha: to_sha,
                desired_handout_sha: to_sha,
                sync_data: {
                  last_sync_attempt: new Date().toISOString(),
                  status: "no_changes_needed"
                }
              })
              .eq("id", repository_id);
            if (updateError) throw updateError;
          } else {
            const { error: updateError } = await adminSupabase
              .from("repositories")
              .update({
                synced_handout_sha: result.merged ? to_sha : from_sha,
                synced_repo_sha: result.merged ? result.merge_sha : undefined,
                desired_handout_sha: to_sha,
                sync_data: {
                  pr_number: result.pr_number,
                  pr_url: result.pr_url,
                  pr_state: result.merged ? "merged" : "open",
                  branch_name: `sync-to-${to_sha.substring(0, 7)}`,
                  last_sync_attempt: new Date().toISOString(),
                  merge_sha: result.merge_sha
                }
              })
              .eq("id", repository_id);
            if (updateError) throw updateError;
          }

          recordMetric(
            adminSupabase,
            {
              method: envelope.method,
              status_code: 200,
              class_id: envelope.class_id,
              debug_id: envelope.debug_id,
              enqueued_at: meta.enqueued_at,
              log_id: envelope.log_id
            },
            scope
          );
          return true;
        } catch (error) {
          console.trace(error);
          // Update repository with error status
          const { error: updateError } = await adminSupabase
            .from("repositories")
            .update({
              sync_data: {
                last_sync_attempt: new Date().toISOString(),
                last_sync_error: error instanceof Error ? error.message : String(error),
                status: "error"
              }
            })
            .eq("id", repository_id);
          if (updateError) {
            console.error("Failed to update repository with error status:", updateError);
            Sentry.captureException(updateError, scope);
          }
          throw error;
        }
      }
      case "fetch_repo_analytics": {
        const {
          assignment_id,
          org,
          repository_id: singleRepoId,
          repository_ids: repositoryIdBatch
        } = envelope.args as FetchRepoAnalyticsArgs;

        if (envelope.class_id == null) {
          throw new Error("fetch_repo_analytics requires class_id in envelope");
        }
        const classId = envelope.class_id;

        scope.setTag("assignment_id", String(assignment_id));
        scope.setTag("org", org);
        if (singleRepoId != null) scope.setTag("repository_id", String(singleRepoId));
        if (repositoryIdBatch != null && repositoryIdBatch.length > 0) {
          scope.setTag("repository_batch_size", String(repositoryIdBatch.length));
        }

        Sentry.addBreadcrumb({
          message: `Fetching repo analytics for assignment ${assignment_id} in org ${org}${
            singleRepoId != null
              ? ` (repo ${singleRepoId} only)`
              : repositoryIdBatch != null && repositoryIdBatch.length > 0
                ? ` (batch of ${repositoryIdBatch.length} repos)`
                : ""
          }`,
          level: "info"
        });

        let repos: { id: number; repository: string; assignment_id: number; class_id: number }[] = [];
        try {
          // Repos: single (UI), explicit batch (bulk enqueue), or all ready for assignment (legacy)
          const query = adminSupabase
            .from("repositories")
            .select("id, repository, assignment_id, class_id")
            .eq("assignment_id", assignment_id)
            .eq("is_github_ready", true);
          if (singleRepoId != null) {
            query.eq("id", singleRepoId);
          } else if (repositoryIdBatch != null && repositoryIdBatch.length > 0) {
            query.in("id", repositoryIdBatch);
          }
          const { data: reposData, error: reposError } = await query;

          if (reposError) throw reposError;
          repos = reposData ?? [];
          if (repos.length === 0) {
            Sentry.addBreadcrumb({ message: "No repositories found for assignment", level: "info" });
            // Single-repo UI refresh sets repository_analytics_fetch_status to "fetching" in
            // enqueue_repo_analytics_fetch; reconcile if the repo is missing from the worker query
            // (e.g. not GitHub-ready), so the row does not stay stuck in "fetching".
            if (singleRepoId != null) {
              const errMessage =
                "No GitHub-ready repository matched this request (repository may not be GitHub-ready yet).";
              const { error: reconcileErr } = await adminSupabase.from("repository_analytics_fetch_status").upsert(
                {
                  assignment_id,
                  class_id: classId,
                  repository_id: singleRepoId,
                  last_fetched_at: null,
                  status: "error",
                  error_message: errMessage
                },
                { onConflict: "assignment_id,repository_id" }
              );
              if (reconcileErr) {
                console.error("[repo-analytics] Failed to reconcile fetch status (empty repo list):", reconcileErr);
                Sentry.captureException(reconcileErr, scope);
              } else {
                Sentry.addBreadcrumb({
                  message: "Reconciled repository_analytics_fetch_status after empty repo query (single-repo)",
                  level: "warning",
                  data: {
                    assignment_id,
                    class_id: classId,
                    repository_id: singleRepoId,
                    debug_id: envelope.debug_id,
                    enqueued_at: meta.enqueued_at
                  }
                });
              }
            }
            recordMetric(
              adminSupabase,
              {
                method: envelope.method,
                status_code: 200,
                class_id: classId,
                debug_id: envelope.debug_id,
                enqueued_at: meta.enqueued_at,
                log_id: envelope.log_id
              },
              scope
            );
            return true;
          }

          const octokit = await github.getOctoKit(org, scope);
          if (!octokit) throw new Error(`No octokit found for org ${org}`);

          console.log(`[repo-analytics] Starting: assignment ${assignment_id}, org ${org}, ${repos.length} repo(s)`);

          // Fix 7: Rate limit budget — if remaining core requests fall below a fraction of the installation's limit, requeue
          const RATE_LIMIT_REQUEUE_DELAY_SECONDS = 1800; // 30 minutes
          try {
            const { data: rateLimit } = await octokit.request("GET /rate_limit");
            const core = rateLimit.resources.core;
            const remaining = core.remaining;
            const limit = core.limit;
            const rateLimitBudget = Math.max(Math.floor(limit * 0.2), 1000);
            console.log(
              `[repo-analytics] Rate limit: ${remaining}/${limit} remaining (budget ${rateLimitBudget} = max(20% of limit, 1000))`
            );
            if (remaining < rateLimitBudget) {
              const resetAt = new Date(core.reset * 1000);
              console.log(
                `[repo-analytics] Rate limit below budget: remaining=${remaining}, limit=${limit}, budget=${rateLimitBudget}. Requeuing in ${RATE_LIMIT_REQUEUE_DELAY_SECONDS}s. Core reset at ${resetAt.toISOString()}`
              );
              await requeueWithDelay(adminSupabase, envelope, RATE_LIMIT_REQUEUE_DELAY_SECONDS, scope, queueName);
              const archived = await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
              if (!archived) {
                console.error(
                  `[repo-analytics] requeued delayed copy but failed to archive original msg_id=${meta.msg_id} queue=${queueName}`
                );
              }
              return false;
            }
          } catch (e) {
            Sentry.addBreadcrumb({
              message: `Rate limit check failed, proceeding anyway: ${e}`,
              level: "warning"
            });
          }

          const { data: fetchStatuses } = await adminSupabase
            .from("repository_analytics_fetch_status")
            .select("repository_id, last_fetched_at")
            .eq("assignment_id", assignment_id)
            .in(
              "repository_id",
              repos.map((r) => r.id)
            );
          const sinceByRepo = new Map<number, string | null>(
            (fetchStatuses ?? []).map((f) => [f.repository_id, f.last_fetched_at])
          );

          // Fix 0: Per-repo API call counter for audit logging
          class ApiCallCounter {
            private counts: Record<string, number> = {};
            increment(category: string, n = 1) {
              this.counts[category] = (this.counts[category] ?? 0) + n;
            }
            get total() {
              return Object.values(this.counts).reduce((a, b) => a + b, 0);
            }
            summary() {
              return { ...this.counts, total: this.total };
            }
          }
          const assignmentCounter = new ApiCallCounter();

          const logRateLimit = async (
            oct: Awaited<ReturnType<typeof github.getOctoKit>>,
            label: string
          ): Promise<void> => {
            if (!oct) return;
            try {
              const { data: rl } = await oct.request("GET /rate_limit");
              const core = rl.resources.core;
              const resetAt = new Date(core.reset * 1000).toISOString();
              console.log(
                `[repo-analytics] rate_limit ${label}: ${core.remaining}/${core.limit} remaining, resets ${resetAt}`
              );
            } catch {
              // ignore
            }
          };

          const processRepo = async (
            repo: (typeof repos)[0]
          ): Promise<{
            repoFullName: string;
            repoId: number;
            error?: unknown;
            apiCalls?: ApiCallCounter;
          }> => {
            const repoFullName = repo.repository;
            const [repoOwner, repoName] = repoFullName.split("/");
            const sinceIso = sinceByRepo.get(repo.id) ?? null;
            const counter = new ApiCallCounter();
            console.log(
              `[repo-analytics] Processing ${repoFullName}${sinceIso ? ` (incremental since ${sinceIso})` : " (full fetch)"}`
            );
            try {
              // Fix 5: Use paginate.iterator (GitHub throttling via Octokit plugin handles rate limits)
              // Fix 1: Add since param for incremental fetching
              const issuesParams: Record<string, unknown> = {
                owner: repoOwner,
                repo: repoName,
                state: "all",
                per_page: 100
              };
              if (sinceIso) issuesParams.since = sinceIso;
              const issuesIterator = octokit.paginate
                .iterator("GET /repos/{owner}/{repo}/issues", issuesParams)
                [Symbol.asyncIterator]();
              const issues: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>["data"] = [];
              console.log(`[repo-analytics] ${repoFullName}: fetching issues...`);
              let iterResult = await issuesIterator.next();
              while (!iterResult.done) {
                counter.increment("issues_pages");
                issues.push(...iterResult.value.data);
                iterResult = await issuesIterator.next();
              }
              console.log(
                `[repo-analytics] ${repoFullName}: issues done (${issues.length} items, ${counter.total} API calls so far)`
              );

              const dailyMap = new Map<
                string,
                {
                  issues_opened: number;
                  issues_closed: number;
                  issue_comments: number;
                  prs_opened: number;
                  pr_review_comments: number;
                  commits: number;
                }
              >();

              const ensureDay = (dateStr: string) => {
                const day = dateStr.substring(0, 10);
                if (!dailyMap.has(day)) {
                  dailyMap.set(day, {
                    issues_opened: 0,
                    issues_closed: 0,
                    issue_comments: 0,
                    prs_opened: 0,
                    pr_review_comments: 0,
                    commits: 0
                  });
                }
                return day;
              };

              const itemUpserts: Array<{
                repository_id: number;
                class_id: number;
                assignment_id: number;
                item_type: string;
                github_id: string;
                title: string | null;
                url: string;
                author: string | null;
                created_date: string;
                state: string | null;
                updated_at: string;
                data?: object | null;
              }> = [];
              const now = new Date().toISOString();

              for (const issue of issues) {
                if (issue.pull_request) continue; // skip PRs in issues list
                const createdDay = ensureDay(issue.created_at);
                dailyMap.get(createdDay)!.issues_opened++;

                if (issue.closed_at) {
                  const closedDay = ensureDay(issue.closed_at);
                  dailyMap.get(closedDay)!.issues_closed++;
                }

                const issueData: {
                  labels?: string[];
                  body_preview?: string | null;
                  assignees?: string[];
                  closed_at?: string | null;
                  state_reason?: string | null;
                } = {
                  labels: (issue.labels as Array<{ name?: string }> | undefined)?.map((l) => l.name ?? String(l)) ?? [],
                  body_preview: issue.body?.substring(0, 400) ?? null,
                  assignees:
                    (issue.assignees as Array<{ login?: string }> | undefined)
                      ?.map((a) => a.login ?? "")
                      .filter(Boolean) ?? [],
                  closed_at: issue.closed_at ?? null,
                  state_reason: (issue as { state_reason?: string }).state_reason ?? null
                };
                itemUpserts.push({
                  repository_id: repo.id,
                  class_id: repo.class_id,
                  assignment_id: repo.assignment_id,
                  item_type: "issue",
                  github_id: String(issue.number),
                  title: issue.title,
                  url: issue.html_url,
                  author: issue.user?.login || null,
                  created_date: createdDay,
                  state: issue.state,
                  updated_at: now,
                  data: issueData
                });
              }

              // Fetch issue comments (Fix 5: iterator, Fix 1: since param)
              try {
                const issueCommentsParams: Record<string, unknown> = {
                  owner: repoOwner,
                  repo: repoName,
                  per_page: 100
                };
                if (sinceIso) issueCommentsParams.since = sinceIso;
                const issueCommentsIterator = octokit.paginate
                  .iterator("GET /repos/{owner}/{repo}/issues/comments", issueCommentsParams)
                  [Symbol.asyncIterator]();
                let issueCommentsIter = await issueCommentsIterator.next();
                while (!issueCommentsIter.done) {
                  counter.increment("issue_comments_pages");
                  for (const comment of issueCommentsIter.value.data) {
                    if (!comment.created_at) continue;
                    const day = ensureDay(comment.created_at);
                    dailyMap.get(day)!.issue_comments++;

                    itemUpserts.push({
                      repository_id: repo.id,
                      class_id: repo.class_id,
                      assignment_id: repo.assignment_id,
                      item_type: "issue_comment",
                      github_id: String(comment.id),
                      title: comment.body?.substring(0, 200) || null,
                      url: comment.html_url,
                      author: comment.user?.login || null,
                      created_date: day,
                      state: null,
                      updated_at: now
                    });
                  }
                  issueCommentsIter = await issueCommentsIterator.next();
                }
              } catch (e) {
                Sentry.addBreadcrumb({
                  message: `Error fetching issue comments for ${repoFullName}: ${e}`,
                  level: "warning"
                });
              }

              // Fix 4: Query existing PR items to skip file fetch for known PRs (keep stored data for upsert)
              type PrCommitFileData = {
                files: Array<{ filename: string; status?: string; additions: number; deletions: number }>;
              };
              const parseStoredFileData = (raw: unknown): PrCommitFileData | null => {
                if (raw && typeof raw === "object" && Array.isArray((raw as { files?: unknown }).files)) {
                  return raw as PrCommitFileData;
                }
                return null;
              };

              const { data: existingPrItems } = await adminSupabase
                .from("repository_analytics_items")
                .select("github_id, data")
                .eq("repository_id", repo.id)
                .eq("item_type", "pr");
              const existingPrDataByGithubId = new Map<string, unknown>(
                (existingPrItems ?? []).map((r) => [r.github_id, r.data])
              );
              const existingPrIds = new Set(existingPrDataByGithubId.keys());

              // Fetch PRs (paginated iterator with early exit when PRs are older than sinceIso)
              try {
                const prsParams = {
                  owner: repoOwner,
                  repo: repoName,
                  state: "all",
                  per_page: 100,
                  sort: "updated" as const,
                  direction: "desc" as const
                };
                const iterator = octokit.paginate
                  .iterator("GET /repos/{owner}/{repo}/pulls", prsParams)
                  [Symbol.asyncIterator]();
                let iterResult = await iterator.next();
                outer: while (!iterResult.done) {
                  counter.increment("prs_pages");
                  const response = iterResult.value;
                  for (const pr of response.data) {
                    if (sinceIso && new Date(pr.updated_at) <= new Date(sinceIso)) break outer;
                    const createdDay = ensureDay(pr.created_at);
                    dailyMap.get(createdDay)!.prs_opened++;
                    let prData: PrCommitFileData | null = null;
                    // Fix 4: Only fetch PR files for new PRs (not already in DB); reuse DB data for existing rows
                    const isNewPr = !existingPrIds.has(String(pr.number));
                    if (isNewPr) {
                      try {
                        counter.increment("pr_files");
                        const filesRes = await octokit.rest.pulls.listFiles({
                          owner: repoOwner,
                          repo: repoName,
                          pull_number: pr.number
                        });
                        prData = {
                          files: (filesRes.data ?? []).map((f) => ({
                            filename: f.filename,
                            status: f.status,
                            additions: f.additions ?? 0,
                            deletions: f.deletions ?? 0
                          }))
                        };
                      } catch {
                        // Continue without file data
                      }
                    } else {
                      prData = parseStoredFileData(existingPrDataByGithubId.get(String(pr.number)));
                    }
                    itemUpserts.push({
                      repository_id: repo.id,
                      class_id: repo.class_id,
                      assignment_id: repo.assignment_id,
                      item_type: "pr",
                      github_id: String(pr.number),
                      title: pr.title,
                      url: pr.html_url,
                      author: pr.user?.login || null,
                      created_date: createdDay,
                      state: pr.state,
                      updated_at: now,
                      data: prData
                    });
                  }
                  iterResult = await iterator.next();
                }
              } catch (e) {
                Sentry.addBreadcrumb({ message: `Error fetching PRs for ${repoFullName}: ${e}`, level: "warning" });
              }

              // Fetch PR review comments (Fix 5: iterator, Fix 1: since param)
              try {
                const reviewCommentsParams: Record<string, unknown> = {
                  owner: repoOwner,
                  repo: repoName,
                  per_page: 100
                };
                if (sinceIso) reviewCommentsParams.since = sinceIso;
                const reviewCommentsIterator = octokit.paginate
                  .iterator("GET /repos/{owner}/{repo}/pulls/comments", reviewCommentsParams)
                  [Symbol.asyncIterator]();
                let reviewCommentsIter = await reviewCommentsIterator.next();
                while (!reviewCommentsIter.done) {
                  counter.increment("pr_review_comments_pages");
                  for (const comment of reviewCommentsIter.value.data) {
                    if (!comment.created_at) continue;
                    const day = ensureDay(comment.created_at);
                    dailyMap.get(day)!.pr_review_comments++;

                    itemUpserts.push({
                      repository_id: repo.id,
                      class_id: repo.class_id,
                      assignment_id: repo.assignment_id,
                      item_type: "pr_review_comment",
                      github_id: String(comment.id),
                      title: comment.body?.substring(0, 200) || null,
                      url: comment.html_url,
                      author: comment.user?.login || null,
                      created_date: day,
                      state: null,
                      updated_at: now
                    });
                  }
                  reviewCommentsIter = await reviewCommentsIterator.next();
                }
              } catch (e) {
                Sentry.addBreadcrumb({
                  message: `Error fetching PR review comments for ${repoFullName}: ${e}`,
                  level: "warning"
                });
              }

              // Fix 2: Single default-branch commit listing (eliminates branches API call)
              // Fix 1: Add since param for incremental fetching
              try {
                const commitsParams: Record<string, unknown> = {
                  owner: repoOwner,
                  repo: repoName,
                  per_page: 100
                };
                if (sinceIso) commitsParams.since = sinceIso;
                const commitsIterator = octokit.paginate
                  .iterator("GET /repos/{owner}/{repo}/commits", commitsParams)
                  [Symbol.asyncIterator]();
                const commitsToProcess: Array<{
                  commit: Awaited<ReturnType<typeof octokit.rest.repos.listCommits>>["data"][number];
                  day: string;
                }> = [];
                let commitsIter = await commitsIterator.next();
                while (!commitsIter.done) {
                  counter.increment("commits_pages");
                  for (const commit of commitsIter.value.data) {
                    const dateStr = commit.commit.author?.date || commit.commit.committer?.date;
                    if (!dateStr) continue;
                    const day = ensureDay(dateStr);
                    dailyMap.get(day)!.commits++;
                    commitsToProcess.push({ commit, day });
                  }
                  commitsIter = await commitsIterator.next();
                }

                // Fix 3: Only fetch commit details for new commits (not already in DB); keep stored data otherwise
                const { data: existingCommitItems } = await adminSupabase
                  .from("repository_analytics_items")
                  .select("github_id, data")
                  .eq("repository_id", repo.id)
                  .eq("item_type", "commit");
                const existingCommitDataBySha = new Map<string, unknown>(
                  (existingCommitItems ?? []).map((r) => [r.github_id, r.data])
                );
                const existingCommitShas = new Set(existingCommitDataBySha.keys());

                for (let i = 0; i < commitsToProcess.length; i++) {
                  const { commit, day } = commitsToProcess[i];

                  let commitData: PrCommitFileData | null = null;
                  const isNewCommit = !existingCommitShas.has(commit.sha);
                  if (isNewCommit) {
                    try {
                      counter.increment("commit_details");
                      const fullCommit = await octokit.rest.repos.getCommit({
                        owner: repoOwner,
                        repo: repoName,
                        ref: commit.sha
                      });
                      commitData = {
                        files: (fullCommit.data.files ?? []).map((f) => ({
                          filename: f.filename,
                          status: f.status,
                          additions: f.additions ?? 0,
                          deletions: f.deletions ?? 0
                        }))
                      };
                      // 50ms spacing between commit-detail calls to avoid secondary rate limits (was 150ms)
                      if (i < commitsToProcess.length - 1) {
                        await new Promise((r) => setTimeout(r, 50));
                      }
                    } catch {
                      // Continue without file data
                    }
                  } else {
                    commitData = parseStoredFileData(existingCommitDataBySha.get(commit.sha));
                  }

                  itemUpserts.push({
                    repository_id: repo.id,
                    class_id: repo.class_id,
                    assignment_id: repo.assignment_id,
                    item_type: "commit",
                    github_id: commit.sha,
                    title: commit.commit.message?.substring(0, 200) || null,
                    url: commit.html_url,
                    author: commit.author?.login || commit.commit.author?.name || null,
                    created_date: day,
                    state: null,
                    updated_at: now,
                    data: commitData
                  });
                }
              } catch (e) {
                Sentry.addBreadcrumb({
                  message: `Error fetching commits for ${repoFullName}: ${e}`,
                  level: "warning"
                });
              }

              // When using incremental PR fetch (sinceIso), dailyMap.prs_opened only contains new PRs
              // since last fetch. Merge existing stored prs_opened so we don't overwrite with partial counts.
              if (sinceIso && dailyMap.size > 0) {
                const days = Array.from(dailyMap.keys());
                const { data: existingRows } = await adminSupabase
                  .from("repository_analytics_daily")
                  .select("date, prs_opened")
                  .eq("repository_id", repo.id)
                  .in("date", days);
                if (existingRows) {
                  for (const row of existingRows) {
                    const day = String(row.date);
                    const existing = Number(row.prs_opened) || 0;
                    const entry = dailyMap.get(day);
                    if (entry) entry.prs_opened += existing;
                  }
                }
              }

              // Upsert daily stats
              for (const [day, stats] of dailyMap.entries()) {
                const { error: dailyErr } = await adminSupabase.from("repository_analytics_daily").upsert(
                  {
                    repository_id: repo.id,
                    class_id: repo.class_id,
                    assignment_id: repo.assignment_id,
                    date: day,
                    ...stats,
                    updated_at: now
                  },
                  { onConflict: "repository_id,date" }
                );
                if (dailyErr) throw dailyErr;
              }

              // Upsert items in batches of 100
              for (let i = 0; i < itemUpserts.length; i += 100) {
                const batch = itemUpserts.slice(i, i + 100);
                const { error: itemsErr } = await adminSupabase
                  .from("repository_analytics_items")
                  .upsert(batch, { onConflict: "repository_id,item_type,github_id" });
                if (itemsErr) throw itemsErr;
              }
            } catch (repoError) {
              const errMsg = repoError instanceof Error ? repoError.message : String(repoError);
              console.error(`[repo-analytics] ERROR ${repoFullName}: ${errMsg}`);
              Sentry.addBreadcrumb({
                message: `Error processing repo ${repoFullName}: ${repoError}`,
                level: "error"
              });
              Sentry.captureException(repoError, scope);
              return { repoFullName, repoId: repo.id, error: repoError };
            }
            return { repoFullName, repoId: repo.id, apiCalls: counter };
          };

          // Sequential processing: one repo at a time for predictable debug output
          const failedByRepoId = new Map<number, string>();
          let repoIndex = 0;
          for (const repo of repos) {
            try {
              const result = await processRepo(repo);
              repoIndex++;
              if (result.error) {
                failedByRepoId.set(
                  result.repoId,
                  result.error instanceof Error ? result.error.message : String(result.error)
                );
              } else if (result.apiCalls) {
                const summary = result.apiCalls.summary();
                console.log(`[repo-analytics] ${result.repoFullName}: ${JSON.stringify(summary)}`);
                for (const [k, v] of Object.entries(summary)) {
                  if (k !== "total") assignmentCounter.increment(k, v);
                }
                if (repoIndex % 20 === 0) {
                  await logRateLimit(octokit, `after repo ${repoIndex}/${repos.length}`);
                }
              }
            } catch (err) {
              Sentry.captureException(err, scope);
            }
          }

          // Fix 0: Log assignment-level aggregate and rate limit remaining
          const totalCalls = assignmentCounter.total;
          if (totalCalls > 0) {
            const avgPerRepo = (totalCalls / repos.length).toFixed(1);
            let rateLimitRemaining = "unknown";
            try {
              const { data: rateLimit } = await octokit.request("GET /rate_limit");
              rateLimitRemaining = `${rateLimit.resources.core.remaining}/${rateLimit.resources.core.limit}`;
            } catch {
              // ignore
            }
            console.log(
              `[repo-analytics] Assignment ${assignment_id} complete: ${repos.length} repos, ${totalCalls} total API calls (avg ${avgPerRepo}/repo), rate_limit remaining: ${rateLimitRemaining}`
            );
            Sentry.addBreadcrumb({
              message: `Repo analytics: ${repos.length} repos, ${totalCalls} API calls, avg ${avgPerRepo}/repo`,
              level: "info",
              data: assignmentCounter.summary()
            });
          }

          // Update fetch status (one row per repository; schema unique is assignment_id, repository_id)
          const nowIso = new Date().toISOString();
          const fetchStatusRows = repos.map((r) => {
            const failedErr = failedByRepoId.get(r.id);
            return {
              assignment_id,
              class_id: classId,
              repository_id: r.id,
              last_fetched_at: failedErr ? null : nowIso,
              status: (failedErr ? "error" : "completed") as const,
              error_message: failedErr ?? null
            };
          });
          const { error: statusErr } = await adminSupabase
            .from("repository_analytics_fetch_status")
            .upsert(fetchStatusRows, { onConflict: "assignment_id,repository_id" });
          if (statusErr) throw statusErr;
        } catch (error) {
          // Update fetch status with error (one row per repository; repos may be undefined if error was before query)
          const errMsg = error instanceof Error ? error.message : String(error);
          const reposForStatus = repos;
          const fetchStatusErrorRows = reposForStatus.map((r) => ({
            assignment_id,
            class_id: classId,
            repository_id: r.id,
            last_fetched_at: new Date().toISOString(),
            status: "error" as const,
            error_message: errMsg
          }));
          if (fetchStatusErrorRows.length > 0) {
            await adminSupabase
              .from("repository_analytics_fetch_status")
              .upsert(fetchStatusErrorRows, { onConflict: "assignment_id,repository_id" });
            // Best-effort; ignore upsert errors
          }
          throw error;
        }

        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: 200,
            class_id: classId,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        return true;
      }
      default:
        throw new Error(`Unknown async method: ${(envelope as GitHubAsyncEnvelope).method}`);
    }
  } catch (error) {
    // Handle GitHub rate limits by re-queueing with a visibility delay
    console.trace(error);
    const rt = detectRateLimitType(error);
    scope.setTag("rate_limit_type", rt.type);

    // Use fingerprinting for rate limit errors to prevent notification storms
    // Don't include installationId in fingerprint - it varies and would create unique errors
    if (rt.type) {
      scope.setFingerprint(["github-rate-limit", rt.type, envelope.method]);
      if (rt.installationId) {
        scope.setContext("rate_limit_installation", {
          installation_id: rt.installationId,
          note: "Installation ID excluded from fingerprint to prevent notification storms"
        });
      }
    }

    const errorId = Sentry.captureException(error, scope);
    console.log(`Recorded error with ID: ${errorId}`);

    // Extract org for error tracking and circuit breaker logic
    const org = ((): string | undefined => {
      if (envelope.method === "create_repo") return (envelope.args as CreateRepoArgs).org;
      if (envelope.method === "sync_student_team" || envelope.method === "sync_staff_team")
        return (envelope.args as SyncTeamArgs).org;
      if (envelope.method === "sync_repo_permissions" || envelope.method === "archive_repo_and_lock")
        return (envelope.args as SyncRepoPermissionsArgs | ArchiveRepoAndLockArgs).org;
      if (envelope.method === "sync_repo_to_handout") {
        const repo = (envelope.args as SyncRepoToHandoutArgs).repository_full_name;
        return repo.split("/")[0];
      }
      if (envelope.method === "rerun_autograder") {
        const repo = (envelope.args as RerunAutograderArgs).repository;
        return repo.split("/")[0];
      }
      if (envelope.method === "fetch_repo_analytics") return (envelope.args as FetchRepoAnalyticsArgs).org;
      return undefined;
    })();

    try {
      if (rt.type === "secondary" || rt.type === "primary" || rt.type === "extreme") {
        const retryAfter = rt.retryAfter;
        // Defaults: primary=60s, secondary=180s, extreme=43200s (12h)
        const baseDefault = rt.type === "primary" ? 60 : rt.type === "secondary" ? 180 : 43200;
        const delay =
          rt.type === "extreme"
            ? baseDefault
            : computeBackoffSeconds(retryAfter ?? baseDefault, envelope.retry_count ?? 0);
        const type = rt.type;
        scope.setTag("rate_limit", type);
        scope.setContext("rate_limit_detail", {
          type,
          retry_after: retryAfter,
          delay_seconds: delay,
          retry_count: envelope.retry_count ?? 0
        });
        recordMetric(
          adminSupabase,
          {
            method: envelope.method,
            status_code: type === "secondary" ? 403 : 429,
            class_id: envelope.class_id,
            debug_id: envelope.debug_id,
            enqueued_at: meta.enqueued_at,
            log_id: envelope.log_id
          },
          scope
        );
        // Open circuit for this org to mass-slowdown (shorter for primary)
        try {
          if (org) {
            const { data: tripCountResult, error: tripErr } = await adminSupabase
              .schema("public")
              .rpc("open_github_circuit", {
                p_scope: "org",
                p_key: org,
                p_event: type,
                p_retry_after_seconds: rt.retryAfter,
                p_reason:
                  type === "secondary"
                    ? "secondary_rate_limit"
                    : type === "primary"
                      ? "primary_rate_limit"
                      : "extreme_rate_limit"
              });
            const tripCount = tripErr ? undefined : tripCountResult;
            if (tripCount) {
              Sentry.addBreadcrumb({ message: `Circuit trip #${tripCount} for ${org} (${type})`, level: "warning" });
              scope.setTag("circuit_trip_count", String(tripCount));
              if (tripCount >= 5) {
                Sentry.captureMessage(`Elevated circuit to 24h for ${org} after ${tripCount} trips`, {
                  level: "error"
                });
              }
            }
          }
        } catch (e) {
          console.error("error", e);
          Sentry.captureException(e, scope);
        }
        // Check retry count - if >= 5, send to DLQ instead of requeuing
        const currentRetryCount = envelope.retry_count ?? 0;
        if (currentRetryCount >= 5) {
          const dlqSuccess = await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
          if (dlqSuccess) {
            await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
          } else {
            console.error(`Failed to send message ${meta.msg_id} to DLQ, leaving unarchived`);
            scope.setContext("dlq_archive_skipped", {
              msg_id: meta.msg_id,
              reason: "DLQ send failed"
            });
            Sentry.captureMessage(`Message ${meta.msg_id} not archived due to DLQ failure`, {
              level: "error"
            });
          }
          return false;
        }

        // Check if we should trip the circuit breaker due to error threshold (8 hours)
        const circuitTripped = org
          ? await checkAndTripErrorCircuitBreaker(adminSupabase, org, envelope.method, scope)
          : false;
        if (circuitTripped) {
          // If circuit was tripped, requeue with 8-hour delay
          await requeueWithDelay(adminSupabase, envelope, 28800, scope, queueName); // 8 hours
          await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
          return false;
        }

        // Requeue with computed backoff delay for rate limit
        await requeueWithDelay(adminSupabase, envelope, delay, scope, queueName);
        await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
        return false;
      }

      // For non-rate-limit errors, record the error and check if we should trip the circuit breaker
      if (org) {
        // Record the error for tracking
        await recordGitHubAsyncError(adminSupabase, org, envelope.method, error, scope);

        // Immediately open circuit breaker for 30 seconds on any error - scoped to this method
        const circuitKey = `${org}:${envelope.method}`;
        try {
          await adminSupabase.schema("public").rpc("open_github_circuit", {
            p_scope: "org_method",
            p_key: circuitKey,
            p_event: "immediate_error",
            p_retry_after_seconds: 30,
            p_reason: `Immediate circuit breaker: ${envelope.method} error - ${error instanceof Error ? error.message : String(error)}`
          });
          Sentry.captureMessage(`Opened immediate circuit breaker for ${envelope.method}`);

          scope.setTag("immediate_circuit_breaker", "30s");
          scope.setTag("circuit_method", envelope.method);
          scope.setContext("immediate_circuit_detail", {
            org,
            method: envelope.method,
            duration_seconds: 30,
            error_message: error instanceof Error ? error.message : String(error)
          });
        } catch (e) {
          console.error("Failed to open immediate circuit breaker:", e);
          Sentry.captureException(e, scope);
        }

        // Check retry count - if >= 5, send to DLQ instead of requeuing
        const currentRetryCount = envelope.retry_count ?? 0;
        if (currentRetryCount >= 5) {
          const dlqSuccess = await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
          if (dlqSuccess) {
            await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
          } else {
            console.error(`Failed to send message ${meta.msg_id} to DLQ, leaving unarchived`);
            scope.setContext("dlq_archive_skipped", {
              msg_id: meta.msg_id,
              reason: "DLQ send failed"
            });
            Sentry.captureMessage(`Message ${meta.msg_id} not archived due to DLQ failure`, {
              level: "error"
            });
          }
          return false;
        }

        // Check if we should trip the circuit breaker due to error threshold (8 hours)
        const circuitTripped = await checkAndTripErrorCircuitBreaker(adminSupabase, org, envelope.method, scope);
        if (circuitTripped) {
          // If circuit was tripped, requeue with 8-hour delay
          await requeueWithDelay(adminSupabase, envelope, 28800, scope, queueName); // 8 hours
          await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
          return false;
        }

        // For immediate circuit breaker, requeue with 30-second delay
        await requeueWithDelay(adminSupabase, envelope, 30, scope, queueName); // 30 seconds
        await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
        return false;
      }

      const status = ((): number => {
        if (typeof error === "object" && error !== null && "status" in error) {
          const val = (error as { status?: unknown }).status;
          if (typeof val === "number") return val;
        }
        return 500;
      })();
      recordMetric(
        adminSupabase,
        {
          method: envelope.method,
          status_code: status || 500,
          class_id: envelope.class_id,
          debug_id: envelope.debug_id,
          enqueued_at: meta.enqueued_at,
          log_id: envelope.log_id
        },
        scope
      );

      // Check retry count - if >= 5, send to DLQ instead of requeuing
      const currentRetryCount = envelope.retry_count ?? 0;
      if (currentRetryCount >= 5) {
        const dlqSuccess = await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
        if (dlqSuccess) {
          await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
        } else {
          console.error(`Failed to send message ${meta.msg_id} to DLQ, leaving unarchived`);
          scope.setContext("dlq_archive_skipped", {
            msg_id: meta.msg_id,
            reason: "DLQ send failed"
          });
          Sentry.captureMessage(`Message ${meta.msg_id} not archived due to DLQ failure`, {
            level: "error"
          });
        }
        return false;
      }

      // For any error, requeue with 2-minute delay to prevent immediate retry
      scope.setContext("async_error", {
        method: envelope.method,
        status_code: status,
        error_message: error instanceof Error ? error.message : String(error),
        requeue_delay_seconds: 120
      });
      Sentry.captureException(error, scope);

      // Requeue with 2-minute delay and archive the current message
      await requeueWithDelay(adminSupabase, envelope, 120, scope, queueName); // 2 minutes
      await archiveMessage(adminSupabase, meta.msg_id, scope, queueName);
      return false;
    } catch (e) {
      console.error("error", e);
      Sentry.captureMessage("Error occurred when processing an error!", scope);
      Sentry.captureException(e, scope);
      return false;
    }
  }
}

export async function processBatch(adminSupabase: SupabaseClient<Database>, scope: Sentry.Scope) {
  let result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "async_calls",
    sleep_seconds: 60,
    n: 4
  });

  if (result.error) {
    Sentry.captureException(result.error, scope);
    return false;
  }

  let messages = (result.data || []) as QueueMessage<GitHubAsyncEnvelope>[];
  let queueName: "async_calls" | "async_calls_low_priority" = "async_calls";

  if (messages.length === 0) {
    result = await adminSupabase.schema("pgmq_public").rpc("read", {
      queue_name: "async_calls_low_priority",
      sleep_seconds: 60,
      n: 4
    });
    if (result.error) {
      Sentry.captureException(result.error, scope);
      return false;
    }
    messages = (result.data || []) as QueueMessage<GitHubAsyncEnvelope>[];
    queueName = "async_calls_low_priority";
  }

  if (messages.length === 0) return false;

  await Promise.allSettled(
    messages.map(async (msg) => {
      const ok = await processEnvelope(
        adminSupabase,
        msg.message,
        { msg_id: msg.msg_id, enqueued_at: msg.enqueued_at, queue_name: queueName },
        scope
      );
      if (ok) {
        const archived = await archiveMessage(adminSupabase, msg.msg_id, scope, queueName);
        if (!archived) {
          console.error(
            `[pgmq] worker: handler returned OK but archive failed msg_id=${msg.msg_id} queue=${queueName} — message will redeliver after VT`
          );
          Sentry.captureMessage(
            "github-async-worker: processed message but failed to archive after retries; expect redelivery",
            {
              level: "error",
              extra: { msg_id: msg.msg_id, queue_name: queueName }
            }
          );
        }
      }
    })
  );
  return true;
}

export async function runBatchHandler() {
  const scope = new Sentry.Scope();
  scope.setTag("function", "github_async_worker");

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const isRunning = true;
  while (isRunning) {
    try {
      const hasWork = await processBatch(adminSupabase, scope);
      if (!hasWork) {
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
    } catch (e) {
      Sentry.captureException(e, scope);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

if (import.meta.main) {
  Deno.serve((req) => {
    const secret = req.headers.get("x-edge-function-secret");
    const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");

    if (!expectedSecret) {
      return new Response(JSON.stringify({ error: "EDGE_FUNCTION_SECRET is not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }

    if (secret !== expectedSecret) {
      return new Response(JSON.stringify({ error: "Invalid or missing secret" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Bearer realm="github_async_worker", error="invalid_token"'
        }
      });
    }

    const already_running = started;

    if (!started) {
      started = true;
      EdgeRuntime.waitUntil(runBatchHandler());
    }

    return new Response(
      JSON.stringify({
        message: "GitHub async worker started",
        already_running: already_running,
        timestamp: new Date().toISOString()
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      }
    );
  });
}
