import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import type {
  GitHubAsyncEnvelope,
  GitHubAsyncMethod,
  SyncTeamArgs,
  CreateRepoArgs,
  SyncRepoPermissionsArgs,
  ArchiveRepoAndLockArgs
} from "../_shared/GitHubAsyncTypes.ts";

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

async function recordMetric(
  adminSupabase: SupabaseClient<Database>,
  params: {
    method: GitHubAsyncMethod;
    status_code: number;
    class_id?: number;
    debug_id?: string;
    enqueued_at?: string;
  }
) {
  const latency_ms = params.enqueued_at ? toMsLatency(params.enqueued_at) : undefined;
  await adminSupabase.schema("public").rpc("log_api_gateway_call", {
    p_method: params.method,
    p_status_code: params.status_code,
    p_class_id: params.class_id,
    p_debug_id: params.debug_id,
    p_message_enqueued_at: params.enqueued_at ? new Date(params.enqueued_at).toISOString() : undefined,
    p_latency_ms: latency_ms
  });
}

async function processEnvelope(
  adminSupabase: SupabaseClient<Database>,
  envelope: GitHubAsyncEnvelope,
  meta: { msg_id: number; enqueued_at: string },
  scope: Sentry.Scope
): Promise<boolean> {
  scope.setTag("async_method", envelope.method);
  if (envelope.class_id) scope.setTag("class_id", String(envelope.class_id));
  if (envelope.debug_id) scope.setTag("debug_id", envelope.debug_id);

  try {
    switch (envelope.method) {
      case "sync_student_team": {
        const args = envelope.args as SyncTeamArgs;
        await github.syncStudentTeam(
          args.org,
          args.courseSlug,
          async () => {
            const { data, error } = await adminSupabase
              .from("user_roles")
              .select("github_org_confirmed, users(github_username)")
              .eq("class_id", envelope.class_id || 0)
              .or("role.eq.student")
              .limit(5000);
            if (error) throw error;
            return (data || [])
              .filter((s) => s.users?.github_username && s.github_org_confirmed)
              .map((s) => s.users!.github_username!);
          },
          scope
        );
        await recordMetric(adminSupabase, {
          method: envelope.method,
          status_code: 200,
          class_id: envelope.class_id,
          debug_id: envelope.debug_id,
          enqueued_at: meta.enqueued_at
        });
        return true;
      }
      case "sync_staff_team": {
        const args = envelope.args as SyncTeamArgs;
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
        await recordMetric(adminSupabase, {
          method: envelope.method,
          status_code: 200,
          class_id: envelope.class_id,
          debug_id: envelope.debug_id,
          enqueued_at: meta.enqueued_at
        });
        return true;
      }
      case "create_repo": {
        const { org, repoName, templateRepo, isTemplateRepo, courseSlug, githubUsernames } =
          envelope.args as CreateRepoArgs;
        await github.createRepo(org, repoName, templateRepo, { is_template_repo: isTemplateRepo }, scope);
        await github.syncRepoPermissions(org, repoName, courseSlug, githubUsernames, scope);
        await recordMetric(adminSupabase, {
          method: envelope.method,
          status_code: 200,
          class_id: envelope.class_id,
          debug_id: envelope.debug_id,
          enqueued_at: meta.enqueued_at
        });
        return true;
      }
      case "sync_repo_permissions": {
        const { org, repo, courseSlug, githubUsernames } = envelope.args as SyncRepoPermissionsArgs;
        await github.syncRepoPermissions(org, repo, courseSlug, githubUsernames, scope);
        await recordMetric(adminSupabase, {
          method: envelope.method,
          status_code: 200,
          class_id: envelope.class_id,
          debug_id: envelope.debug_id,
          enqueued_at: meta.enqueued_at
        });
        return true;
      }
      case "archive_repo_and_lock": {
        const { org, repo } = envelope.args as ArchiveRepoAndLockArgs;
        await github.archiveRepoAndLock(org, repo, scope);
        await recordMetric(adminSupabase, {
          method: envelope.method,
          status_code: 200,
          class_id: envelope.class_id,
          debug_id: envelope.debug_id,
          enqueued_at: meta.enqueued_at
        });
        return true;
      }
      default:
        throw new Error(`Unknown async method: ${(envelope as GitHubAsyncEnvelope).method}`);
    }
  } catch (error) {
    const status = ((): number => {
      if (typeof error === "object" && error !== null && "status" in error) {
        const val = (error as { status?: unknown }).status;
        if (typeof val === "number") return val;
      }
      return 500;
    })();
    await recordMetric(adminSupabase, {
      method: envelope.method,
      status_code: status || 500,
      class_id: envelope.class_id,
      debug_id: envelope.debug_id,
      enqueued_at: meta.enqueued_at
    });
    // On failure, do NOT archive so the message becomes visible again after VT
    scope.setContext("async_error", {
      method: envelope.method,
      status_code: status,
      error_message: error instanceof Error ? error.message : String(error)
    });
    Sentry.captureException(error, scope);
    return false;
  }
}

export async function processBatch(adminSupabase: SupabaseClient<Database>, scope: Sentry.Scope) {
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "async_calls",
    sleep_seconds: 60,
    n: 10
  });

  if (result.error) {
    Sentry.captureException(result.error, scope);
    return false;
  }
  const messages = (result.data || []) as QueueMessage<GitHubAsyncEnvelope>[];
  if (messages.length === 0) return false;

  for (const msg of messages) {
    const ok = await processEnvelope(
      adminSupabase,
      msg.message,
      { msg_id: msg.msg_id, enqueued_at: msg.enqueued_at },
      scope
    );
    if (ok) {
      await archiveMessage(adminSupabase, msg.msg_id, scope);
    }
  }
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

  if (!started) {
    started = true;
    EdgeRuntime.waitUntil(runBatchHandler());
  }

  return new Response(
    JSON.stringify({
      message: "GitHub async worker started",
      already_running: started,
      timestamp: new Date().toISOString()
    }),
    {
      headers: { "Content-Type": "application/json" }
    }
  );
});
