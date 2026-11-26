import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { recordForgejoHandoutPush } from "../_shared/forgejoHandoutCommits.ts";
import { type ForgejoConfig, getCommit } from "../_shared/ForgejoWrapper.ts";
import { isHandoutSyncPush } from "../_shared/handoutSyncPush.ts";
import {
  createPushDirectSubmission,
  type PushDirectPush,
  resolvePusherStanding
} from "../_shared/PushDirectSubmission.ts";
import {
  acceptStudentRepoPush,
  assignmentHasRepository,
  findStudentRepository,
  isDefaultBranchPush,
  type PushAssignment,
  recordCommitCheckRun,
  type RepoPush,
  type RepoPushCommit
} from "../_shared/RepoPush.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { classifyUnreadyRepoPush } from "../_shared/unreadyRepoPush.ts";
import {
  FORGEJO_ACTION_RUN_EVENTS,
  FORGEJO_IGNORED_ACTION_RUN_EVENTS,
  type ForgejoActionRun,
  isForgejoActionRunPayload
} from "./actionRun.ts";

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
  before?: string | null;
  after: string;
  repository: { full_name: string; html_url?: string; default_branch?: string | null; created_at?: string | null };
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

export function fromForgejoPush(payload: ForgejoPushPayload, receivedAt?: Date): RepoPush {
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
    pusherName: payload.pusher?.login || payload.pusher?.username || payload.sender?.login || "",
    ...(payload.before ? { before: payload.before } : {}),
    ...(payload.repository.created_at ? { repositoryCreatedAt: payload.repository.created_at } : {}),
    ...(receivedAt ? { receivedAt } : {})
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
export function isOnForgejoInstance(
  payload: { repository: { html_url?: string | null } },
  forgejoUrl: string
): boolean {
  return isUrlOnForgejoInstance(payload.repository.html_url, forgejoUrl);
}

function isUrlOnForgejoInstance(url: string | null | undefined, forgejoUrl: string): boolean {
  const base = forgejoUrl.replace(/\/+$/, "");
  return !!url?.startsWith(`${base}/`);
}

type RepositoryRow = Database["public"]["Tables"]["repositories"]["Row"];

/** What the push-direct path needs from the deployment, injectable for tests. */
export type ForgejoPushDeps = {
  /** The admin API settings, or null when the deployment has none. Needed for push-direct submissions. */
  forgejo: ForgejoConfig | null;
  /**
   * FORGEJO_ADMIN_USERNAME. Pawtograder makes every one of its own pushes as this account (repository
   * creation from the handout, staff file edits), so a push by it is never student work, the way a
   * `Bot` sender is on GitHub.
   */
  adminLogin: string | undefined;
  /** The repository's current head on `branch`. */
  getHeadSha?: (config: ForgejoConfig, repository: string, branch: string) => Promise<string>;
  createSubmission?: typeof createPushDirectSubmission;
  resolvePusherStanding?: typeof resolvePusherStanding;
};

/** Every commit the push lists, or its head commit when the payload lists none. */
function commitsToRecord(push: RepoPush): RepoPushCommit[] {
  if (push.totalCommits !== undefined && push.totalCommits > push.commits.length) {
    console.warn(
      `[forgejo-repo-webhook] ${push.repository}: the push has ${push.totalCommits} commits but the payload ` +
        `lists ${push.commits.length}; recording the ones it lists`
    );
  }
  // Forgejo sends head_commit separately, so it is there even when the commit list is empty
  // (PAYLOAD_COMMIT_LIMIT = 0). acceptStudentRepoPush has already refused a push without one.
  return push.commits.length > 0 ? push.commits : push.headCommit ? [push.headCommit] : [];
}

async function recordCommits(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: RepositoryRow,
  push: RepoPush,
  scope: Sentry.Scope
): Promise<void> {
  if (push.totalCommits !== undefined && push.totalCommits > push.commits.length) {
    scope.setTag("commits_truncated", "true");
  }
  for (const commit of commitsToRecord(push)) {
    await recordCommitCheckRun(adminSupabase, studentRepo, push, commit, scope);
  }
}

async function headOfBranch(config: ForgejoConfig, repository: string, branch: string): Promise<string> {
  return (await getCommit(config, repository, branch)).sha;
}

function isAdminPush(push: RepoPush, adminLogin: string | undefined): boolean {
  return !!adminLogin && push.pusherName.toLowerCase() === adminLogin.toLowerCase();
}

/**
 * Records a student's push in their commit history, or a push to a handout in the handout's. For a push-mode assignment with the autograder
 * off, a push to the default branch is also the student's submission, created here as
 * github-repo-webhook creates it for GitHub (#1110). With the autograder on, Forgejo Actions runs
 * grade.yml on its own and the workflow creates the submission, so this only records the history.
 */
export async function handleForgejoPush(
  adminSupabase: SupabaseClient<Database>,
  push: RepoPush,
  scope: Sentry.Scope,
  deps: ForgejoPushDeps = { forgejo: null, adminLogin: undefined }
): Promise<void> {
  const studentRepo = await findStudentRepository(adminSupabase, push.provider, push.repository, scope);
  if (!studentRepo) {
    if (await recordForgejoHandoutPush(adminSupabase, push, scope)) return;
    scope.setTag("skipped_reason", "not_a_student_repo");
    console.log(`[forgejo-repo-webhook] ${push.repository} is not a Forgejo student repository or handout`);
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
  const assignment = accepted.assignment;
  if (
    assignment?.submission_mode === "push" &&
    assignment.has_autograder === false &&
    assignmentHasRepository(assignment) &&
    push.headCommit
  ) {
    await handlePushDirect(adminSupabase, push, studentRepo, assignment, deps, scope);
    return;
  }
  await recordCommits(adminSupabase, studentRepo, push, scope);
}

/**
 * The push-direct path, in github-repo-webhook's order: provisioning and unready rows first, then
 * the commit history, then the reasons a push is not a submission (staff pushing to a student's
 * repository, a superseded delivery, a handout sync), then the submission itself.
 *
 * GitHub's circuit breaker is not consulted: it counts GitHub API failures, and nothing here calls
 * GitHub.
 */
async function handlePushDirect(
  adminSupabase: SupabaseClient<Database>,
  push: RepoPush,
  studentRepo: RepositoryRow,
  assignment: PushAssignment,
  deps: ForgejoPushDeps,
  scope: Sentry.Scope
): Promise<void> {
  const repoName = push.repository;
  const adminPush = isAdminPush(push, deps.adminLogin);
  if (!studentRepo.is_github_ready) {
    // The row is reserved unready before the repository is generated from the handout, and the
    // student gets write access only after that. So an admin push to an unready row is the
    // generation itself, the starter code and not student work: acknowledged and dropped, as
    // github-repo-webhook drops the push matching synced_repo_sha.
    if (adminPush) {
      scope.setTag("skipped_reason", "repo_provisioning_push");
      console.log(
        `[forgejo-repo-webhook] Skipping push-direct submission for ${repoName}@${push.after}: pushed by ` +
          `Pawtograder while the repository was being created`
      );
      return;
    }
    // Anyone else pushing means the repository works but its readiness write did not land. Thrown,
    // as on GitHub, so the delivery fails visibly instead of being acknowledged. Forgejo does not
    // redeliver on its own: the failed delivery stays in the hook's history for staff to redeliver
    // once the reconciler has marked the row ready.
    const unready = classifyUnreadyRepoPush({ before: push.before, repositoryCreatedAt: push.repositoryCreatedAt });
    scope.setTag("push_direct_retry_reason", "repo_not_github_ready");
    scope.setTag("repo_not_ready_kind", unready.kind);
    scope.setTag("repo_not_ready_reason", unready.reason);
    throw new Error(
      `${repoName} is not marked ready yet, but ${push.after} was pushed by ${push.pusherName || "an unknown user"} ` +
        `(${unready.kind}, ${unready.reason}); rejecting this delivery so it can be redelivered once the ` +
        `repository is marked ready`
    );
  }
  // History before any of the skips below, as on GitHub, so a skipped push still shows in the
  // student's commit history.
  await recordCommits(adminSupabase, studentRepo, push, scope);

  if (adminPush) {
    // Pawtograder's own commit (a staff file edit through Pawtograder, or a future handout sync).
    scope.setTag("skipped_reason", "handout_sync_push");
    console.log(
      `[forgejo-repo-webhook] Skipping push-direct submission for ${repoName}@${push.after}: pushed by ` +
        `Pawtograder's admin account, not the student`
    );
    return;
  }

  const config = deps.forgejo;
  if (!config) {
    // Without the admin API there is no head to compare and no archive to download. Thrown before
    // anything is created, so the failed delivery can be redelivered once the settings are in place.
    throw new Error(
      `Forgejo admin settings are not configured, so the push-direct submission for ${repoName}@${push.after} ` +
        `can't be created`
    );
  }

  const standing = await (deps.resolvePusherStanding ?? resolvePusherStanding)(
    adminSupabase,
    studentRepo,
    push.pusherName,
    scope,
    config.url
  );
  if (standing.isForeignStaff) {
    scope.setTag("skipped_reason", "staff_push_to_student_repo");
    console.log(
      `[forgejo-repo-webhook] Skipping push-direct submission for ${repoName}@${push.after}: pushed by course ` +
        `staff (${push.pusherName}) to a repository that is not theirs`
    );
    return;
  }

  const branch = push.defaultBranch || "main";
  const getHeadSha = deps.getHeadSha ?? headOfBranch;
  const readHead = async (): Promise<string> => {
    try {
      return await getHeadSha(config, repoName, branch);
    } catch (headErr) {
      // Not assumed current: an out-of-order delivery inserted as the newest would demote the
      // genuinely newer submission. See github-repo-webhook.
      scope.setTag("student_repo_head_lookup_failed", "true");
      Sentry.captureException(headErr, scope);
      throw new Error(
        `Could not resolve the current head of ${repoName} to check whether ${push.after} is superseded ` +
          `(${headErr instanceof Error ? headErr.message : String(headErr)})`
      );
    }
  };
  const head = await readHead();
  if (head !== push.after) {
    scope.setTag("skipped_reason", "push_superseded");
    console.log(
      `[forgejo-repo-webhook] Skipping push-direct submission for ${repoName}@${push.after}: the repository ` +
        `head is now ${head}, so a newer push supersedes this delivery`
    );
    return;
  }

  if (
    isHandoutSyncPush({
      headCommitMessage: push.headCommit?.message,
      senderType: undefined,
      afterSha: push.after,
      latestTemplateSha: assignment.latest_template_sha,
      desiredHandoutSha: studentRepo.desired_handout_sha,
      syncedHandoutSha: studentRepo.synced_handout_sha,
      syncedRepoSha: studentRepo.synced_repo_sha
    })
  ) {
    scope.setTag("skipped_reason", "handout_sync_push");
    console.log(
      `[forgejo-repo-webhook] Skipping push-direct submission for ${repoName}@${push.after}: handout-sync push, ` +
        `not student work`
    );
    return;
  }

  scope.setTag("push_direct_submission", "true");
  const pushDirect: PushDirectPush = {
    provider: "forgejo",
    repoName,
    sha: push.headCommit?.id ?? push.after,
    headCommitMessage: push.headCommit?.message ?? "",
    // Forgejo's push payload has no server-side push time (`repository.updated_at` moves with any
    // repository change), and the commit date is the student's to set, so this is the time the
    // request arrived. It is taken at request entry, not here: the repository, commit-history, staff
    // and head lookups above all run first, and a push that arrived on time must not turn late
    // because processing crossed the deadline.
    pushedAt: push.receivedAt ?? null,
    getHeadSha: readHead
  };
  await (deps.createSubmission ?? createPushDirectSubmission)(adminSupabase, pushDirect, studentRepo, {
    allowNotGradedSubmissions: assignment.allow_not_graded_submissions ?? false,
    permitEmptySubmissions: assignment.permit_empty_submissions ?? false,
    lateTokenPolicy: {
      maxLateTokens: assignment.max_late_tokens ?? 0,
      requireTokensBeforeDueDate: assignment.require_tokens_before_due_date ?? false,
      classLateTokensPerStudent: assignment.classes?.late_tokens_per_student ?? 0
    },
    actorIsStaffOwner: standing.isOwnerStaff,
    scope
  });
}

export type ForgejoWebhookConfig = {
  secret: string | undefined;
  forgejoUrl: string | undefined;
  handlePush: (push: RepoPush, scope: Sentry.Scope) => Promise<void>;
  handleActionRun: (run: ForgejoActionRun, scope: Sentry.Scope) => Promise<void>;
};

function isHandledActionRunEvent(event: string | null): boolean {
  return (FORGEJO_ACTION_RUN_EVENTS as readonly string[]).includes(event ?? "");
}

export async function handleForgejoWebhook(req: Request, config: ForgejoWebhookConfig): Promise<Response> {
  // Before anything else, so the deadline check sees when the push reached us rather than when
  // processing got to it.
  const receivedAt = new Date();
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
  const isActionRun = isHandledActionRunEvent(event);
  if (event !== "push" && !isActionRun) {
    const reason = (FORGEJO_IGNORED_ACTION_RUN_EVENTS as readonly string[]).includes(event ?? "")
      ? " (the action_run_success delivery for the same run is handled)"
      : "";
    return Response.json({ message: `Ignored ${event ?? "unknown"} event${reason}` });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ message: "Body is not JSON" }, { status: 400 });
  }
  if (isActionRun) {
    return await deliverActionRun(payload, event!, deliveryId, config);
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
    await config.handlePush(fromForgejoPush(payload, receivedAt), scope);
  } catch (err) {
    console.error(`[forgejo-repo-webhook] Error processing delivery ${deliveryId}`, err);
    Sentry.captureException(err, scope);
    return Response.json({ message: "Error processing webhook" }, { status: 500 });
  }
  return Response.json({ message: "Processed push" });
}

