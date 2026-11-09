import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  acceptStudentRepoPush,
  findStudentRepository,
  isDefaultBranchPush,
  recordCommitCheckRun,
  type RepoPush,
  type RepoPushCommit
} from "../_shared/RepoPush.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

/**
 * Forgejo signs the raw body with HMAC-SHA256 and the hook's secret, and sends the hex digest in
 * both headers. Older Gitea-compatible senders send only the second one.
 */
const SIGNATURE_HEADERS = ["X-Forgejo-Signature", "X-Gitea-Signature"];
const EVENT_HEADERS = ["X-Forgejo-Event", "X-Gitea-Event"];
const DELIVERY_HEADERS = ["X-Forgejo-Delivery", "X-Gitea-Delivery"];

function firstHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

/** 64 hex characters as 32 bytes, or null for anything else. */
function decodeSha256Hex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Whether `signature` is the HMAC-SHA256 of `body` under `secret`. `crypto.subtle.verify` compares
 * in constant time, and the signature is checked against the bytes as received, before any parsing.
 */
export async function verifyForgejoSignature(
  secret: string,
  body: Uint8Array<ArrayBuffer>,
  signature: string | null
): Promise<boolean> {
  if (!secret || !signature) return false;
  const expected = decodeSha256Hex(signature.trim());
  if (!expected) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return await crypto.subtle.verify("HMAC", key, expected, body);
}

type ForgejoCommit = {
  id: string;
  message: string;
  timestamp: string;
  author?: { name?: string } | null;
  removed?: string[] | null;
};

/** The fields of Forgejo's push payload (`api.PushPayload`) that the handler reads. */
export type ForgejoPushPayload = {
  ref: string;
  after: string;
  repository: { full_name: string; html_url?: string; default_branch?: string | null };
  head_commit?: ForgejoCommit | null;
  commits?: ForgejoCommit[] | null;
  /** The push's commit count. `commits` lists at most `webhook.PAYLOAD_COMMIT_LIMIT` of them. */
  total_commits?: number | null;
  pusher?: { login?: string; username?: string } | null;
  sender?: { login?: string } | null;
};

function toRepoPushCommit(commit: ForgejoCommit): RepoPushCommit {
  return {
    id: commit.id,
    // Forgejo keeps the newline git ends a message with; GitHub's payload doesn't have it.
    message: commit.message.replace(/\n+$/, ""),
    timestamp: commit.timestamp,
    author: { name: commit.author?.name ?? "" },
    // Forgejo is written in Go, which encodes an empty slice as null.
    removed: commit.removed ?? []
  };
}

export function fromForgejoPush(payload: ForgejoPushPayload): RepoPush {
  return {
    provider: "forgejo",
    repository: payload.repository.full_name,
    ref: payload.ref,
    after: payload.after,
    defaultBranch: payload.repository.default_branch,
    headCommit: payload.head_commit ? toRepoPushCommit(payload.head_commit) : null,
    // Forgejo lists the newest commit first. RepoPush, like GitHub, lists the oldest first, so the
    // commit history rows are written in the order the commits were made.
    commits: [...(payload.commits ?? [])].reverse().map(toRepoPushCommit),
    totalCommits: payload.total_commits ?? undefined,
    pusherName: payload.pusher?.login || payload.pusher?.username || payload.sender?.login || ""
  };
}

function isForgejoPushPayload(payload: unknown): payload is ForgejoPushPayload {
  const p = payload as ForgejoPushPayload | null;
  return (
    typeof p?.ref === "string" &&
    typeof p.after === "string" &&
    typeof p.repository?.full_name === "string" &&
    (p.commits == null || Array.isArray(p.commits))
  );
}

/**
 * Whether the repository is on the configured instance. FORGEJO_URL is Forgejo's ROOT_URL, which is
 * also how job tokens are bound to it (`jobTokenIssuer` in GitHubWrapper.ts), and Forgejo builds
 * `html_url` from ROOT_URL.
 */
