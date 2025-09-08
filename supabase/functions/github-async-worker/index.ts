import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { PrimaryRateLimitError, SecondaryRateLimitError } from "../_shared/GitHubWrapper.ts";
import type {
  GitHubAsyncEnvelope,
  GitHubAsyncMethod,
  SyncTeamArgs,
  CreateRepoArgs,
  SyncRepoPermissionsArgs,
  ArchiveRepoAndLockArgs
} from "../_shared/GitHubAsyncTypes.ts";
import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";

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
  console.log("detectRateLimitType error", error);
  if (isSecondaryRateLimit(error)) return { type: "secondary", retryAfter: parseRetryAfterSeconds(error) };
  if (isPrimaryRateLimit(error)) return { type: "primary", retryAfter: parseRetryAfterSeconds(error) };
  console.log("detectRateLimitType error is not a rate limit error");
  const err = error as { status?: number; message?: string };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const headers = getHeaders(error);
  const retryAfter = headers ? parseInt(headers["retry-after"] || "", 10) : NaN;
  const remaining = headers ? parseInt(headers["x-ratelimit-remaining"] || "", 10) : NaN;
  console.log("detectRateLimitType headers", headers);
  console.log("detectRateLimitType retryAfter", retryAfter);
  console.log("detectRateLimitType remaining", remaining);
  const msg = (err?.message || "").toLowerCase();
  console.log("detectRateLimitType msg", msg);
  console.log("detectRateLimitType status", status);
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

async function processEnvelope(
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
  // Circuit breaker: if org-level circuit is open, requeue immediately with a minimum delay
  try {
    const org = ((): string | undefined => {
      if (envelope.method === "create_repo") return (envelope.args as CreateRepoArgs).org;
      if (envelope.method === "sync_student_team" || envelope.method === "sync_staff_team")
        return (envelope.args as SyncTeamArgs).org;
      if (envelope.method === "sync_repo_permissions" || envelope.method === "archive_repo_and_lock")
        return (envelope.args as SyncRepoPermissionsArgs | ArchiveRepoAndLockArgs).org;
      return undefined;
    })();
    if (org) {
      const circ = await adminSupabase.schema("public").rpc("get_github_circuit", { p_scope: "org", p_key: org });
      if (!circ.error && Array.isArray(circ.data) && circ.data.length > 0) {
        const row = circ.data[0] as { state?: string; open_until?: string };
        if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
          const delaySeconds = 180; // minimum enforced delay while circuit open
          scope.setTag("circuit_state", "open");
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
        console.log(`Syncing student team for user ${args.userId}`);
        if (args.userId) {
          //Make sure that the student has been invited to the org
          const { data, error } = await adminSupabase
            .from("user_roles")
            .select("invitation_date, users(github_username), classes(slug, github_org)")
            .eq("class_id", envelope.class_id || 0)
            .eq("user_id", args.userId)
            .eq("role", "student")
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
        if (args.userId) {
          //Make sure that the student has been invited to the org
          const { data, error } = await adminSupabase
            .from("user_roles")
            .select("invitation_date, users(github_username), classes(slug, github_org)")
            .eq("class_id", envelope.class_id || 0)
            .eq("user_id", args.userId)
            .eq("role", "instructor")
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
              .or("role.eq.instructor,role.eq.grader")
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
        await github.createRepo(org, repoName, templateRepo, { is_template_repo: isTemplateRepo }, scope);
        await github.syncRepoPermissions(org, repoName, courseSlug, githubUsernames, scope);
        // Mark repository as ready if we can resolve the database record (idempotent best-effort)
        try {
          if (envelope.class_id) {
            // repository naming convention used earlier in enqueue: org / repoName
            const fullName = `${org}/${repoName}`;
            await adminSupabase
              .from("repositories")
              .update({ is_github_ready: true })
              .eq("class_id", envelope.class_id)
              .eq("repository", fullName);
          }
        } catch (e) {
          scope.setContext("repo_ready_update_error", { error_message: e instanceof Error ? e.message : String(e) });
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
        await github.syncRepoPermissions(org, repo, courseSlug, githubUsernames, scope);
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
      default:
        throw new Error(`Unknown async method: ${(envelope as GitHubAsyncEnvelope).method}`);
    }
  } catch (error) {
    // Handle GitHub rate limits by re-queueing with a visibility delay
    console.error("error caaught ->>>", error);
    const rt = detectRateLimitType(error);
    console.log("rt", rt.type);
    scope.setTag("rate_limit_type", rt.type);
    Sentry.captureException(error, scope);
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
          const org = ((): string | undefined => {
            if (envelope.method === "create_repo") return (envelope.args as CreateRepoArgs).org;
            if (envelope.method === "sync_student_team" || envelope.method === "sync_staff_team")
              return (envelope.args as SyncTeamArgs).org;
            if (envelope.method === "sync_repo_permissions" || envelope.method === "archive_repo_and_lock")
              return (envelope.args as SyncRepoPermissionsArgs | ArchiveRepoAndLockArgs).org;
            return undefined;
          })();
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
              if (tripCount >= 3) {
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
        await requeueWithDelay(adminSupabase, envelope, delay, scope);
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
          enqueued_at: meta.enqueued_at
        },
        scope
      );
      // On failure, do NOT archive so the message becomes visible again after VT
      scope.setContext("async_error", {
        method: envelope.method,
        status_code: status,
        error_message: error instanceof Error ? error.message : String(error)
      });
      Sentry.captureException(error, scope);
      return false;
    } catch (e) {
      console.error("error", e);
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