async function deliverActionRun(
  payload: unknown,
  event: string,
  deliveryId: string,
  config: ForgejoWebhookConfig
): Promise<Response> {
  if (!isForgejoActionRunPayload(payload)) {
    return Response.json({ message: "Not an action run payload" }, { status: 400 });
  }
  const { run } = payload;
  // The run's URL is shown to students and staff as a link, so it must be on the instance too.
  if (
    !isUrlOnForgejoInstance(run.repository.html_url, config.forgejoUrl!) ||
    !isUrlOnForgejoInstance(run.html_url, config.forgejoUrl!)
  ) {
    console.error(`[forgejo-repo-webhook] ${run.html_url} is not on ${config.forgejoUrl}`);
    return Response.json({ message: "Repository is not on the configured Forgejo instance" }, { status: 403 });
  }

  const scope = new Sentry.Scope();
  scope.setTag("webhook_source", "forgejo");
  scope.setTag("webhook_id", deliveryId);
  scope.setTag("webhook_name", event);
  scope.setTag("repository", run.repository.full_name);
  try {
    await config.handleActionRun(run, scope);
  } catch (err) {
    console.error(`[forgejo-repo-webhook] Error processing delivery ${deliveryId}`, err);
    Sentry.captureException(err, scope);
    return Response.json({ message: "Error processing webhook" }, { status: 500 });
  }
  return Response.json({ message: `Processed ${event}` });
}