export function isOnForgejoInstance(payload: ForgejoPushPayload, forgejoUrl: string): boolean {
  const base = forgejoUrl.replace(/\/+$/, "");
  return !!payload.repository.html_url?.startsWith(`${base}/`);
}

/**
 * Records a student's push in their commit history. Grading and push-direct submissions for Forgejo
 * repositories come with #1110, so nothing here clones the repository or starts a workflow.
 */
export async function handleForgejoPush(
  adminSupabase: SupabaseClient<Database>,
  push: RepoPush,
  scope: Sentry.Scope
): Promise<void> {
  const studentRepo = await findStudentRepository(adminSupabase, push.provider, push.repository, scope);
  if (!studentRepo) {
    scope.setTag("skipped_reason", "not_a_student_repo");
    console.log(`[forgejo-repo-webhook] ${push.repository} is not a Forgejo student repository`);
    return;
  }
  scope.setTag("student_repo", studentRepo.id.toString());
  if (!isDefaultBranchPush(push, scope)) {
    return;
  }
  const accepted = await acceptStudentRepoPush(adminSupabase, push, studentRepo, scope);
  if (!accepted) {
    return;
  }
  if (push.totalCommits !== undefined && push.totalCommits > push.commits.length) {
    scope.setTag("commits_truncated", "true");
    console.warn(
      `[forgejo-repo-webhook] ${push.repository}: the push has ${push.totalCommits} commits but the payload ` +
        `lists ${push.commits.length}; recording the ones it lists`
    );
  }
  // Forgejo sends head_commit separately, so it is there even when the commit list is empty
  // (PAYLOAD_COMMIT_LIMIT = 0). acceptStudentRepoPush has already refused a push without one.
  const commits = push.commits.length > 0 ? push.commits : push.headCommit ? [push.headCommit] : [];
  for (const commit of commits) {
    await recordCommitCheckRun(adminSupabase, studentRepo, push, commit, scope);
  }
}

export type ForgejoWebhookConfig = {
  secret: string | undefined;
  forgejoUrl: string | undefined;
  handlePush: (push: RepoPush, scope: Sentry.Scope) => Promise<void>;
};

export async function handleForgejoWebhook(req: Request, config: ForgejoWebhookConfig): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ message: "Method not allowed" }, { status: 405 });
  }
  if (!config.secret || !config.forgejoUrl) {
    console.error("[forgejo-repo-webhook] FORGEJO_WEBHOOK_SECRET or FORGEJO_URL is not set");
    return Response.json({ message: "Forgejo webhooks are not configured" }, { status: 500 });
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (!(await verifyForgejoSignature(config.secret, body, firstHeader(req.headers, SIGNATURE_HEADERS)))) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }

  const event = firstHeader(req.headers, EVENT_HEADERS);
  const deliveryId = firstHeader(req.headers, DELIVERY_HEADERS) ?? "";
  console.log(`[forgejo-repo-webhook] delivery=${deliveryId} event=${event}`);
  if (event !== "push") {
    return Response.json({ message: `Ignored ${event ?? "unknown"} event` });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ message: "Body is not JSON" }, { status: 400 });
  }
  if (!isForgejoPushPayload(payload)) {
    return Response.json({ message: "Not a push payload" }, { status: 400 });
  }
  if (!isOnForgejoInstance(payload, config.forgejoUrl)) {
    console.error(`[forgejo-repo-webhook] ${payload.repository.html_url} is not on ${config.forgejoUrl}`);
    return Response.json({ message: "Repository is not on the configured Forgejo instance" }, { status: 403 });
  }

  const scope = new Sentry.Scope();
  scope.setTag("webhook_source", "forgejo");
  scope.setTag("webhook_id", deliveryId);
  scope.setTag("webhook_name", event);
  scope.setTag("repository", payload.repository.full_name);
  try {
    await config.handlePush(fromForgejoPush(payload), scope);
  } catch (err) {
    console.error(`[forgejo-repo-webhook] Error processing delivery ${deliveryId}`, err);
    Sentry.captureException(err, scope);
    return Response.json({ message: "Error processing webhook" }, { status: 500 });
  }
  return Response.json({ message: "Processed push" });
}
