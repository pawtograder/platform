import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { Redis } from "../_shared/Redis.ts";
import type {
  ArchiveRepoAndLockArgs,
  CreateRepoArgs,
  GitHubAsyncEnvelope,
  GitHubAsyncMethod,
  RerunAutograderArgs,
  SyncRepoPermissionsArgs,
  SyncRepoToHandoutArgs,
  SyncTeamArgs
} from "../_shared/GitHubAsyncTypes.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { PrimaryRateLimitError, SecondaryRateLimitError } from "../_shared/GitHubWrapper.ts";
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

const createContentLimiters = new Map<string, Bottleneck>();
/**
 * GitHub limits the number of content-creating requests per organization per-minute and per-hour
 * @param org GitHub organization
 * @returns
 */
export function getCreateContentLimiter(org: string): Bottleneck {
  const key = org || "unknown";
  const existing = createContentLimiters.get(key);
  if (existing) return existing;
  let limiter: Bottleneck;
  const upstashUrl = Deno.env.get("UPSTASH_REDIS_REST_URL");
  const upstashToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
  if (upstashUrl && upstashToken) {
    const host = upstashUrl.replace("https://", "");
    const password = upstashToken;
    limiter = new Bottleneck({
      id: `create_content:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`,
      reservoir: 50,
      reservoirRefreshAmount: 50,
      reservoirRefreshInterval: 60_000,
      maxConcurrent: 50,
      datastore: "ioredis",
      timeout: 600000, // 10 minutes
      clearDatastore: false,
      clientOptions: {
        host,
        password,
        username: "default"
      },
      Redis
    });
    limiter.on("error", (err: Error) => console.error(err));
  } else {
    console.log("No Upstash URL or token found, using local limiter");
    Sentry.captureMessage("No Upstash URL or token found, using local limiter");
    limiter = new Bottleneck({
      id: `create_repo:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`,
      reservoir: 10,
      maxConcurrent: 10,
      reservoirRefreshAmount: 10,
      reservoirRefreshInterval: 60_000
    });
  }
  createContentLimiters.set(key, limiter);
  return limiter;
}

function toMsLatency(enqueuedAt: string): number {
  try {
    const start = new Date(enqueuedAt).getTime();
    const end = Date.now();
    return Math.max(0, end - start);
  } catch {
    return 0;
  }
}

async function archiveMessage(adminSupabase: SupabaseClient<Database>, msgId: number, scope: Sentry.Scope) {
  try {
    await adminSupabase.schema("pgmq_public").rpc("archive", {
      queue_name: "async_calls",
      message_id: msgId
    });
  } catch (error) {
    scope.setContext("archive_error", {
      msg_id: msgId,
      error_message: error instanceof Error ? error.message : String(error)
    });
    Sentry.captureException(error, scope);
  }
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
} {
  if (isSecondaryRateLimit(error)) return { type: "secondary", retryAfter: parseRetryAfterSeconds(error) };
  if (isPrimaryRateLimit(error)) return { type: "primary", retryAfter: parseRetryAfterSeconds(error) };
  const err = error as { status?: number; message?: string };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const headers = getHeaders(error);
  const retryAfter = headers ? parseInt(headers["retry-after"] || "", 10) : NaN;
  const remaining = headers ? parseInt(headers["x-ratelimit-remaining"] || "", 10) : NaN;
  const msg = (err?.message || "").toLowerCase();
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
  scope: Sentry.Scope
) {
  const newEnvelope: GitHubAsyncEnvelope = {
    ...envelope,
    retry_count: (envelope.retry_count ?? 0) + 1
  };
  const result = await adminSupabase.schema("pgmq_public").rpc("send", {
    queue_name: "async_calls",
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
) {
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
    }
  } catch (e) {
    scope.setContext("dlq_send_exception", {
      error_message: e instanceof Error ? e.message : String(e),
      original_msg_id: meta.msg_id
    });
    Sentry.captureException(e, scope);
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
    }
  } catch (e) {
    scope.setContext("dlq_table_insert_exception", {
      error_message: e instanceof Error ? e.message : String(e),
      original_msg_id: meta.msg_id
    });
    Sentry.captureException(e, scope);
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
  meta: { msg_id: number; enqueued_at: string },
  _scope: Sentry.Scope
): Promise<boolean> {
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
            await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
            await archiveMessage(adminSupabase, meta.msg_id, scope);
            return false;
          }
          const delaySeconds = 180; // minimum enforced delay while circuit open
          scope.setTag("circuit_state", "open");
          scope.setTag("circuit_scope", "org");
          await requeueWithDelay(adminSupabase, envelope, delaySeconds, scope);
          await archiveMessage(adminSupabase, meta.msg_id, scope);
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
            await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
            await archiveMessage(adminSupabase, meta.msg_id, scope);
            return false;
          }
          const delaySeconds = 180; // minimum enforced delay while circuit open
          scope.setTag("circuit_state", "open");
          scope.setTag("circuit_scope", "org_method");
          scope.setTag("circuit_method", envelope.method);
          await requeueWithDelay(adminSupabase, envelope, delaySeconds, scope);
          await archiveMessage(adminSupabase, meta.msg_id, scope);
          return false;
        }
      }
    }
  } catch (e) {
    // circuit check failure should not break processing; continue
    Sentry.captureException(e, scope);
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
        const { submission_id, repository, sha, repository_check_run_id, triggered_by, repository_id } =
          envelope.args as RerunAutograderArgs;
        scope.setTag("submission_id", String(submission_id));
        scope.setTag("repository", repository);
        scope.setTag("sha", sha);
        scope.setTag("triggered_by", triggered_by);
        scope.setTag("repository_id", String(repository_id));

        Sentry.addBreadcrumb({
          message: `Rerunning autograder for submission ${submission_id} (${repository}@${sha})`,
          level: "info"
        });

        // Update repository_check_runs with triggered_by
        const { error: updateError } = await adminSupabase
          .from("repository_check_runs")
          .update({
            triggered_by: triggered_by
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
      default:
        throw new Error(`Unknown async method: ${(envelope as GitHubAsyncEnvelope).method}`);
    }
  } catch (error) {
    // Handle GitHub rate limits by re-queueing with a visibility delay
    console.trace(error);
    const rt = detectRateLimitType(error);
    scope.setTag("rate_limit_type", rt.type);
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
          await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
          await archiveMessage(adminSupabase, meta.msg_id, scope);
          return false;
        }

        // Check if we should trip the circuit breaker due to error threshold (8 hours)
        const circuitTripped = org
          ? await checkAndTripErrorCircuitBreaker(adminSupabase, org, envelope.method, scope)
          : false;
        if (circuitTripped) {
          // If circuit was tripped, requeue with 8-hour delay
          await requeueWithDelay(adminSupabase, envelope, 28800, scope); // 8 hours
          await archiveMessage(adminSupabase, meta.msg_id, scope);
          return false;
        }

        // Requeue with computed backoff delay for rate limit
        await requeueWithDelay(adminSupabase, envelope, delay, scope);
        await archiveMessage(adminSupabase, meta.msg_id, scope);
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
          await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
          await archiveMessage(adminSupabase, meta.msg_id, scope);
          return false;
        }

        // Check if we should trip the circuit breaker due to error threshold (8 hours)
        const circuitTripped = await checkAndTripErrorCircuitBreaker(adminSupabase, org, envelope.method, scope);
        if (circuitTripped) {
          // If circuit was tripped, requeue with 8-hour delay
          await requeueWithDelay(adminSupabase, envelope, 28800, scope); // 8 hours
          await archiveMessage(adminSupabase, meta.msg_id, scope);
          return false;
        }

        // For immediate circuit breaker, requeue with 30-second delay
        await requeueWithDelay(adminSupabase, envelope, 30, scope); // 30 seconds
        await archiveMessage(adminSupabase, meta.msg_id, scope);
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
        await sendToDeadLetterQueue(adminSupabase, envelope, meta, error, scope);
        await archiveMessage(adminSupabase, meta.msg_id, scope);
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
      await requeueWithDelay(adminSupabase, envelope, 120, scope); // 2 minutes
      await archiveMessage(adminSupabase, meta.msg_id, scope);
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
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "async_calls",
    sleep_seconds: 60,
    n: 4
  });

  if (result.error) {
    Sentry.captureException(result.error, scope);
    return false;
  }
  const messages = (result.data || []) as QueueMessage<GitHubAsyncEnvelope>[];
  if (messages.length === 0) return false;

  await Promise.allSettled(
    messages.map(async (msg) => {
      const ok = await processEnvelope(
        adminSupabase,
        msg.message,
        { msg_id: msg.msg_id, enqueued_at: msg.enqueued_at },
        scope
      );
      if (ok) {
        await archiveMessage(adminSupabase, msg.msg_id, scope);
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
