import { createEventHandler } from "npm:@octokit/webhooks@13";
import type {
  PushEvent,
  CheckRunEvent,
  MembershipEvent,
  OrganizationEvent,
  WorkflowRunEvent,
  PullRequestEvent,
  DeploymentStatusEvent
} from "https://esm.sh/@octokit/webhooks-types";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { parse } from "jsr:@std/yaml";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHash } from "node:crypto";
import safeRegex from "npm:safe-regex@2";
import { Buffer } from "node:buffer";
import { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import {
  getDefaultBranchHeadSha,
  getFileFromRepo,
  getOctoKit,
  SecondaryRateLimitError,
  PrimaryRateLimitError,
  repoHasFileAtRef
} from "../_shared/GitHubWrapper.ts";
import { getGitProvider } from "../_shared/GitProvider.ts";
import { isHandoutSyncPush } from "../_shared/handoutSyncPush.ts";
import {
  computeHandoutFileHashesForCommit,
  describeHandoutSeedResult,
  isExpectedHandoutSeedSkip,
  seedHandoutFileHashes,
  type HandoutHashCaches
} from "../_shared/handoutFileHashes.ts";
import { GradedUnit, MutationTestUnit, PawtograderConfig, RegularTestUnit } from "../_shared/PawtograderYml.d.ts";
import { ingestPrSubmissionFiles } from "../_shared/PrSubmissionFiles.ts";
import { prStateFromPullRequest } from "../_shared/PrState.ts";
import {
  createPushDirectSubmission,
  type PushDirectPush,
  resolvePusherStanding
} from "../_shared/PushDirectSubmission.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { createRedis, type RedisClient } from "../_shared/Redis.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { ExpectedRetryError, expectedRetryReport } from "../_shared/ExpectedRetryError.ts";
import { classifyUnreadyRepoPush } from "../_shared/unreadyRepoPush.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
import { serveWithSentryFlush } from "../_shared/SentryInit.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import {
  acceptStudentRepoPush,
  assignmentHasRepository,
  findStudentRepository,
  fromGitHubPush,
  isDefaultBranchPush,
  recordCommitCheckRun
} from "../_shared/RepoPush.ts";
const eventHandler = createEventHandler({
  secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret"
});

function detectRateLimitType(error: unknown): {
  type: "secondary" | "primary" | "extreme" | null;
  retryAfter?: number;
  installationId?: string;
} {
  const err = error as {
    status?: number;
    name?: string;
    message?: string;
    response?: {
      status?: number;
      headers?: Record<string, string>;
    };
  };
  const status = err?.status ?? err?.response?.status;
  const headers = err?.response?.headers;

  // Handle AggregateError from Octokit - "API rate limit exceeded for installation ID XYZ"
  if (
    err?.name === "AggregateError" ||
    (err?.message && err.message.toLowerCase().includes("api rate limit exceeded for installation id"))
  ) {
    const installationMatch = err.message?.match(/installation id (\d+)/i);
    const installationId = installationMatch ? installationMatch[1] : undefined;
    return { type: "secondary", retryAfter: 60, installationId };
  }

  if (error instanceof SecondaryRateLimitError) {
    return { type: "secondary", retryAfter: error.retryAfter };
  }
  if (error instanceof PrimaryRateLimitError) {
    return { type: "primary", retryAfter: error.retryAfter };
  }

  if (status === 403 || status === 429) {
    const retryAfter = headers?.["retry-after"] ? parseInt(headers["retry-after"], 10) : undefined;
    const remaining = headers?.["x-ratelimit-remaining"];
    if (remaining === "0") {
      return { type: "primary", retryAfter: retryAfter ?? 60 };
    }
    if (
      err?.message?.toLowerCase().includes("secondary rate limit") ||
      err?.message?.toLowerCase().includes("abuse detection")
    ) {
      return { type: "secondary", retryAfter: retryAfter ?? 60 };
    }
    const retryAfterVal = retryAfter ?? 60;
    if (retryAfterVal >= 300 || status === 429) {
      return { type: "extreme", retryAfter: retryAfterVal };
    }
    return { type: "secondary", retryAfter: retryAfterVal };
  }

  return { type: null };
}

// Redis client for webhook status tracking. createRedis picks ioredis
// (REDIS_URL) or the Upstash REST adapter (UPSTASH_REDIS_REST_*)
// automatically; both speak the SET/GET/EXPIRE subset this file uses.
let redisClient: RedisClient | null = null;
function getRedisClient(): RedisClient | null {
  if (redisClient) {
    return redisClient;
  }
  redisClient = createRedis();
  return redisClient;
}

// Webhook status structure stored in Redis
interface WebhookStatus {
  completed: boolean;
  attempt_count: number;
  event_name: string;
  last_attempt_at: string;
  last_error?: string;
}

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    beforeSend: normalizeEventFingerprint,
    ...sentryIdentity(),
    dsn: Deno.env.get("SENTRY_DSN")!,
    sendDefaultPii: true,
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}
const GRADER_WORKFLOW_PATH = ".github/workflows/grade.yml";

/**
 * Capture at the severity the error asked for.
 *
 * Most of what this webhook throws is a fault. Some of it is not: a few sites throw specifically to
 * make EventBridge redeliver the event (GitHub's webhook reaches this function through an
 * EventBridge rule, which is what retries a non-2xx), because a redelivery is what makes the
 * outcome correct (see ExpectedRetryError). Those must not be reported at `error` level, and they
 * must not share a
 * Bugsink group with genuine failures from the same frame — otherwise routine provisioning buries
 * the real thing. Concretely: one 58-student assignment release produced 412 error-level events
 * from one such throw site over the 88 minutes the create_repo queue took to drain.
 *
 * Used at the generic catch sites rather than at the throw sites, because the throw sites do not
 * capture — they throw, and these catches are what report. `expectedRetryReport` also looks inside an
 * AggregateError, which is how `eventHandler.receive` may hand a listener's throw to the entry catch,
 * so both catches agree on the level for the same underlying error.
 *
 * Anything without a report captures exactly as before, so no existing issue's grouping or severity
 * moves.
 */
function captureWebhookException(err: unknown, scope: Sentry.Scope) {
  const expected = expectedRetryReport(err);
  if (!expected) {
    Sentry.captureException(err, scope);
    return;
  }
  // Cloned rather than mutated: the caller's scope carries the tags for this delivery and may be
  // reused for further captures, which must not inherit the downgrade.
  const expectedScope = typeof scope?.clone === "function" ? scope.clone() : new Sentry.Scope();
  expectedScope.setLevel(expected.level);
  expectedScope.setFingerprint(expected.fingerprint);
  expectedScope.setTag("expected_retry", "true");
  Sentry.captureException(err, expectedScope);
}

/**
 * Returns true if the given file path appears in the modified/added/removed lists
 * of ANY commit in the push (not just `head_commit`). GitHub `push` events deliver
 * up to 20 commits in `payload.commits`; checking only `head_commit` misses changes
 * made in earlier commits of a multi-commit push.
 */
function pushTouchedFile(payload: PushEvent, path: string): boolean {
  const head = payload.head_commit;
  if (head && (head.modified.includes(path) || head.added.includes(path) || head.removed.includes(path))) {
    return true;
  }
  return payload.commits.some((c) => c.modified.includes(path) || c.added.includes(path) || c.removed.includes(path));
}

// Extend CheckRunStatus locally to track idempotent step markers without using 'any'
type ExtendedCheckRunStatus = CheckRunStatus & {
  check_run_created_at?: string;
  workflow_triggered_at?: string;
  check_run_marked_in_progress_at?: string;
};

// Fault injection helper for testing resiliency
function maybeCrash(tag: string) {
  const prob = parseFloat(Deno.env.get("WEBHOOK_FAULT_PROB") || "0");
  if (!(prob > 0)) return;
  const tags = (Deno.env.get("WEBHOOK_FAULT_TAGS") || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const enabled = tags.length === 0 || tags.includes(tag);
  if (enabled && Math.random() < prob) {
    console.error(`[FAULT] Injecting crash at ${tag}`);
    throw new Error(`Injected crash at ${tag}`);
  }
}

// Check if org-level or method-specific circuit breaker is open before making GitHub API calls
async function checkCircuitBreakerOpen(
  adminSupabase: SupabaseClient<Database>,
  org: string,
  method?: string,
  scope?: Sentry.Scope
): Promise<{ isOpen: boolean; reason?: string; openUntil?: string; circuitScope?: string }> {
  try {
    // Check org-level circuit breaker first (highest priority - blocks everything)
    const orgCirc = await adminSupabase.schema("public").rpc("get_github_circuit", {
      p_scope: "org",
      p_key: org
    });
    if (!orgCirc.error && Array.isArray(orgCirc.data) && orgCirc.data.length > 0) {
      const row = orgCirc.data[0] as { state?: string; open_until?: string; reason?: string };
      if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
        scope?.setTag("circuit_state", "open");
        scope?.setTag("circuit_scope", "org");
        scope?.setContext("circuit_breaker_active", {
          org,
          reason: row.reason || "Circuit breaker active",
          open_until: row.open_until
        });
        return { isOpen: true, reason: row.reason, openUntil: row.open_until, circuitScope: "org" };
      }
    }

    // Check method-specific circuit breaker if method is provided
    if (method) {
      const circuitKey = `${org}:${method}`;
      const methodCirc = await adminSupabase.schema("public").rpc("get_github_circuit", {
        p_scope: "org_method",
        p_key: circuitKey
      });
      if (!methodCirc.error && Array.isArray(methodCirc.data) && methodCirc.data.length > 0) {
        const row = methodCirc.data[0] as { state?: string; open_until?: string; reason?: string };
        if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
          scope?.setTag("circuit_state", "open");
          scope?.setTag("circuit_scope", "org_method");
          scope?.setTag("circuit_method", method);
          scope?.setContext("circuit_breaker_active", {
            org,
            method,
            reason: row.reason || "Circuit breaker active",
            open_until: row.open_until
          });
          return { isOpen: true, reason: row.reason, openUntil: row.open_until, circuitScope: "org_method" };
        }
      }
    }

    return { isOpen: false };
  } catch (e) {
    scope?.setContext("circuit_check_warning", {
      org,
      method,
      error_message: e instanceof Error ? e.message : String(e)
    });
    Sentry.captureException(e, scope);
    return { isOpen: false };
  }
}

type GitHubCommit = PushEvent["commits"][number];

/**
 * A GitHub push in the terms createPushDirectSubmission takes. The push time is GitHub's
 * `repository.pushed_at` (epoch seconds or ISO), which every redelivery of the push repeats.
 */
function gitHubPushDirectPush(payload: PushEvent, scope: Sentry.Scope): PushDirectPush {
  const pushedAtRaw = payload.repository?.pushed_at as unknown;
  const pushedAt =
    typeof pushedAtRaw === "number"
      ? new Date(pushedAtRaw * 1000)
      : typeof pushedAtRaw === "string"
        ? new Date(pushedAtRaw)
        : null;
  return {
    provider: "github",
    repoName: payload.repository.full_name,
    sha: payload.head_commit!.id,
    headCommitMessage: payload.head_commit!.message,
    pushedAt,
    getHeadSha: () => getDefaultBranchHeadSha(payload.repository.full_name, scope)
  };
}

async function handlePushToStudentRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  scope: Sentry.Scope
) {
  // Repository lookup, the pr-mode, tag, head-commit and repo-mode guards, and commit recording are
  // shared with forgejo-repo-webhook (_shared/RepoPush.ts). What follows them is GitHub's.
  const push = fromGitHubPush(payload);
  const accepted = await acceptStudentRepoPush(adminSupabase, push, studentRepo, scope);
  if (!accepted || !payload.head_commit) {
    return;
  }
  const pushAssignment = accepted.assignment;

  //Get the repo name from the payload
  const repoName = payload.repository.full_name;

  // Push-mode zero-runner path: when an assignment is push-mode AND has no
  // autograder, a push needs no GitHub Actions run to package the code — we
  // already have access to the repo. Instead of creating a
  // repository_check_run and dispatching grade.yml (which would consume runner
  // minutes for nothing), create the submission row directly and ingest the
  // repo's files via the shared ingestion core. The has_autograder=true path is
  // untouched and falls through to the existing check-run + triggerWorkflow
  // logic below.
  //
  // EVERY push takes this path, not just `#submit` ones. With no autograder
  // there are no runner minutes to conserve, so a submission is just a snapshot
  // of the repo for an instructor to hand-grade; requiring `#submit` would mean
  // students who never learned the convention appear to have submitted nothing.
  // Repeated pushes accumulate submissions, and the submissions BEFORE-INSERT
  // trigger keeps ordinal/is_active pointing at the newest.
  //
  // Exception: handout syncs push to the student's default branch too (an
  // auto-merged `sync-to-*` PR, or a fork fast-forward). Those are instructor
  // actions, so counting them would make the student's newest "submission" be
  // work they never did.
  //
  // Also guarded: `repo_mode` must still be a repo mode (assignmentHasRepository).
  // acceptStudentRepoPush has already dropped pushes to a leftover repository, so this is
  // false only when no assignment matched the row.
  const pushRepoModeHasRepo = assignmentHasRepository(pushAssignment);
  if (pushAssignment?.submission_mode === "push" && pushAssignment?.has_autograder === false && pushRepoModeHasRepo) {
    // Only the default branch is a submission. Without the `#submit` marker this path
    // has no other filter, so a push to a scratch branch or a `git push --tags` would
    // otherwise be recorded as the student's newest submission — from a tree that is not
    // what they are turning in. The Actions path below is unaffected: it still keys off
    // `#submit` in the commit message.
    const pushDefaultBranch = payload.repository.default_branch || "main";
    if (payload.ref !== `refs/heads/${pushDefaultBranch}`) {
      scope.setTag("skipped_reason", "not_default_branch");
      console.log(
        `Skipping push-direct submission for ${repoName}@${payload.after}: ref ${payload.ref} is not the ` +
          `default branch (refs/heads/${pushDefaultBranch})`
      );
      // Not a submission, but still activity worth recording. `repository_check_runs` is what
      // CommitHistoryDialog and the staff commit history read, and the Actions-backed path recorded
      // commits on EVERY branch — so returning here made a repo-only assignment lose branch work
      // from the history that an autograded one keeps. Only the submission is restricted to the
      // default branch; the history is not.
      for (const commit of payload.commits) {
        await recordCommitCheckRun(adminSupabase, studentRepo, push, commit, scope);
      }
      return;
    }
    // An unready row means one of two very different things, and treating them alike lost work.
    //
    // The `repositories` row is inserted BEFORE createRepo runs, so GitHub's initial branch push
    // for a freshly generated repo arrives while the row is still is_github_ready=false. That push
    // is the starter template, not student work, and recording it would make the handout the
    // student's active submission before they have written a line — so it is acknowledged and
    // dropped. It is identifiable: creation records the head it produced in synced_repo_sha.
    //
    // But readiness can also be false because the DATABASE write failed after GitHub was already
    // set up — the repository works and the student can push to it, and the reconciler will repair
    // the flag shortly. Acknowledging those pushes discarded them permanently, so none of the
    // student's work between the failure and the repair became a submission. Those are thrown, so
    // the delivery is redelivered until the flag is repaired.
    //
    // Redelivered by EVENTBRIDGE, not by GitHub. GitHub's webhook goes to an EventBridge rule that
    // invokes this function (hence the EVENTBRIDGE_SECRET check at the entry point, and the
    // `attempt=N` counter in the [DISPATCH] log line), so the retry policy that decides whether a
    // student push survives a provisioning window is an EventBridge rule/target configuration in
    // AWS — defined outside this repository and NOT verifiable from this code. Anyone reasoning
    // about worst-case loss here has to go read that configuration; no attempt count or maximum
    // event age is asserted anywhere in this file, because none has been confirmed.
    if (!studentRepo.is_github_ready) {
      const isProvisioningPush = !!studentRepo.synced_repo_sha && studentRepo.synced_repo_sha === payload.after;
      if (isProvisioningPush) {
        scope.setTag("skipped_reason", "repo_provisioning_push");
        console.log(
          `Skipping push-direct submission for ${repoName}@${payload.after}: this is the starter-template push from ` +
            `repository creation`
        );
        return;
      }
      // Which of the two cases above this is, reported accordingly. BOTH still throw: the
      // redelivery is the mechanism that makes provisioning converge, and removing it is how the
      // student-work case starts losing submissions again. How many redeliveries there are, and for
      // how long, is an EventBridge setting defined outside this repository — so the size of that
      // budget cannot be read off this code, and nothing here should be tuned as if it could.
      // What differs between the two cases is only the severity of the Sentry event, and that
      // difference is the whole point of this branch.
      //
      // The expected case is not rare or incidental — it happens once for EVERY repository, on the
      // first delivery, because the `repositories` row is inserted before createRepo runs and the
      // readiness write lands after it returns. Measured in Khoury production on 2026-09-07: CS 4530
      // released one assignment to 58 students, and the async create_repo queue drained the batch on
      // GitHub between 04:09 and 05:37 UTC. Over those 88 minutes this line threw 412 times across
      // all 58 repositories (~7 deliveries each, EventBridge backing off until the readiness write
      // landed), and every one of them arrived in Bugsink at `error` level in the same group. The
      // outcome was completely correct — 58/58 ready, no duplicates, empty DLQ, no lost work — which
      // is exactly the problem: a genuine readiness-write failure occurring in that window was
      // indistinguishable from the batch. Fall 2026's CS 2000 has ~585 students, i.e. several
      // thousand such events on day one.
      //
      // What the split rests on, and what it deliberately does NOT rest on.
      //
      // The tempting discriminator is the shape of the push: case 1 is by construction the creation
      // of the default branch, so it arrives with `created: true` and an all-zero `before`. That is
      // insufficient, and an earlier version of this branch was wrong for exactly that reason. When
      // GitHub created the repository and our readiness write then FAILED, the delivery being
      // rejected is still that same branch-creation push — and a redelivery carries a byte-identical
      // payload, so `created: true` never stops being true. Classifying on shape alone would report
      // case 2 as expected forever, permanently hiding the one failure this branch exists to surface.
      //
      // So the shape is only a necessary condition, and the decision rests on independent evidence
      // that creation is still running: `payload.repository.created_at`, GitHub's own per-repository
      // creation timestamp, which must fall inside a finalize window (see
      // PROVISIONING_IN_FLIGHT_WINDOW_MS). That is NOT the grace window on `repositories.created_at`
      // rejected earlier, and the difference matters: our row is stamped when the whole release is
      // enqueued, so its age grows with the size of the batch (~96 minutes for the last of 58, many
      // hours for 585). GitHub creates the repository INSIDE our createRepo call, so its timestamp
      // measures that one repository's own remaining finalize time — ~275s to the readiness write,
      // ~8.7 minutes worst case traced — and does not grow with the batch at all.
      //
      // Every uncertainty resolves to the visible side: no timestamp, an unusable one, or a push onto
      // existing history is `readiness_write_failed`. A mislabelled error event costs ten seconds of
      // triage; a hidden readiness failure costs student submissions.
      //
      // One inference remains, and it is only about the volume, not the logic: that those 412
      // deliveries carried `created: true` / an all-zero `before` follows from how a
      // template-generated repository's first push must look, but the payloads retrievable from that
      // incident are truncated, so it was never confirmed against them. The tags below are how to
      // confirm it — after the next release, an all-`provisioning_in_flight` batch is the expected
      // shape, and any `readiness_write_failed` in it deserves a look at `repo_not_ready_reason`.
      //
      // Do not "fix" this by deleting the throw or by loosening the sha comparison above: neither is
      // broken. The sha comparison is the fast path for a provisioning push whose readiness write
      // HAS landed; this branch is the same push arriving before it landed.
      const unready = classifyUnreadyRepoPush({
        created: payload.created,
        before: payload.before,
        repositoryCreatedAt: payload.repository?.created_at,
        repositoryPushedAt: payload.repository?.pushed_at
      });
      scope.setTag("push_direct_retry_reason", "repo_not_github_ready");
      scope.setTag("repo_not_ready_kind", unready.kind);
      scope.setTag("repo_not_ready_reason", unready.reason);
      if (unready.repoAgeMs !== undefined) {
        scope.setTag("repo_age_seconds", String(Math.round(unready.repoAgeMs / 1000)));
      }
      if (unready.kind === "provisioning_in_flight") {
        console.log(
          `Rejecting delivery for ${repoName}@${payload.after}: repository creation is still in flight (this is the ` +
            `branch-creation push, GitHub created the repository ${Math.round((unready.repoAgeMs ?? 0) / 1000)}s ago, ` +
            `and the readiness write has not landed yet). EventBridge will redeliver, and the retry will recognize ` +
            `it as the starter-template push once synced_repo_sha is recorded.`
        );
        throw new ExpectedRetryError(
          `${repoName} is not marked ready yet, ${payload.after} created the default branch and GitHub created the ` +
            `repository within the provisioning window, so creation is still in flight; rejecting this delivery so ` +
            `EventBridge retries it once provisioning is recorded`,
          {
            name: "RepoProvisioningInFlightError",
            level: "info",
            fingerprint: ["github-repo-webhook", "push-direct", "repo-provisioning-in-flight"]
          }
        );
      }
      // Reached when the push is not the branch creation, when GitHub created this repository too long
      // ago for creation to still be running, or when its creation timestamp is unusable. All three
      // mean the same thing operationally: readiness was never recorded for a repository that exists,
      // so the student's pushes are being rejected and only the reconciler (or a human) will fix it.
      throw new Error(
        `${repoName} is not marked ready yet, but ${payload.after} is not a push from provisioning either ` +
          `(${unready.reason}), so this is student work on a repository whose readiness was never recorded; ` +
          `rejecting this delivery so EventBridge retries it once provisioning is recorded`
      );
    }
    // Record the commit history BEFORE any of the reasons this delivery might not become a
    // submission.
    //
    // `repository_check_runs` is what CommitHistoryDialog and the staff commit history read, and
    // the Actions path records every commit of every push unconditionally. Recording it only after
    // a successful ingestion meant each of the skips below — a staff assistance push, a superseded
    // delivery, a handout sync — silently dropped its commits from the history, and the superseded
    // case drops them for good: the newer push's delivery carries only its OWN commits, so nothing
    // ever records the intermediate ones. Two quick pushes were enough to lose the first from the
    // history on exactly the assignments this feature exists for.
    //
    // Safe to run first: it only writes to our own database (no GitHub call, so it does not need
    // the circuit-breaker check below) and it is idempotent per (repository, sha), so a redelivery
    // re-runs it harmlessly.
    for (const commit of payload.commits) {
      await recordCommitCheckRun(adminSupabase, studentRepo, push, commit, scope);
    }
    // BEFORE the first GitHub call on this path. This branch clones the repo zipball and now
    // also resolves the repo head below, so it must respect the same circuit breaker as the
    // Actions path — otherwise repo-only pushes keep hammering GitHub during an outage and
    // deepen it. Checking after the head lookup was worse than useless once that lookup began
    // throwing: the throw asks GitHub to redeliver, so every retry re-issued the very repo and
    // ref requests the breaker exists to suppress.
    //
    // Throwing (rather than returning) is deliberate: GitHub redelivers, so the submission is
    // created once the circuit closes instead of being lost.
    const directCircuit = await checkCircuitBreakerOpen(
      adminSupabase,
      repoName.split("/")[0],
      "cloneRepository",
      scope
    );
    if (directCircuit.isOpen) {
      const openUntil = directCircuit.openUntil ? new Date(directCircuit.openUntil).toLocaleString() : "unknown";
      scope.setTag("skipped_reason", "circuit_breaker_open");
      throw new Error(
        `Circuit breaker open for org ${repoName.split("/")[0]}: cannot ingest push-direct submission for ` +
          `${repoName}@${payload.after}. Reason: ${directCircuit.reason || "Rate limit or error threshold exceeded"}. ` +
          `Open until: ${openUntil}`
      );
    }

    // Course staff pushing to a student's repository is not the student's submission. They hold
    // `maintain` on every student repo (syncRepoPermissions grants it), so a debugging or
    // assistance commit would otherwise replace the student's active gradebook entry — and after
    // the deadline it could spend the student's automatic late tokens on work they did not do.
    const pusherStanding = await resolvePusherStanding(
      adminSupabase,
      studentRepo,
      payload.pusher?.name ?? payload.sender?.login,
      scope
    );
    if (pusherStanding.isForeignStaff) {
      scope.setTag("skipped_reason", "staff_push_to_student_repo");
      console.log(
        `Skipping push-direct submission for ${repoName}@${payload.after}: pushed by course staff ` +
          `(${payload.pusher?.name ?? payload.sender?.login}) to a repository that is not theirs`
      );
      return;
    }

    // A delivery for a superseded commit must not be recorded at all. The submissions trigger
    // assigns ordinals by INSERT order and demotes whatever was active, so an older push that
    // arrives late (a retry after a transient ingestion failure, say) would otherwise roll the
    // student's active submission and grading review back to stale code. Same test as the
    // handout pointer: if the pushed sha is not the repo's current default-branch head, a
    // newer push exists.
    let studentRepoHeadSha: string | undefined;
    try {
      studentRepoHeadSha = await getDefaultBranchHeadSha(repoName, scope);
    } catch (headErr) {
      // Throw, do NOT assume the push is current. Falling through treated an out-of-order
      // delivery as the newest one, so it was inserted active and the insert trigger demoted
      // the genuinely newer submission — the student's active submission and its grading
      // review rolled back to stale code, permanently, because the delivery was then
      // acknowledged and nothing revisits the ordering.
      //
      // The earlier comment here reasoned that a submission should never be blocked on this
      // lookup. That was the wrong comparison: a throw means GitHub redelivers and the push is
      // recorded a moment later, whereas guessing wrong silently corrupts which commit is
      // being graded. (`undefined` — the E2E GitHub stub — still falls through as current;
      // only a real failure propagates.)
      scope.setTag("student_repo_head_lookup_failed", "true");
      Sentry.captureException(headErr, scope);
      throw new Error(
        `Could not resolve the current head of ${repoName} to check whether ${payload.after} is superseded ` +
          `(${headErr instanceof Error ? headErr.message : String(headErr)}); rejecting this delivery so GitHub ` +
          `retries it`
      );
    }
    // A delivery whose commit is no longer the repo head is stale: a newer push exists and
    // carries its own delivery. SKIP it rather than storing it.
    //
    // Recording it inactive was the previous approach and it does not work, because the
    // submissions trigger assigns ordinals by INSERT order: the stale row lands with the
    // HIGHEST ordinal despite being the oldest commit, so every later scan that means "the
    // newest submission" — restoring an active row after a rejection, most of all — reads it
    // as newest and either trips submissions_one_active_* or promotes stale code. No column
    // records "superseded", so each of those scans would need to re-derive it. Not creating
    // the row removes the question, and takes the demote/re-promote/unwind machinery with it.
    //
    // What is lost is a history entry for an intermediate commit, which is what the behavior
    // before this feature did anyway (only `#submit` pushes were recorded). The student's
    // newest push still becomes their submission, via its own delivery.
    if (!!studentRepoHeadSha && !!payload.after && studentRepoHeadSha !== payload.after) {
      scope.setTag("skipped_reason", "push_superseded");
      console.log(
        `Skipping push-direct submission for ${repoName}@${payload.after}: the repository head is now ` +
          `${studentRepoHeadSha}, so a newer push supersedes this delivery`
      );
      return;
    }
    if (
      isHandoutSyncPush({
        headCommitMessage: payload.head_commit.message,
        senderType: payload.sender?.type,
        afterSha: payload.after,
        latestTemplateSha: pushAssignment.latest_template_sha,
        desiredHandoutSha: studentRepo.desired_handout_sha,
        syncedHandoutSha: studentRepo.synced_handout_sha,
        syncedRepoSha: studentRepo.synced_repo_sha
      })
    ) {
      scope.setTag("skipped_reason", "handout_sync_push");
      console.log(
        `Skipping push-direct submission for ${repoName}@${payload.after}: handout-sync push, not student work`
      );
      return;
    }
    scope.setTag("push_direct_submission", "true");
    await createPushDirectSubmission(adminSupabase, gitHubPushDirectPush(payload, scope), studentRepo, {
      allowNotGradedSubmissions: pushAssignment.allow_not_graded_submissions ?? false,
      permitEmptySubmissions: pushAssignment.permit_empty_submissions ?? false,
      lateTokenPolicy: {
        maxLateTokens: pushAssignment.max_late_tokens ?? 0,
        requireTokensBeforeDueDate: pushAssignment.require_tokens_before_due_date ?? false,
        classLateTokensPerStudent: pushAssignment.classes?.late_tokens_per_student ?? 0
      },
      // Staff pushing to their OWN repository — the Instructor Test Assignment flow — keeps the
      // bypasses the Actions path gives them. Losing that meant a no-autograder test assignment
      // could reject an instructor's post-deadline or empty test push, and could even spend their
      // late tokens on it.
      actorIsStaffOwner: pusherStanding.isOwnerStaff,
      scope
    });
    // The commit history was recorded above, before the skips. No workflow is dispatched: that
    // stays below, behind `#submit`, on the has_autograder=true path.
    return;
  }

  // Extract org for circuit breaker check
  const org = repoName.split("/")[0];

  for (const commit of payload.commits) {
    maybeCrash("push.student.for_each_commit.before_lookup");

    // Check circuit breaker before making GitHub API calls - fail fast if rate limited
    // Check both org-level and triggerWorkflow method-specific circuit breakers
    const circuitStatus = await checkCircuitBreakerOpen(adminSupabase, org, "triggerWorkflow", scope);
    if (circuitStatus.isOpen) {
      const openUntil = circuitStatus.openUntil ? new Date(circuitStatus.openUntil).toLocaleString() : "unknown";
      const scopeInfo = circuitStatus.circuitScope === "org_method" ? ` (method: triggerWorkflow)` : "";
      throw new Error(
        `Circuit breaker open for org ${org}${scopeInfo}: GitHub API operations temporarily unavailable. ` +
          `Reason: ${circuitStatus.reason || "Rate limit or error threshold exceeded"}. ` +
          `Open until: ${openUntil}`
      );
    }

    await recordCommitCheckRun(adminSupabase, studentRepo, push, commit, scope);

    // If the workflow file was deleted in this commit, skip triggering - the workflow would fail anyway
    const removedInCommit = commit.removed.includes(GRADER_WORKFLOW_PATH);
    if (removedInCommit) {
      return;
    }
  }
  if (payload.head_commit.message.includes("#submit")) {
    // Fall back to direct ingestion when this repository does not actually have the workflow yet.
    //
    // Enabling the autograder flips the flag immediately, but the sync only ENQUEUES
    // sync_repo_to_handout jobs — installing grade.yml can take minutes, or wait on a sync PR
    // someone has to merge. In that window this branch dispatched a workflow the repository does
    // not contain, so the student's `#submit` push produced nothing at all: no Actions run to fail
    // and no submission either, because the flag had already switched the push off the direct
    // path. Checking the repository rather than the flag makes the submission path follow what is
    // actually installed.
    //
    // One API read, on `#submit` pushes only. A failure to determine it falls through to the
    // dispatch below, which is the pre-existing behavior.
    if (pushAssignment?.has_autograder !== false && pushRepoModeHasRepo && studentRepo.is_github_ready) {
      let workflowInstalled: boolean | undefined;
      try {
        workflowInstalled = await repoHasFileAtRef(repoName, GRADER_WORKFLOW_PATH, payload.after, scope);
      } catch (checkErr) {
        scope?.setTag("submit_workflow_presence_check_failed", "true");
        Sentry.captureException(checkErr, scope);
      }
      if (workflowInstalled === false) {
        scope?.setTag("push_direct_fallback", "workflow_not_installed_yet");
        console.log(
          `${repoName} has no ${GRADER_WORKFLOW_PATH} at ${payload.after} yet, so ingesting this #submit push ` +
            `directly instead of dispatching a workflow that is not there`
        );
        // Same actor rules as the normal direct path: this fallback reaches the identical
        // ingestion, so leaving them out meant a staff assistance push became the student's active
        // submission here while being skipped there, and a staff member's own test push had the
        // student gates applied. The rule belongs to ingestion, not to the branch that reaches it.
        const fallbackStanding = await resolvePusherStanding(
          adminSupabase,
          studentRepo,
          payload.pusher?.name ?? payload.sender?.login,
          scope
        );
        if (fallbackStanding.isForeignStaff) {
          scope.setTag("skipped_reason", "staff_push_to_student_repo");
          console.log(
            `Skipping the direct-ingestion fallback for ${repoName}@${payload.after}: pushed by course staff to a ` +
              `repository that is not theirs`
          );
          return;
        }
        await createPushDirectSubmission(adminSupabase, gitHubPushDirectPush(payload, scope), studentRepo, {
          allowNotGradedSubmissions: pushAssignment?.allow_not_graded_submissions ?? false,
          permitEmptySubmissions: pushAssignment?.permit_empty_submissions ?? false,
          lateTokenPolicy: {
            maxLateTokens: pushAssignment?.max_late_tokens ?? 0,
            requireTokensBeforeDueDate: pushAssignment?.require_tokens_before_due_date ?? false,
            classLateTokensPerStudent: pushAssignment?.classes?.late_tokens_per_student ?? 0
          },
          actorIsStaffOwner: fallbackStanding.isOwnerStaff,
          scope
        });
        return;
      }
    }
    console.log(`Ref: ${payload.ref}`);
    //Create a submission for this commit
    // Find the head commit check run row to gate workflow triggering idempotently
    const { data: headRow, error: headRowErr } = await adminSupabase
      .from("repository_check_runs")
      .select("id, status")
      .eq("repository_id", studentRepo.id)
      .eq("sha", payload.head_commit.id)
      .maybeSingle();
    if (headRowErr) {
      console.error(headRowErr);
      scope.setTag("error_source", "repository_check_run_head_lookup_failed");
      scope.setTag("error_context", "Error getting head commit repository_check_run");
      Sentry.captureException(headRowErr, scope);
      throw headRowErr;
    }
    if (!headRow) {
      scope.setTag("error_source", "no_head_commit_repository_check_run");
      Sentry.captureException(new Error("No head commit repository_check_run found"), scope);
      return;
    }
    const currentStatus = (headRow?.status || {}) as ExtendedCheckRunStatus;
    if (!currentStatus.workflow_triggered_at) {
      maybeCrash("push.student.before_trigger_workflow");
      try {
        await getGitProvider().startGrading(repoName, payload.head_commit.id);
      } catch (triggerErr) {
        console.error("Error triggering workflow:", triggerErr);
        const rt = detectRateLimitType(triggerErr);
        if (rt.type) {
          Sentry.withScope((errorScope) => {
            errorScope.setFingerprint(["github-rate-limit", rt.type!, org, "triggerWorkflow"]);
            errorScope.setTag("rate_limit_type", rt.type);
            errorScope.setTag("github_api_method", "triggerWorkflow");
            if (rt.installationId) {
              errorScope.setContext("rate_limit_installation", {
                installation_id: rt.installationId,
                note: "Installation ID excluded from fingerprint to prevent notification storms"
              });
            }
            Sentry.captureException(triggerErr, errorScope);
          });
          console.warn(`GitHub rate limit (${rt.type}) hit during triggerWorkflow for ${repoName}`);
        } else {
          scope.setTag("error_source", "trigger_workflow_failed");
          scope.setTag("error_context", "Failed to trigger grade workflow");
          Sentry.captureException(triggerErr, scope);
        }
        throw triggerErr;
      }
      const { error: statusUpdateErr } = await adminSupabase
        .from("repository_check_runs")
        .update({
          status: {
            ...(currentStatus as ExtendedCheckRunStatus),
            workflow_triggered_at: new Date().toISOString()
          } as unknown as Json
        })
        .eq("id", headRow.id);
      if (statusUpdateErr) {
        console.error(statusUpdateErr);
        scope.setTag("error_source", "repository_check_run_status_update_failed");
        scope.setTag("error_context", "Failed to set workflow_triggered_at");
        Sentry.captureException(statusUpdateErr, scope);
        throw statusUpdateErr;
      }
    }
  }
}
const PAWTOGRADER_YML_PATH = "pawtograder.yml";
async function handlePushToGraderSolution(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  autograders: Database["public"]["Tables"]["autograder"]["Row"][],
  scope: Sentry.Scope
) {
  tagScopeWithGenericPayload(scope, "push_to_grader_solution", payload);
  scope.setTag("autograders_count", autograders.length.toString());
  // The repo's DEFAULT branch, not a hardcoded "main" - same fix as the student-repo
  // and template-repo handlers. A grader/solution repo on `master` otherwise had every
  // push ignored, so pawtograder.yml and latest_autograder_sha were never reconciled.
  const graderDefaultBranch = payload.repository?.default_branch || "main";
  scope.setTag("repo_default_branch", graderDefaultBranch);
  scope.setTag("is_default_branch", (payload.ref === `refs/heads/${graderDefaultBranch}`).toString());

  const ref = payload.ref;
  const repoName = payload.repository.full_name;
  /*
  If we pushed to the default branch, update the autograder config and latest_autograder_sha
  */
  if (ref === `refs/heads/${graderDefaultBranch}`) {
    if (!payload.head_commit) {
      console.error("No head commit found in payload");
      scope.setTag("error_source", "no_head_commit");
      scope.setTag("error_context", "No head commit found in payload");
      Sentry.captureException(new Error("No head commit found in payload"), scope);
      return;
    }
    const ymlTouched = pushTouchedFile(payload, PAWTOGRADER_YML_PATH);
    scope?.setTag("yml_touched_in_push", ymlTouched.toString());
    // Always reconcile pawtograder.yml on a push to main, even if no commit in this
    // push touched the file. This makes the autograder config self-healing: if a
    // previous webhook missed an update (e.g. the file was changed in a non-head
    // commit of a multi-commit push, or the >20-commit truncation hid it), an
    // instructor can force a re-sync by pushing any commit (e.g. touching README).
    let configReconcileOk = true;
    try {
      console.log("Reconciling pawtograder.yml on push to main", { ymlTouched });
      const file = await getFileFromRepo(repoName, PAWTOGRADER_YML_PATH);
      const parsedYml = parse(file.content) as PawtograderConfig;
      if (!parsedYml.gradedParts) {
        parsedYml.gradedParts = [];
      }
      const totalAutograderPoints = parsedYml.gradedParts.reduce(
        (acc, part) =>
          acc +
          part.gradedUnits.reduce(
            (unitAcc, unit) =>
              unitAcc +
              (isMutationTestUnit(unit)
                ? (unit.linearScoring?.points ?? unit.breakPoints?.[0]?.pointsToAward ?? 0)
                : isRegularTestUnit(unit)
                  ? unit.points
                  : 0),
            0
          ),
        0
      );
      scope?.setTag("total_autograder_points", totalAutograderPoints.toString());
      for (const autograder of autograders) {
        const { error: updateError } = await adminSupabase
          .from("assignments")
          .update({
            autograder_points: totalAutograderPoints
          })
          .eq("id", autograder.id);
        if (updateError) {
          // Clears the flag too. The pointer guard below is only as good as the set of failures
          // that reach it, and a write that returns a PostgREST error (statement timeout, pool
          // exhaustion, an RLS hiccup) leaves the config exactly as un-applied as a parse failure
          // does. Logging it and letting the SHA advance is the precise thing the guard exists to
          // prevent -- "this config is live" over a config that never landed.
          configReconcileOk = false;
          Sentry.captureException(updateError, scope);
          console.error(updateError);
        }
      }
      await Promise.all(
        autograders.map(async (autograder) => {
          const { error } = await adminSupabase
            .from("autograder")
            .update({
              config: parsedYml as unknown as Json
            })
            .eq("id", autograder.id)
            .single();
          if (error) {
            configReconcileOk = false;
            Sentry.captureException(error, scope);
            console.error(error);
          }
        })
      );
      scope?.setTag("updated_autograders_count", autograders.length.toString());
      // The config that just changed is what names submissionFiles, so the handout hashes were
      // computed with the OLD globs. Ingestion would then filter with the new globs and compare
      // against hashes built from the old ones, which is a comparison between two different file
      // sets — an untouched starter repo reads as real work, and on a repo-only assignment that
      // makes it the student's active submission. This is the same seeding the create and
      // configure-webhook flows do; an instructor editing pawtograder.yml through RepoFileEditor
      // arrives here instead of either of those.
      for (const autograder of autograders) {
        const { data: handoutTarget, error: handoutTargetError } = await adminSupabase
          .from("assignments")
          .select("template_repo, latest_template_sha, class_id")
          .eq("git_provider", "github")
          .eq("id", autograder.id)
          .maybeSingle();
        if (handoutTargetError) {
          // A failed read is NOT "this assignment has no handout". Falling through to the
          // `continue` below would skip the reseed while leaving configReconcileOk true, so the
          // pointer would advance over hashes the config write above has already invalidated --
          // the exact state the seedResult guard further down refuses. Same transient causes
          // (statement timeout, pool exhaustion) as the update errors above.
          configReconcileOk = false;
          scope?.setTag("handout_target_lookup_failed", "true");
          Sentry.captureException(handoutTargetError, scope);
          console.error(
            `Could not read the handout target for assignment ${autograder.id} after a grader-config push`,
            handoutTargetError
          );
          continue;
        }
        // An assignment that genuinely has no template_repo is a steady state, not a failure.
        if (!handoutTarget?.template_repo) continue;
        const seedResult = await seedHandoutFileHashes({
          adminSupabase,
          assignmentId: autograder.id,
          classId: handoutTarget.class_id,
          templateRepo: handoutTarget.template_repo,
          commitSha: handoutTarget.latest_template_sha,
          scope
        });
        if (isExpectedHandoutSeedSkip(seedResult)) {
          // Nothing to seed is not a failure. no_template_repo / no_commit_sha /
          // no_submission_files are steady states of a healthy assignment -- there is no
          // comparable file set, so no hash rows is the right answer, and there is nothing stale
          // for the pointer guard to protect. Holding the pointer for these meant every later
          // grader-config push on such an assignment pinned latest_autograder_sha and raised an
          // incident, for a config that had in fact been saved correctly.
          console.log(
            `No handout file hashes to reseed for assignment ${autograder.id} after a grader-config push: ${describeHandoutSeedResult(seedResult)}`
          );
        } else if (!seedResult.seeded) {
          // A real failure: seedHandoutFileHashes swallows its own errors and returns
          // { seeded: false } with the message as the reason, so this never reached the catch
          // below — and the config write that INVALIDATED these hashes had already succeeded.
          // Advancing latest_autograder_sha there announces "this config is live" over hashes
          // still built from the OLD submissionFiles globs, which is the
          // comparison-between-two-file-sets the comment above describes.
          configReconcileOk = false;
          scope?.setTag("handout_file_hash_reseed_failed", "true");
          console.error(
            `Not reseeding handout file hashes for assignment ${autograder.id} after a grader-config push: ${describeHandoutSeedResult(seedResult)}`
          );
        }
      }
    } catch (err) {
      // Still don't fail the whole webhook if pawtograder.yml is missing/malformed — GitHub would
      // redeliver the entire push forever. But do record that the reconcile failed, so the SHA
      // pointer below is not advanced past a config that was never applied.
      configReconcileOk = false;
      scope?.setTag("error_source", "pawtograder_yml_reconcile_failed");
      scope?.setTag("yml_touched_in_push", ymlTouched.toString());
      console.error("Failed to reconcile pawtograder.yml", err);
      Sentry.captureException(err, scope);
    }
    if (!configReconcileOk) {
      // latest_autograder_sha is what an instructor reads as "this config is live". Advancing it
      // while `autograder.config` still holds the OLD yml is worse than not advancing: it reports
      // that a fix has taken effect when grading is still running the previous configuration.
      // Holding the pointer leaves the honest answer — the last good config is what is in force.
      scope?.setTag("autograder_sha_pointer", "held");
      console.error(
        `Not advancing latest_autograder_sha for ${repoName}: pawtograder.yml reconcile failed. ` +
          `The autograder still runs the last good config. Fix pawtograder.yml and push again.`
      );
      Sentry.withScope((s) => {
        s.setFingerprint(["handout-pointer-held", "config"]);
        Sentry.captureMessage(`Held latest_autograder_sha for ${repoName}: pawtograder.yml reconcile failed`, s);
      });
    } else {
      // `payload.commits` is ordered oldest -> newest, so commits[0] is the FIRST
      // (oldest) commit in the push, not the head. Use payload.after / head_commit
      // so multi-commit pushes don't leave latest_autograder_sha stuck on an old SHA.
      const newAutograderSha =
        payload.after || payload.head_commit?.id || payload.commits.at(-1)?.id || payload.commits[0]?.id;
      for (const autograder of autograders) {
        const { error } = await adminSupabase
          .from("autograder")
          .update({
            latest_autograder_sha: newAutograderSha
          })
          .eq("id", autograder.id)
          .single();
        if (error) {
          Sentry.captureException(error, scope);
          console.error(error);
        }
      }
    }
  }
  /*
  Regardless of where we pushed, update the commit list
  */
  for (const autograder of autograders) {
    const { class_id } = autograder;
    if (class_id === null || class_id === undefined) {
      console.error("Autograder has no class_id");
      scope.setTag("error_source", "autograder_no_class_id");
      scope.setTag("error_context", "Autograder has no class_id");
      Sentry.captureException(new Error("Autograder has no class_id"), scope);
      continue;
    }
    const { error } = await adminSupabase.from("autograder_commits").upsert(
      payload.commits.map((commit: GitHubCommit) => ({
        autograder_id: autograder.id,
        message: commit.message,
        sha: commit.id,
        author: commit.author.name,
        class_id: class_id,
        ref
      })),
      { onConflict: "autograder_id,sha" }
    );
    if (error) {
      scope.setTag("error_source", "autograder_commits_insert_failed");
      scope.setTag("error_context", "Failed to store autograder commits");
      Sentry.captureException(error, scope);
      console.error(error);
      throw error;
    }
  }
}

async function handlePushToTemplateRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  assignments: Database["public"]["Tables"]["assignments"]["Row"][],
  scope: Sentry.Scope
) {
  tagScopeWithGenericPayload(scope, "push_to_template_repo", payload);
  scope?.setTag("assignments_count", assignments.length.toString());
  // Only process the repo's DEFAULT branch, which is not necessarily "main". A
  // handout on `master` previously returned here for every push, so it never
  // recorded latest_template_sha or assignment_handout_file_hashes — which in turn
  // left the push-direct empty check with no handout hash to compare against, so an
  // untouched starter push read as non-empty and was accepted. Mirrors the same fix
  // on the student-repo path.
  const templateDefaultBranch = payload.repository?.default_branch || "main";
  if (payload.ref !== `refs/heads/${templateDefaultBranch}`) {
    scope?.setTag("is_default_branch", "false");
    scope?.setTag("repo_default_branch", templateDefaultBranch);
    return;
  }
  scope?.setTag("is_default_branch", "true");
  if (!payload.head_commit) {
    console.error("No head commit found in payload");
    scope.setTag("error_source", "no_head_commit");
    scope.setTag("error_context", "No head commit found in payload");
    Sentry.captureException(new Error("No head commit found in payload"), scope);
    return;
  }
  // Always reconcile the grade.yml workflow hash on a push to main, even if no
  // commit in this push touched the file. This makes workflow_sha self-healing:
  // an instructor can fix a stale hash (e.g. caused by a multi-commit push where
  // grade.yml was changed in a non-head commit, or by GitHub's 20-commit truncation)
  // by pushing any commit (e.g. touching README) to the template repo.
  const workflowTouched = pushTouchedFile(payload, GRADER_WORKFLOW_PATH);
  scope?.setTag("workflow_touched_in_push", workflowTouched.toString());
  // Assignments with no autograder have no grade.yml in their handout (it is
  // stripped at creation), and nothing reads their workflow_sha. Reconciling
  // would 404 on every push to the handout — including the very commit that
  // removed grade.yml — so skip them. Several assignments can share a
  // template_repo, so filter rather than bail on the first one.
  const autogradedAssignments = assignments.filter((a) => a.has_autograder !== false);
  scope?.setTag("autograded_assignments_count", autogradedAssignments.length.toString());
  // ONE head resolution, used for both the workflow read below and the pointer decision
  // further down. Reading the workflow from the unqualified head and resolving the head
  // separately let two interleaved deliveries split the pair: B's handler could pin B and
  // store B's hash while A's handler was between its own read and its lookup, after which A
  // overwrote workflow_sha with A's content, saw B as current, and correctly declined to move
  // the pointer — leaving latest_template_sha on B with workflow_sha from A. Repos synced to B
  // then had every Actions submission rejected for a hash mismatch. Resolving once means the
  // handler that writes the hash is the same one that decides whether its revision is current.
  let currentHeadSha: string | undefined;
  if (assignments[0].template_repo) {
    try {
      currentHeadSha = await getDefaultBranchHeadSha(assignments[0].template_repo, scope);
    } catch (headErr) {
      // Never block history on this check: fall through and trust the payload, which is
      // exactly the behavior that existed before it.
      scope?.setTag("template_head_lookup_failed", "true");
      Sentry.captureException(headErr, scope);
    }
  }
  // Defaults true so the branches that never attempt a reconcile (no template repo, or no
  // autograded assignments using it) keep advancing the pointer exactly as before.
  let gradeYmlReconcileOk = true;
  if (!assignments[0].template_repo) {
    Sentry.captureMessage("No matching assignment found", scope);
  } else if (autogradedAssignments.length === 0) {
    scope?.setTag("skipped_reason", "no_autograder_assignments_for_template_repo");
    console.log(
      `Skipping grade.yml hash reconcile for ${assignments[0].template_repo}: no autograded assignments use it`
    );
  } else {
    try {
      // Pinned to the head resolved above, so the hash written here describes the same
      // revision the pointer decision uses.
      const file = (await getFileFromRepo(
        assignments[0].template_repo!,
        GRADER_WORKFLOW_PATH,
        scope,
        currentHeadSha
      )) as {
        content: string;
      };
      if (!file.content) {
        // Holds the pointer, same as a throw would. An empty body means workflow_sha was never
        // recomputed for this revision, so advancing latest_template_sha would report the handout
        // as in sync while every student Actions run built from it fails the workflow-hash check.
        // Only the catch below set the flag, and this branch does not throw.
        gradeYmlReconcileOk = false;
        Sentry.captureMessage(`File ${GRADER_WORKFLOW_PATH} not found for ${assignments[0].template_repo}`, scope);
      } else {
        // Remove all whitespace (spaces, tabs, newlines, etc.) before hashing
        const contentWithoutWhitespace = file.content.replace(/\s+/g, "");
        const hash = createHash("sha256");
        hash.update(contentWithoutWhitespace);
        const hashStr = hash.digest("hex");
        scope?.setTag("new_autograder_workflow_hash", hashStr);
        for (const assignment of autogradedAssignments) {
          const { error } = await adminSupabase
            .from("autograder")
            .update({
              workflow_sha: hashStr
            })
            .eq("id", assignment.id);
          if (error) {
            scope.setTag("error_source", "autograder_workflow_hash_update_failed");
            scope.setTag("error_context", "Failed to update autograder workflow hash");
            Sentry.captureException(error, scope);
            throw error;
          }
        }
      }
    } catch (err) {
      // Still don't fail the whole webhook if grade.yml is missing — GitHub would redeliver
      // forever. But record the failure so the pointer below is not advanced past a revision whose
      // workflow hash was never reconciled.
      gradeYmlReconcileOk = false;
      scope?.setTag("error_source", "grade_yml_reconcile_failed");
      scope?.setTag("workflow_touched_in_push", workflowTouched.toString());
      console.error("Failed to reconcile grade.yml workflow hash", err);
      Sentry.captureException(err, scope);
    }
  }
  // Only advertise a revision that IS the repo's current default-branch head.
  //
  // Push deliveries are asynchronous and can arrive out of order, and any operation
  // taking two commits produces a pair that can race — the autograder disable rollback,
  // for instance, renames the workflow back while the earlier removal commit is still in
  // flight. Processing that stale delivery afterwards overwrote latest_template_sha with
  // a revision the repo had already moved past, so a later student sync applied the wrong
  // handout state: stripping grade.yml from an enabled assignment, or reinstating it on a
  // disabled one. Earlier fixes corrected the pointer after the fact, one operation at a
  // time; checking the head here rules out the whole class.
  const pushedSha = payload.after || payload.head_commit?.id || payload.commits?.[0]?.id;
  // Skip only the POINTER move, not the rest of this handler. Returning here also
  // skipped the assignment_handout_commits and assignment_handout_file_hashes loops
  // below, so an out-of-order delivery vanished from handout history AND never had its
  // file hashes recorded — which lets an unchanged submission based on that revision
  // evade empty-submission detection. History and hashes are per-revision and
  // order-independent; only the "current head" pointer is not.
  const isStaleDelivery = !!currentHeadSha && !!pushedSha && currentHeadSha !== pushedSha;
  // isStaleDelivery guards against out-of-order deliveries; it says nothing about whether the
  // reconcile succeeded. A failed grade.yml reconcile must hold the pointer for the same reason:
  // latest_template_sha is what the repositories page renders as "in sync", so advancing it past a
  // revision we could not reconcile tells students to pull a handout state that was never applied.
  const holdPointer = isStaleDelivery || !gradeYmlReconcileOk;
  if (!gradeYmlReconcileOk) {
    scope?.setTag("template_sha_pointer", "held");
    console.error(
      `Not advancing latest_template_sha for ${assignments[0].template_repo}: grade.yml reconcile failed. ` +
        `Still recording this revision's history and hashes.`
    );
    Sentry.withScope((s) => {
      s.setFingerprint(["handout-pointer-held", "grade-yml"]);
      Sentry.captureMessage(
        `Held latest_template_sha for ${assignments[0].template_repo}: grade.yml reconcile failed`,
        s
      );
    });
  }
  if (isStaleDelivery) {
    scope?.setTag("stale_template_push_delivery", "true");
    console.log(
      `Not moving latest_template_sha for ${assignments[0].template_repo}: pushed ${pushedSha} is not the current ` +
        `default-branch head ${currentHeadSha} (out-of-order delivery). Still recording its history and hashes.`
    );
  }
  for (const assignment of assignments) {
    // Guarded around the pointer write ONLY — the assignment_handout_commits upsert
    // further down this same loop must still run for a stale delivery.
    const { error: assignmentUpdateError } = holdPointer
      ? { error: null }
      : await adminSupabase
          .from("assignments")
          .update({
            latest_template_sha: pushedSha
          })
          .eq("id", assignment.id);
    if (assignmentUpdateError) {
      scope.setTag("error_source", "assignment_template_sha_update_failed");
      scope.setTag("error_context", "Failed to update assignment");
      Sentry.captureException(assignmentUpdateError, scope);
      throw assignmentUpdateError;
    }
    //Store the commit for the template repo. A constraint violation here can never be fixed by
    //redelivering the same push, so failing the webhook on one just loops forever (and blocks the
    //handout file hashes below, which empty-submission detection depends on). Transient failures
    //still throw so GitHub retries and the history isn't silently lost.
    const { error } = await adminSupabase.from("assignment_handout_commits").upsert(
      payload.commits.map((commit: GitHubCommit) => ({
        assignment_id: assignment.id,
        message: commit.message,
        sha: commit.id,
        author: commit.author.name,
        class_id: assignment.class_id
      })),
      { onConflict: "assignment_id,sha" }
    );
    if (error) {
      scope.setTag("error_source", "assignment_handout_commits_insert_failed");
      scope.setTag("error_context", "Failed to store assignment handout commit");
      console.error(`Failed to store handout commits for assignment ${assignment.id}`, error);
      Sentry.captureException(error, scope);
      // SQLSTATE class 23 = integrity constraint violation (duplicate key, foreign key, not
      // null): the same payload will fail identically on every redelivery, so record it and move
      // on. Anything else may be transient — rethrow and let GitHub redeliver.
      if (!error.code?.startsWith("23")) {
        throw error;
      }
    }
  }

  // Store handout (template repo) file hashes for empty-submission detection.
  // This is keyed by the commit SHA of the template repo (handout).
  // We compute hashes only for the expected submission files (from Pawtograder config).
  const commitSha = payload.after || payload.head_commit?.id || payload.commits?.[0]?.id;
  if (!commitSha) {
    scope.setTag("handout_hashes_skipped", "no_commit_sha");
    return;
  }

  // Cache commit/tree and blob fetches within this webhook to avoid duplicate GitHub API calls
  // when multiple assignments share the same template repo (common for multi-section courses).
  const handoutHashCaches: HandoutHashCaches = {
    commitTree: new Map(),
    blobHash: new Map()
  };

  for (const assignment of assignments) {
    // Same helper the handout-creation and grader-config flows use, so all three record
    // identical rows. It reports rather than throwing, and the caches make repeated calls
    // across assignments sharing a template repo cost one GitHub round trip.
    await seedHandoutFileHashes({
      adminSupabase,
      assignmentId: assignment.id,
      classId: assignment.class_id,
      templateRepo: assignment.template_repo,
      commitSha,
      scope,
      caches: handoutHashCaches
    });
  }
}

type KnownEventPayload =
  | PushEvent
  | CheckRunEvent
  | MembershipEvent
  | OrganizationEvent
  | WorkflowRunEvent
  | PullRequestEvent
  | DeploymentStatusEvent;
function tagScopeWithGenericPayload(scope: Sentry.Scope, name: string, payload: KnownEventPayload) {
  scope.setTag("webhook_handler", name);
  if ("action" in payload) {
    scope.setTag("action", (payload as { action?: string }).action || "");
  }
  // repository may not be present on some events (e.g., organization)
  if ("repository" in payload) {
    scope.setTag("repository", (payload as { repository?: { full_name?: string } }).repository?.full_name || "");
  }
  if ("ref" in payload) {
    scope.setTag("ref", (payload as { ref?: string }).ref || "");
  }
  if ("check_run" in payload) {
    const id = (payload as { check_run?: { id?: number } }).check_run?.id;
    scope.setTag("check_run_id", id ? String(id) : "");
  }
  if ("organization" in payload) {
    scope.setTag("organization", (payload as { organization?: { login?: string } }).organization?.login || "");
  }
}
eventHandler.on("push", async ({ name, payload }: { name: "push"; payload: PushEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, name, payload);
  try {
    if (name === "push") {
      const repoName = payload.repository.full_name;
      const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
        { auth: REQUEST_SCOPED_AUTH_OPTIONS }
      );
      console.log(`[PUSH] repo=${repoName}`);
      //Is it a student repo?
      const studentRepo = await findStudentRepository(adminSupabase, "github", repoName, scope);
      if (studentRepo) {
        if (!isDefaultBranchPush(fromGitHubPush(payload), scope)) {
          return;
        }
        scope.setTag("student_repo", studentRepo.id.toString());
        maybeCrash("push.before_student_repo");
        await handlePushToStudentRepo(adminSupabase, payload, studentRepo, scope);
        return;
      }
      scope.setTag("repo_type", "grader_solution");
      const { data: graderSolution, error: graderSolutionError } = await adminSupabase
        .from("autograder")
        // Every provider: a Forgejo assignment's grader repo stays on GitHub (D6). The handler's handout
        // reseed reads only GitHub handouts.
        .select("*")
        .eq("grader_repo", repoName);
      if (graderSolutionError) {
        console.error(graderSolutionError);
        scope.setTag("error_source", "grader_solution_lookup_failed");
        scope.setTag("error_context", "Error getting grader solution");
        Sentry.captureException(graderSolutionError, scope);
        throw graderSolutionError;
      }
      if (graderSolution.length > 0) {
        scope.setTag("grader_solution", graderSolution[0].id.toString());
        maybeCrash("push.before_grader_solution");
        await handlePushToGraderSolution(adminSupabase, payload, graderSolution, scope);
        return;
      }
      const { data: templateRepo, error: templateRepoError } = await adminSupabase
        .from("assignments")
        .select("*")
        .eq("git_provider", "github")
        .eq("template_repo", repoName);
      if (templateRepoError) {
        console.error(templateRepoError);
        scope.setTag("error_source", "template_repo_lookup_failed");
        scope.setTag("error_context", "Error getting template repo");
        Sentry.captureException(templateRepoError, scope);
        throw templateRepoError;
      }
      if (templateRepo.length > 0) {
        maybeCrash("push.before_template_repo");
        await handlePushToTemplateRepo(adminSupabase, payload, templateRepo, scope);
        return;
      }
    }
  } catch (err) {
    captureWebhookException(err, scope);
    throw err;
  }
});
eventHandler.on("check_run", async ({ payload }: { payload: CheckRunEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "check_run", payload);
  try {
    if (payload.action === "created") {
      scope?.setTag("check_run_created", "true");
    } else if (payload.action === "requested_action") {
      if (payload.requested_action?.identifier === "submit") {
        maybeCrash("check_run.before_db_lookup");
        const adminSupabase = createClient<Database>(
          Deno.env.get("SUPABASE_URL") || "",
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
          { auth: REQUEST_SCOPED_AUTH_OPTIONS }
        );
        const checkRun = await adminSupabase
          .from("repository_check_runs")
          .select("*, repositories!inner(git_provider)")
          .eq("repositories.git_provider", "github")
          .eq("check_run_id", payload.check_run.id)
          .maybeSingle();
        if (checkRun && checkRun.data) {
          scope?.setTag("check_run_id", checkRun.data.id.toString());
          const status = (checkRun.data?.status as ExtendedCheckRunStatus) || ({} as ExtendedCheckRunStatus);
          scope?.setTag("check_run_status_started", (!!status.started_at).toString());

          // Step 1: mark started_at if missing
          if (!status.started_at) {
            console.log(`[CHECK_RUN] Marking started for check_run_id=${payload.check_run.id}`);
            maybeCrash("check_run.before_mark_started");
            const newStatus = {
              ...(status as ExtendedCheckRunStatus),
              started_at: new Date().toISOString()
            } as ExtendedCheckRunStatus;
            await adminSupabase
              .from("repository_check_runs")
              .update({ status: newStatus as unknown as Json })
              .eq("id", checkRun.data.id);
          }

          // Step 2: trigger workflow once
          const startedStatus = (
            status.started_at ? status : { ...(status as ExtendedCheckRunStatus), started_at: new Date().toISOString() }
          ) as ExtendedCheckRunStatus;
          if (!startedStatus.workflow_triggered_at) {
            console.log(
              `[CHECK_RUN] Triggering workflow for repo=${payload.repository.full_name} sha=${payload.check_run.head_sha}`
            );
            maybeCrash("check_run.before_trigger_workflow");
            try {
              await getGitProvider().startGrading(payload.repository.full_name, payload.check_run.head_sha);
            } catch (triggerErr) {
              // Log the error with proper fingerprinting to prevent notification storms
              const repoName = payload.repository.full_name;
              const org = repoName.split("/")[0];
              const rt = detectRateLimitType(triggerErr);
              if (rt.type) {
                Sentry.withScope((errorScope) => {
                  errorScope.setFingerprint(["github-rate-limit", rt.type!, org, "triggerWorkflow"]);
                  errorScope.setTag("rate_limit_type", rt.type);
                  errorScope.setTag("github_api_method", "triggerWorkflow");
                  if (rt.installationId) {
                    errorScope.setContext("rate_limit_installation", {
                      installation_id: rt.installationId,
                      note: "Installation ID excluded from fingerprint to prevent notification storms"
                    });
                  }
                  Sentry.captureException(triggerErr, errorScope);
                });
                console.warn(`GitHub rate limit (${rt.type}) hit during triggerWorkflow (check_run) for ${repoName}`);
              } else {
                scope?.setTag("error_source", "trigger_workflow_failed_check_run");
                scope?.setTag("error_context", "Failed to trigger grade workflow from check_run");
                Sentry.captureException(triggerErr, scope);
              }
              // Mark the check run as triggered but failed so we don't retry endlessly
              await adminSupabase
                .from("repository_check_runs")
                .update({
                  status: {
                    ...(startedStatus as ExtendedCheckRunStatus),
                    workflow_triggered_at: new Date().toISOString()
                  } as unknown as Json
                })
                .eq("id", checkRun.data.id);
              return;
            }
            const afterTrigger = {
              ...(startedStatus as ExtendedCheckRunStatus),
              workflow_triggered_at: new Date().toISOString()
            } as ExtendedCheckRunStatus;
            await adminSupabase
              .from("repository_check_runs")
              .update({ status: afterTrigger as unknown as Json })
              .eq("id", checkRun.data.id);
          }

          // Step 3: mark check run in progress once (DB state only; no GitHub API call)
          const statusForCheckRun = (
            startedStatus.workflow_triggered_at
              ? startedStatus
              : { ...(startedStatus as ExtendedCheckRunStatus), workflow_triggered_at: new Date().toISOString() }
          ) as ExtendedCheckRunStatus;
          if (!statusForCheckRun.check_run_marked_in_progress_at) {
            const afterMark = {
              ...(statusForCheckRun as ExtendedCheckRunStatus),
              check_run_marked_in_progress_at: new Date().toISOString()
            } as ExtendedCheckRunStatus;
            await adminSupabase
              .from("repository_check_runs")
              .update({ status: afterMark as unknown as Json })
              .eq("id", checkRun.data.id);
          }
        } else {
          Sentry.captureMessage("Check run not found", scope);
        }
      }
    }
  } catch (err) {
    Sentry.captureException(err, scope);
    throw err;
  }
});
// Handle team membership changes (when users are added to GitHub teams)
eventHandler.on("membership", async ({ payload }: { payload: MembershipEvent }) => {
  // Extract team information early for e2e-ignore guard
  const teamSlug = (payload.team as { slug?: string })?.slug;
  const orgName = payload.organization?.login;

  // Parse team slug to determine course slug for e2e-ignore guard
  let courseSlug: string | undefined;
  if (teamSlug?.endsWith("-staff")) {
    courseSlug = teamSlug.slice(0, -6); // Remove '-staff'
  } else if (teamSlug?.endsWith("-students")) {
    courseSlug = teamSlug.slice(0, -9); // Remove '-students'
  }

  // e2e-ignore guard - execute before any console.log or metric calls
  if (orgName === "pawtograder-playground" && courseSlug?.startsWith("e2e-ignore-")) {
    return;
  }

  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "membership", payload);

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: REQUEST_SCOPED_AUTH_OPTIONS
    });

    // Only process when a member is added to a team
    if (payload.action !== "added") {
      return;
    }

    const memberGithubUsername = payload.member?.login;

    if (!teamSlug || !memberGithubUsername) {
      Sentry.captureMessage("Missing team slug or member login, skipping", scope);
      return;
    }

    // Parse team slug to determine course and team type
    // Team naming convention: {courseSlug}-staff or {courseSlug}-students
    let teamType: "staff" | "student";

    if (teamSlug.endsWith("-staff")) {
      courseSlug = teamSlug.slice(0, -6); // Remove '-staff'
      teamType = "staff";
    } else if (teamSlug.endsWith("-students")) {
      courseSlug = teamSlug.slice(0, -9); // Remove '-students'
      teamType = "student";
    } else {
      return;
    }

    scope?.setTag("org_name", orgName);
    scope?.setTag("course_slug", courseSlug);
    scope?.setTag("team_type", teamType);

    // Find the class by slug
    const { data: classData, error: classError } = await adminSupabase
      .from("classes")
      .select("id")
      .eq("slug", courseSlug)
      .eq("github_org", orgName)
      .single();

    if (classError) {
      if (orgName === "pawtograder-playground") {
        return; // Don't bother logging this - we intentionally share this org across instances.
      }
      Sentry.captureMessage(`Class not found for slug ${courseSlug}:`, scope);
      return;
    }

    const classId = classData.id;

    scope?.setTag("class_id", classId.toString());
    // Find the user by GitHub username
    const { data: userData, error: userError } = await adminSupabase
      .from("users")
      .select("user_id")
      .ilike("github_username", memberGithubUsername)
      .single();

    if (userError || !userData) {
      scope?.setTag("github_username", memberGithubUsername);
      if (userError) {
        Sentry.captureException(userError, scope);
      }
      Sentry.captureMessage(`User not found for GitHub username`, scope);
      return;
    }

    const userId = userData.user_id;

    // Find the user's role in this class
    const { data: userRoleData, error: userRoleError } = await adminSupabase
      .from("user_roles")
      .select("id, role")
      .eq("user_id", userId)
      .eq("class_id", classId)
      .single();

    if (userRoleError || !userRoleData) {
      Sentry.captureMessage(`User role not found for user ${userId} in class ${classId}:`, scope);
      return;
    }

    // Check if the team type matches the user's role. "staff" covers every non-student role
    // (admin/instructor/grader); admins belong on the staff team just like instructors and graders,
    // so confirm them too rather than logging a spurious mismatch.
    const userRole = userRoleData.role;
    const isCorrectTeam =
      (teamType === "staff" && (userRole === "admin" || userRole === "instructor" || userRole === "grader")) ||
      (teamType === "student" && userRole === "student");

    if (isCorrectTeam) {
      // Update github_org_confirmed to true
      const { error: updateError } = await adminSupabase
        .from("user_roles")
        .update({ github_org_confirmed: true })
        .eq("id", userRoleData.id);

      if (updateError) {
        Sentry.captureException(updateError, scope);
      } else {
        scope?.setTag("github_org_confirmed", "true");
      }
    } else {
      Sentry.captureMessage(
        `Team type ${teamType} does not match user role ${userRole}, not updating confirmation`,
        scope
      );
    }
  } catch (error) {
    Sentry.captureException(error, scope);
    throw error;
  }
});

// Handle organization invitation events
/**
 * A user left (or was removed from) a course's GitHub org.
 *
 * Until this handler existed, `github_org_confirmed` was a one-way latch: set true when the user
 * joined the team, and never cleared. An enrollment whose org membership disappeared therefore
 * looked confirmed forever, so nothing re-invited them, the team sync kept counting them as an
 * intended member, and the student's only symptom was repo permissions that silently stopped
 * working. Clearing both columns puts the row back into the state the ordinary invite machinery
 * already knows how to repair: the enrollment triggers on the next role change, and the hourly
 * membership reconciler otherwise.
 *
 * Only rows for classes IN THIS ORG are touched, and only live enrollments — a dropped student who
 * is removed from the org must stay removed. This is also the shape the instructor unlink flow
 * produces (github-user-sync removes the member, then clears the link); clearing there is harmless
 * because every re-invite path requires a non-null github_username.
 */
async function handleOrgMemberRemoved(
  adminSupabase: SupabaseClient<Database>,
  organizationName: string,
  removedUser: { login: string; id?: number | null },
  scope: Sentry.Scope
) {
  // Resolve by GitHub ACCOUNT ID first, falling back to the login. A user who renames their GitHub
  // account and then leaves arrives here under the new login while `users.github_username` may
  // still hold the old one, so a login-only lookup finds nothing and the enrollment stays falsely
  // confirmed forever — the exact latch this handler exists to release. The account id is the
  // stable identity, and it is the same one `reresolveMissingGitHubLogin` recovers renames from.
  let userData: { user_id: string } | null = null;
  if (removedUser.id !== undefined && removedUser.id !== null) {
    const { data, error } = await adminSupabase
      .from("users")
      .select("user_id")
      .eq("github_user_id", String(removedUser.id))
      .maybeSingle();
    // Throw rather than capture-and-return. Every early return here looks to the dispatcher exactly
    // like "handled", so it marks the delivery complete and GitHub never redelivers — and nothing
    // else in the system clears this latch, so a transient database error would leave the departed
    // member confirmed until some unrelated role mutation. The organization handler's own catch
    // captures with the org/user tags already on the scope.
    if (error) throw error;
    userData = data;
  }
  if (!userData) {
    const { data, error } = await adminSupabase
      .from("users")
      .select("user_id")
      // Case-insensitive: GitHub logins are, and `users.github_username` stores whatever casing was
      // current when the account was linked.
      .ilike("github_username", removedUser.login)
      .maybeSingle();
    if (error) throw error;
    userData = data;
  }
  if (!userData) {
    // Not one of ours (an org owner, a bot, someone added out of band). Not an error.
    return;
  }

  // One RPC for the whole repair: it clears the confirmation for the user's live enrollments in
  // this org's classes and, for the classes actually in session, enqueues a forced re-invite. The
  // enqueue matters — clearing alone would leave the student waiting for the sweep, which only
  // reconsiders an enrollment whose invitation is a staleness period old, so someone removed days
  // after accepting would have no repository access for the rest of that period. The window check
  // and the org's case-insensitive match live in SQL alongside the predicate they share.
  const { data: enqueued, error: repairError } = await adminSupabase.rpc("clear_org_membership_and_repair", {
    p_user_id: userData.user_id,
    p_org: organizationName
  });
  if (repairError) throw repairError;
  scope?.setTag("org_membership_repairs_enqueued", String(enqueued ?? 0));
  scope?.setTag("org_membership_cleared", "true");
  console.log(
    `[github-repo-webhook] ${removedUser.login} left ${organizationName}; cleared github_org_confirmed for their live enrollments, enqueued ${enqueued ?? 0} repair(s)`
  );
}

eventHandler.on("organization", async ({ payload }: { payload: OrganizationEvent }) => {
  // Extract organization name early for e2e-ignore guard
  const organizationName = payload.organization?.login;

  // e2e-ignore guard - execute before any console.log or metric calls
  if (organizationName === "pawtograder-playground") {
    return;
  }

  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "organization", payload);
  if ("invitation" in payload) {
    scope?.setTag("user_login", payload.invitation?.login || "");
  } else if ("membership" in payload) {
    scope?.setTag("user_login", payload.membership?.user?.login || "");
  } else {
    Sentry.captureMessage("Neither invitation nor membership present", scope);
  }

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: REQUEST_SCOPED_AUTH_OPTIONS
    });

    // A departure is the mirror of an invitation: it must un-confirm the enrollment, or the row
    // claims a membership that no longer exists and no repair path will ever look at it again.
    if (payload.action === "member_removed") {
      const removedUser = "membership" in payload ? payload.membership?.user : undefined;
      if (removedUser?.login && organizationName) {
        await handleOrgMemberRemoved(
          adminSupabase,
          organizationName,
          { login: removedUser.login, id: removedUser.id },
          scope
        );
      }
      return;
    }

    // Only process member invitation events
    if (payload.action !== "member_invited") {
      return;
    }

    // Extract invitation information
    const invitedUserLogin = payload.invitation?.login;

    if (!invitedUserLogin) {
      return;
    }

    if (!organizationName) {
      return;
    }

    // Find the user by GitHub username
    const result = await adminSupabase
      .from("users")
      .select("user_id")
      .ilike("github_username", invitedUserLogin)
      .single();

    const userData = result.data;
    const userError = result.error;

    if (userError || !userData) {
      if (userError) {
        Sentry.captureException(userError, scope);
      }
      scope?.setTag("github_username", invitedUserLogin);
      Sentry.captureMessage(`User not found for GitHub username`, scope);
      return;
    }

    const userId = userData.user_id;
    scope?.setTag("user_id", userId.toString());

    // First, find classes that match this GitHub organization
    const { data: classesData, error: classesError } = await adminSupabase
      .from("classes")
      .select("id")
      .eq("github_org", organizationName);

    if (classesError) {
      Sentry.captureException(classesError, scope);
      return;
    }

    if (!classesData || classesData.length === 0) {
      Sentry.captureMessage(`No classes found for GitHub organization: ${organizationName}`, scope);
      return;
    }

    const classIds = classesData.map((c) => c.id);
    scope?.setTag("class_ids", classIds.join(", "));

    // Update user_roles only for classes that match this GitHub organization
    const { error: updateError } = await adminSupabase
      .from("user_roles")
      .update({ invitation_date: new Date().toISOString() })
      .eq("user_id", userId)
      .in("class_id", classIds);

    if (updateError) {
      Sentry.captureException(updateError, scope);
    } else {
      scope?.setTag("invitation_date_updated", "true");
    }
  } catch (error) {
    Sentry.captureException(error, scope);
    throw error;
  }
});

async function handleWorkflowCompletionErrors(
  adminSupabase: SupabaseClient<Database>,
  workflowRun: WorkflowRunEvent["workflow_run"],
  repository: { full_name: string; owner: { login: string }; name: string },
  repositoryId: number,
  classId: number,
  scope: Sentry.Scope
) {
  scope.setTag("error_handler", "workflow_completion");
  scope.setTag("workflow_conclusion", workflowRun.conclusion);

  try {
    // First, look for submissions that match this specific workflow run
    const { data: submissions, error: submissionsError } = await adminSupabase
      .from("submissions")
      .select(
        "id, repository_check_run_id, run_number, run_attempt, sha, repository_id, repository_check_runs!submissions_repository_check_run_id_fkey(check_run_id), profile_id, assignment_group_id, assignment_id"
      )
      .eq("repository_id", repositoryId)
      .eq("sha", workflowRun.head_sha)
      .eq("run_number", workflowRun.id)
      .eq("run_attempt", workflowRun.run_attempt);

    if (submissionsError) {
      Sentry.captureException(submissionsError, scope);
      return;
    }

    scope.setTag("submissions_found", (submissions || []).length.toString());

    if (submissions && submissions.length > 0) {
      // We have submissions for this workflow run - check if they have grader results
      for (const submission of submissions) {
        const { data: graderResult, error: graderResultError } = await adminSupabase
          .from("grader_results")
          .select("id")
          .eq("submission_id", submission.id)
          .maybeSingle();

        if (graderResultError) {
          Sentry.captureException(graderResultError, scope);
          continue;
        }

        const hasGraderResult = graderResult !== null;
        scope.setTag(`submission_${submission.id}_has_grader_result`, hasGraderResult.toString());

        if (!hasGraderResult) {
          const { data: userVisibleErrRows, error: userVisibleErrLookupError } = await adminSupabase
            .from("workflow_run_error")
            .select("id")
            .eq("repository_id", repositoryId)
            .eq("run_number", workflowRun.id)
            .eq("run_attempt", workflowRun.run_attempt)
            .eq("data->>type", "user_visible_error")
            .limit(1);
          if (userVisibleErrLookupError) {
            Sentry.captureException(userVisibleErrLookupError, scope);
          }
          if (userVisibleErrRows && userVisibleErrRows.length > 0) {
            scope.setTag("missing_grader_result_skipped", "user_visible_error_present");
            continue;
          }

          const sentryMessage = "Workflow terminated without creating a grader result.";
          const userErrorMessage =
            "The grading container failed to terminate cleanly. This may indicate that the grading script ran out of memory or encountered an unexpected error. Please contact your instructor for assistance.";

          scope.setTag("error_type", "missing_grader_result");
          scope.setTag("workflow_run_id", workflowRun.id.toString());
          scope.setTag("submission_id", submission.id.toString());
          scope.setTag(
            "github_actions_run_url",
            `https://github.com/${repository.owner.login}/${repository.name}/actions/runs/${workflowRun.id}`
          );
          if (submission.repository_check_runs?.check_run_id) {
            scope.setTag("check_run_id", submission.repository_check_runs.check_run_id.toString());
          }

          // Create workflow_run_error record
          const { error: insertError } = await adminSupabase.from("workflow_run_error").upsert(
            {
              repository_id: repositoryId,
              class_id: classId,
              submission_id: submission.id,
              run_number: workflowRun.id,
              run_attempt: workflowRun.run_attempt,
              name: userErrorMessage,
              data: {
                workflow_run_id: workflowRun.id,
                workflow_conclusion: workflowRun.conclusion,
                workflow_status: workflowRun.status,
                check_run_id: submission.repository_check_runs?.check_run_id,
                repository_name: repository.full_name,
                sha: workflowRun.head_sha,
                error_type: "missing_grader_result",
                detected_at: new Date().toISOString(),
                technical_details: sentryMessage
              }
            },
            { onConflict: "repository_id,run_number,run_attempt,name" }
          );

          if (insertError) {
            Sentry.captureException(insertError, scope);
          } else {
            scope.setTag("workflow_run_error_created", "true");
          }

          const graderResultError: Json = {
            error: userErrorMessage
          };

          // Insert a grader result with the error message
          const { error: insertGraderResultError } = await adminSupabase.from("grader_results").insert({
            submission_id: submission.id,
            errors: graderResultError,
            score: 0,
            ret_code: 137,
            lint_output: "",
            lint_output_format: "text",
            lint_passed: false,
            profile_id: submission.profile_id,
            assignment_group_id: submission.assignment_group_id,
            class_id: classId
          });
          if (insertGraderResultError) {
            Sentry.captureException(insertGraderResultError, scope);
          } else {
            scope.setTag("grader_result_created", "true");
          }

          // Log to Sentry
          Sentry.captureMessage(sentryMessage, scope);
        }
      }
    }
  } catch (error) {
    scope.setTag("error_handler_failed", "true");
    Sentry.captureException(error, scope);
  }
}

// Handle workflow_run events (requested, in_progress, completed, cancelled)
eventHandler.on("workflow_run", async ({ payload }: { payload: WorkflowRunEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "workflow_run", payload);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );

  try {
    const workflowRun = payload.workflow_run as WorkflowRunEvent["workflow_run"];
    const repository = payload.repository as WorkflowRunEvent["repository"];

    // Map GitHub workflow action to our event_type
    let eventType: string;
    switch (payload.action) {
      case "requested":
        eventType = "requested";
        break;
      case "in_progress":
        eventType = "in_progress";
        break;
      case "completed":
        eventType = "completed";
        break;
      default:
        Sentry.captureMessage(`Unknown workflow_run action, skipping`, scope);
        return;
    }

    // Try to match repository against repositories table
    const { data: matchedRepo, error: repoError } = await adminSupabase
      .from("repositories")
      .select("id, class_id")
      .eq("git_provider", "github")
      .eq("repository", repository.full_name)
      .maybeSingle();

    if (repoError) {
      Sentry.captureException(repoError, scope);
    }

    let repositoryId: number | null = null;
    let classId: number | null = null;

    if (matchedRepo) {
      repositoryId = matchedRepo.id;
      classId = matchedRepo.class_id;
      scope?.setTag("repository_id", repositoryId.toString());
      scope?.setTag("class_id", classId.toString());
    } else {
      // We don't capture events for handout or solution repos, do we need to?
      // Sentry.captureMessage(`No matching repository found for ${repository.full_name}`, scope);
    }

    // Extract pull request information if available
    const pullRequests =
      workflowRun.pull_requests?.map((pr: WorkflowRunEvent["workflow_run"]["pull_requests"][number]) => ({
        id: pr.id,
        number: pr.number,
        head: {
          ref: pr.head?.ref,
          sha: pr.head?.sha
        },
        base: {
          ref: pr.base?.ref,
          sha: pr.base?.sha
        }
      })) || [];

    // Upsert workflow event into database (dedupe by workflow_run_id, event_type, run_attempt)
    maybeCrash("workflow_run.before_upsert");
    const { error: insertError } = await adminSupabase.from("workflow_events").insert({
      workflow_run_id: workflowRun.id,
      repository_name: repository.full_name,
      github_repository_id: repository.id,
      repository_id: repositoryId,
      class_id: classId,
      workflow_name: workflowRun.name,
      workflow_path: workflowRun.path,
      event_type: eventType,
      status: workflowRun.status,
      conclusion: workflowRun.conclusion,
      head_sha: workflowRun.head_sha,
      head_branch: workflowRun.head_branch,
      run_number: workflowRun.run_number,
      run_attempt: workflowRun.run_attempt,
      actor_login: workflowRun.actor?.login,
      triggering_actor_login: workflowRun.triggering_actor?.login,
      started_at: workflowRun.run_started_at ? new Date(workflowRun.run_started_at).toISOString() : null,
      updated_at: workflowRun.updated_at ? new Date(workflowRun.updated_at).toISOString() : null,
      run_started_at: workflowRun.run_started_at ? new Date(workflowRun.run_started_at).toISOString() : null,
      run_updated_at: workflowRun.updated_at ? new Date(workflowRun.updated_at).toISOString() : null,
      pull_requests: pullRequests.length > 0 ? pullRequests : null,
      payload: payload as unknown as Json
    });

    if (insertError) {
      scope.setTag("error_source", "workflow_events_insert_failed");
      scope.setTag("error_context", "Failed to store workflow event");
      Sentry.captureException(insertError, scope);
      throw insertError;
    }

    scope?.setTag("workflow_event_logged", "true");
    console.log(`[WORKFLOW_RUN] Logged ${eventType} for run=${workflowRun.id} attempt=${workflowRun.run_attempt}`);

    // Add error detection for completed workflows
    if (eventType === "completed" && repositoryId && classId) {
      maybeCrash("workflow_run.before_handle_completion_errors");
      await handleWorkflowCompletionErrors(adminSupabase, workflowRun, repository, repositoryId, classId, scope);
    }
  } catch (error) {
    Sentry.captureException(error, scope);
    // Don't throw here to avoid breaking the webhook processing
  }
});

// Handle deployment_status events. Records one github_deployments row per
// delivery (read-only data layer for the Phase 4 Deployments UI). No GitHub API
// calls are made -- the webhook payload carries everything we store, so there
// is no rate-limiter / circuit-breaker interaction here.
//
// Resolving class_id (NOT NULL on the table):
//   1. If the deploy repo is tracked in `repositories`, take its class_id +
//      repository_id (the student-repo / autograder case).
//   2. Otherwise (fork or shared-project repo whose CI/deploy runs off a repo we
//      don't track) resolve class_id from a submission whose (repository,
//      head_sha) matches the deployment's (repo, sha) -- exactly the join the UI
//      uses. repository_id stays NULL.
//   3. If neither resolves a class, skip: the row would be unattributable and we
//      cannot satisfy the NOT NULL class_id. (Deployments on handout/solution or
//      unrelated repos legitimately fall here.)
// Idempotent on re-delivery via upsert_github_deployment's unique-key upsert.
eventHandler.on("deployment_status", async ({ payload }: { payload: DeploymentStatusEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "deployment_status", payload);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );

  try {
    const repoFullName = payload.repository.full_name;
    const deployment = payload.deployment;
    const deploymentStatus = payload.deployment_status;
    const sha = deployment?.sha ?? null;
    // deployment_status.environment is the most specific; fall back to the
    // deployment's environment.
    const environment = deploymentStatus?.environment ?? deployment?.environment ?? null;

    scope.setTag("deployment_repo", repoFullName);
    if (sha) {
      scope.setTag("deployment_sha", sha);
    }

    // Step 1: tracked repo?
    const { data: matchedRepo, error: repoError } = await adminSupabase
      .from("repositories")
      .select("id, class_id")
      .eq("git_provider", "github")
      .eq("repository", repoFullName)
      .maybeSingle();
    if (repoError) {
      Sentry.captureException(repoError, scope);
    }

    let repositoryId: number | null = null;
    let classId: number | null = null;

    if (matchedRepo) {
      repositoryId = matchedRepo.id;
      classId = matchedRepo.class_id;
    } else if (sha) {
      // Step 2: fork/shared-project -- resolve class via a matching submission.
      // Match either column: pr-mode submissions store the commit in `head_sha`,
      // push-mode submissions store it in `sha` (head_sha NULL). Matching only
      // head_sha silently drops deployments for push-mode submissions.
      const { data: matchedSubmission, error: submissionError } = await adminSupabase
        .from("submissions")
        .select("class_id, assignments!inner(git_provider)")
        .eq("assignments.git_provider", "github")
        .eq("repository", repoFullName)
        .or(`head_sha.eq.${sha},sha.eq.${sha}`)
        .limit(1)
        .maybeSingle();
      if (submissionError) {
        Sentry.captureException(submissionError, scope);
      }
      if (matchedSubmission) {
        classId = matchedSubmission.class_id;
      }
    }

    // Step 3: can't attribute to a class -> nothing to record.
    if (classId === null) {
      scope.setTag("deployment_unresolved_class", "true");
      return;
    }

    scope.setTag("class_id", classId.toString());
    if (repositoryId !== null) {
      scope.setTag("repository_id", repositoryId.toString());
    }

    maybeCrash("deployment_status.before_upsert");
    // Optional params are omitted (not null) so the SQL DEFAULT NULL applies.
    const { error: upsertError } = await adminSupabase.rpc("upsert_github_deployment", {
      p_class_id: classId,
      p_repository_name: repoFullName,
      p_repository_id: repositoryId ?? undefined,
      p_sha: sha ?? undefined,
      p_environment: environment ?? undefined,
      p_state: deploymentStatus?.state ?? undefined,
      p_target_url: deploymentStatus?.target_url ?? deploymentStatus?.log_url ?? undefined,
      p_github_deployment_id: deployment?.id ?? undefined,
      p_github_deployment_status_id: deploymentStatus?.id ?? undefined,
      p_creator_login: deployment?.creator?.login ?? undefined,
      p_payload: payload as unknown as Json
    });

    if (upsertError) {
      scope.setTag("error_source", "github_deployments_upsert_failed");
      Sentry.captureException(upsertError, scope);
      return;
    }

    scope.setTag("deployment_recorded", "true");
    console.log(
      `[DEPLOYMENT_STATUS] Recorded ${deploymentStatus?.state} for ${repoFullName}@${sha ?? "?"} (class=${classId})`
    );
  } catch (error) {
    Sentry.captureException(error, scope);
    // Don't throw -- a failed deployment record must not break webhook delivery.
  }
});

// Ingest a pull request as a submission for any pr-mode assignment whose
// upstream repo is the repo this PR targets. This is the "webhook-direct"
// path: no autograder workflow is involved — we resolve the PR to a
// (student/group, assignment) and call ingest_pr_submission, which creates the
// submission version and (via the after-insert trigger) its grading review.
async function handlePrSubmission(payload: PullRequestEvent, scope: Sentry.Scope): Promise<void> {
  const action = payload.action;
  console.log(
    `[PR_INGEST] start repo=${payload.repository.full_name} pr=#${payload.pull_request.number} action=${action}`
  );
  // Lifecycle actions that can change a PR's head sha or its open/closed state.
  const RELEVANT = ["opened", "reopened", "synchronize", "edited", "ready_for_review", "converted_to_draft", "closed"];
  if (!RELEVANT.includes(action)) {
    console.log(`[PR_INGEST] skip: action '${action}' not in relevant set`);
    return;
  }

  const upstreamRepo = payload.repository.full_name; // owner/name PRs target
  const pr = payload.pull_request;
  const baseRef = pr.base.ref;
  const headRef = pr.head.ref;
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  // Provisional base; replaced with the merge-base below (see the merge-base
  // resolution just before ingest). Stored as the graded diff base.
  let baseSha = pr.base.sha;
  // The code being submitted lives in the PR's HEAD repo — the student/group
  // fork. We attribute the submission by looking that fork up in our
  // `repositories` table (the same authoritative path autograder-create-submission
  // uses), NOT by mapping the GitHub login of whoever opened the PR. The
  // repositories row already carries profile_id / assignment_group_id /
  // assignment_id, so a group fork's row has assignment_group_id set and the
  // submission is correctly attributed to the GROUP regardless of which member
  // opened the PR — no users / user_roles / assignment_groups_members lookups.
  const headRepo = pr.head.repo?.full_name;
  const prState = prStateFromPullRequest(pr);

  // One grep-able prefix (`[PR_INGEST]`) for the whole ingestion path; every
  // skip/return below logs why, so a silent no-op is diagnosable from logs alone.
  const ctx = `repo=${upstreamRepo} pr=#${prNumber} action=${action} base=${baseRef} head=${headRef} headRepo=${headRepo ?? "?"}`;

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );

  // Which assignments treat this repo as their upstream/class repo? (Could be
  // several — the same handout repo can back assignments in multiple classes.)
  // `upstream_repo` is matched case-insensitively (GitHub names are case-insensitive),
  // but `.ilike()` treats the value as a LIKE pattern, so a literal `_` or `%` in a repo
  // name would act as a wildcard and over-match a *different* assignment's upstream_repo.
  // Escape LIKE metacharacters so this stays an exact (case-insensitive) match.
  const upstreamRepoPattern = upstreamRepo.replace(/[\\%_]/g, "\\$&");
  const { data: assignments, error: assignmentsError } = await adminSupabase
    .from("assignments")
    .select("id, class_id, upstream_base_branch, pr_identification, pr_branch_convention")
    .eq("git_provider", "github")
    .eq("submission_mode", "pr")
    .ilike("upstream_repo", upstreamRepoPattern);
  if (assignmentsError) {
    console.log(`[PR_INGEST] error: assignments lookup failed: ${assignmentsError.message} ${ctx}`);
    Sentry.captureException(assignmentsError, scope);
    return;
  }
  if (!assignments || assignments.length === 0) {
    console.log(
      `[PR_INGEST] skip: no submission_mode='pr' assignment with upstream_repo ILIKE '${upstreamRepo}' ${ctx}`
    );
    return; // Not an upstream repo for any pr-mode assignment.
  }
  console.log(`[PR_INGEST] matched assignment(s) [${assignments.map((a) => a.id).join(", ")}] ${ctx}`);

  scope.setTag("pr_submission_repo", upstreamRepo);
  scope.setTag("pr_number", prNumber.toString());

  // Closing/merging/reopening never carries new code, so it needs no fork, no
  // attributable repository row, and none of the identification gates below —
  // all of which can change *after* a submission was first ingested (fork
  // deleted, repo row cleaned up, staff edited pr_branch_convention or
  // upstream_base_branch). Reflect the state on every matching pr-mode
  // assignment up front so a stale config or a missing fork can't strand the
  // stored PR state. set_pr_state is keyed by (assignment, repo, pr_number) and
  // no-ops where no submission exists, so the broadcast is safe.
  const isMerged = action === "closed" && pr.merged === true;
  if (action === "closed") {
    for (const target of assignments) {
      console.log(
        `[PR_INGEST] assignment=${target.id}: action=closed -> set_pr_state '${prState}' (no new version) ${ctx}`
      );
      const { error: stateError } = await adminSupabase.rpc("set_pr_state", {
        p_assignment_id: target.id,
        p_pr_repo: upstreamRepo,
        p_pr_number: prNumber,
        p_pr_state: prState
      });
      if (stateError) {
        console.log(`[PR_INGEST] error assignment=${target.id}: set_pr_state failed: ${stateError.message} ${ctx}`);
        Sentry.captureException(stateError, scope);
      }
    }
    if (!isMerged) {
      console.log(`[PR_INGEST] done (closed, not merged) ${ctx}`);
      return;
    }
    // A MERGED PR must still produce a submission even when this 'closed' event is
    // the first one we ever processed for the PR (delayed webhook/EventBridge, or
    // the assignment was switched to PR mode after the PR was opened). set_pr_state
    // above is a bare UPDATE that matches zero rows when nothing was ingested yet,
    // so fall through to the attribution + ingest path below. ingest_pr_submission
    // is idempotent on head_sha, so for the normal open->sync->merge sequence this
    // is a no-op on the already-ingested head -- it only creates work when the
    // merged head was never ingested.
    console.log(
      `[PR_INGEST] closed+merged: continuing to attribution/ingest so a never-ingested merged PR still yields a submission ${ctx}`
    );
  }

  if (!headRepo) {
    // No head repo (fork deleted, or a same-repo PR with no fork) — there is no
    // registered student/group repository to attribute to.
    console.log(`[PR_INGEST] skip: PR has no head repo to attribute (fork deleted?) ${ctx}`);
    return;
  }

  // Resolve the submitter via the head fork's repositories row. A fork belongs
  // to exactly one assignment, so this row pins both WHO (profile/group) and
  // WHICH assignment the PR submits to.
  const { data: repoRow, error: repoRowError } = await adminSupabase
    .from("repositories")
    .select("id, profile_id, assignment_group_id, assignment_id, class_id")
    .eq("git_provider", "github")
    .eq("repository", headRepo)
    .maybeSingle();
  if (repoRowError) {
    console.log(`[PR_INGEST] error: repositories lookup failed: ${repoRowError.message} ${ctx}`);
    Sentry.captureException(repoRowError, scope);
    return;
  }
  if (!repoRow) {
    console.log(`[PR_INGEST] skip: head repo '${headRepo}' is not a registered student/group repository ${ctx}`);
    scope.setTag("pr_head_repo", headRepo);
    Sentry.captureMessage("PR head repo not found in repositories table", scope);
    return;
  }

  // The fork's assignment must be one of the pr-mode assignments targeting this
  // upstream. (Guards against a fork from a different assignment opening a PR
  // against this upstream.)
  const a = assignments.find((x) => x.id === repoRow.assignment_id);
  if (!a) {
    console.log(
      `[PR_INGEST] skip: head repo '${headRepo}' belongs to assignment=${repoRow.assignment_id}, not a pr-mode assignment for upstream '${upstreamRepo}' ${ctx}`
    );
    return;
  }

  // Identification gate: does this PR count as a submission for this assignment?
  if (a.pr_identification === "branch_convention") {
    if (!a.pr_branch_convention) {
      console.log(`[PR_INGEST] skip assignment=${a.id}: branch_convention mode but pr_branch_convention unset ${ctx}`);
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(a.pr_branch_convention);
    } catch {
      console.log(
        `[PR_INGEST] skip assignment=${a.id}: invalid pr_branch_convention /${a.pr_branch_convention}/ ${ctx}`
      );
      return; // Misconfigured convention — skip rather than crash the webhook.
    }
    // pr_branch_convention is instructor-authored, but it's matched against a
    // student-controlled branch name (headRef). Reject patterns that aren't
    // provably ReDoS-safe so a catastrophic-backtracking convention can't hang
    // the webhook on a crafted branch name. Run this on the compiled regex (so a
    // syntactically invalid pattern is already handled above — safeRegex throws
    // on unparseable input). Treated like a misconfiguration: skip and log.
    if (!safeRegex(re)) {
      console.log(
        `[PR_INGEST] skip assignment=${a.id}: unsafe pr_branch_convention /${a.pr_branch_convention}/ (ReDoS guard) ${ctx}`
      );
      return;
    }
    if (!re.test(headRef)) {
      console.log(
        `[PR_INGEST] skip assignment=${a.id}: head '${headRef}' fails convention /${a.pr_branch_convention}/ ${ctx}`
      );
      return;
    }
  } else {
    // base_branch + manual both require targeting the configured base branch.
    const expectedBase = a.upstream_base_branch ?? "main";
    if (baseRef !== expectedBase) {
      console.log(`[PR_INGEST] skip assignment=${a.id}: base '${baseRef}' != expected '${expectedBase}' ${ctx}`);
      return;
    }
  }

  // Attribution comes straight from the fork's repositories row: a group fork
  // has assignment_group_id set (profile_id null); an individual fork has
  // profile_id set.
  const groupId = repoRow.assignment_group_id ?? null;
  const profileId = repoRow.profile_id ?? null;
  if (!groupId && !profileId) {
    console.log(
      `[PR_INGEST] skip assignment=${a.id}: head repo '${headRepo}' has neither profile_id nor assignment_group_id ${ctx}`
    );
    Sentry.captureMessage("PR head repo has no owner profile or group", scope);
    return;
  }

  // Resolve the diff base to the MERGE-BASE (where the student branched off the
  // upstream), not pr.base.sha (the base-branch tip, which keeps advancing as the
  // upstream gets new commits). get-pr-base-files clones the upstream at base_sha
  // and diffs the full head tree against it; using the tip folds unrelated
  // upstream commits into the grader's inline diff and can hide student edits that
  // overlap upstream movement. Best-effort: a failed lookup falls back to the base
  // tip so ingestion never breaks over it.
  try {
    const octokit = await getOctoKit(upstreamRepo, scope);
    if (octokit) {
      const [upOwner, upName] = upstreamRepo.split("/");
      const headOwner = headRepo.split("/")[0];
      // Cross-fork compare on the upstream repo, keyed by IMMUTABLE commit SHAs
      // (pr.base.sha / pr.head.sha) rather than branch refs. Webhook delivery is
      // async via EventBridge, so by the time this runs baseRef/headRef may have
      // advanced or been deleted -- a branch-keyed compare would resolve the
      // merge-base against a different head than the one we're ingesting. The
      // compare endpoint accepts SHAs in basehead (head side prefixed with the
      // fork owner so it resolves within the network).
      const { data: cmp } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner: upOwner,
        repo: upName,
        basehead: `${pr.base.sha}...${headOwner}:${headSha}`
      });
      if (cmp?.merge_base_commit?.sha) {
        baseSha = cmp.merge_base_commit.sha;
        console.log(`[PR_INGEST] resolved merge-base ${baseSha} (base tip was ${pr.base.sha}) ${ctx}`);
      }
    }
  } catch (mergeBaseErr) {
    console.log(
      `[PR_INGEST] warn: merge-base lookup failed, using base tip ${pr.base.sha}: ${mergeBaseErr instanceof Error ? mergeBaseErr.message : String(mergeBaseErr)} ${ctx}`
    );
    Sentry.captureException(mergeBaseErr, scope);
  }

  // Closing/merging without a new head is handled up front; by here the action is
  // an open/sync/reopen (or a merged 'closed' that was never ingested) that may
  // create a new version.
  const { data: submissionId, error: ingestError } = await adminSupabase.rpc("ingest_pr_submission", {
    p_assignment_id: a.id,
    p_profile_id: groupId ? undefined : (profileId ?? undefined),
    p_assignment_group_id: groupId ?? undefined,
    p_pr_repo: upstreamRepo,
    p_pr_number: prNumber,
    p_base_sha: baseSha,
    p_head_sha: headSha,
    p_pr_state: prState,
    p_auto_confirm: a.pr_identification !== "manual"
  });
  if (ingestError) {
    console.log(`[PR_INGEST] error assignment=${a.id}: ingest_pr_submission failed: ${ingestError.message} ${ctx}`);
    Sentry.captureException(ingestError, scope);
    // THROW (don't swallow): a transient ingest failure (advisory-lock
    // contention, serialization failure, brief DB drop) must leave this webhook
    // delivery INCOMPLETE so GitHub redelivers the same id. Swallowing here let
    // the entry handler mark the delivery completed in Redis, after which the
    // de-dup short-circuit rejects GitHub's redelivery as a duplicate and the
    // submission is lost (auto-confirm mode has no reconciliation path).
    // ingest_pr_submission is idempotent, so redelivery is safe.
    throw new Error(`ingest_pr_submission failed: ${ingestError.message}`);
  }
  console.log(
    `[PR_INGEST] ingested assignment=${a.id} submission_id=${submissionId ?? "null"} group=${groupId ?? "none"} ${ctx}`
  );

  // ingest_pr_submission only creates the submission row; fetch the PR head
  // fork's files into submission_files so graders have something to view/diff.
  // The code lives in the *head fork*, not the upstream repo. Null id => the
  // link isn't confirmed yet (nothing to ingest).
  if (submissionId) {
    try {
      await ingestPrSubmissionFiles({
        adminSupabase,
        submissionId: submissionId as number,
        classId: a.class_id,
        profileId: groupId ? null : profileId,
        groupId: groupId ?? null,
        headRepo,
        headSha,
        scope
      });
      console.log(
        `[PR_INGEST] files ingested assignment=${a.id} submission_id=${submissionId} headRepo=${headRepo} ${ctx}`
      );
    } catch (filesError) {
      // Don't fail the webhook delivery over a file-ingest hiccup; the row
      // exists and a re-delivery (or confirm) will retry idempotently.
      console.log(
        `[PR_INGEST] warn assignment=${a.id}: file ingest failed (row still created): ${filesError instanceof Error ? filesError.message : String(filesError)} ${ctx}`
      );
      Sentry.captureException(filesError, scope);
    }
  } else {
    console.log(`[PR_INGEST] assignment=${a.id}: skipped file ingest (submission_id=null — unconfirmed link) ${ctx}`);
  }
  console.log(`[PR_INGEST] done ${ctx}`);
}

// Handle pull_request events (PR-mode submissions + tracking sync PR merges)
eventHandler.on("pull_request", async ({ payload }: { payload: PullRequestEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "pull_request", payload);

  // PR-mode submission ingestion runs first and independently of the sync-PR
  // bookkeeping below. Capture (don't immediately rethrow) a failure so the
  // sync-PR bookkeeping still runs, then propagate it at the very end: a thrown
  // error leaves the entry handler from marking this delivery complete in Redis,
  // so GitHub redelivers and the submission isn't lost. Both paths are idempotent.
  let prIngestError: unknown = null;
  try {
    await handlePrSubmission(payload, scope);
  } catch (error) {
    Sentry.captureException(error, scope);
    prIngestError = error;
  }

  // Sync-PR merge bookkeeping. Wrapped in an IIFE so its early returns don't skip
  // the prIngestError rethrow below; its own try/catch already swallows failures.
  await (async () => {
    // Only handle "closed" events where the PR was merged
    if (payload.action !== "closed" || !payload.pull_request.merged) {
      return;
    }

    const branchName = payload.pull_request.head.ref;

    // Check if this is a sync PR (branch starts with "sync-to-")
    if (!branchName.startsWith("sync-to-")) {
      return;
    }

    scope.setTag("sync_pr_merged", "true");
    scope.setTag("branch", branchName);
    scope.setTag("pr_number", payload.pull_request.number.toString());

    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: REQUEST_SCOPED_AUTH_OPTIONS }
    );

    try {
      const repoFullName = payload.repository.full_name;

      // Find the repository in our database
      const { data: repo, error: repoError } = await adminSupabase
        .from("repositories")
        .select("id, synced_handout_sha, desired_handout_sha, sync_data, sync_blocked_at")
        .eq("git_provider", "github")
        .eq("repository", repoFullName)
        .maybeSingle();

      if (repoError) {
        Sentry.captureException(repoError, scope);
        return;
      }

      if (!repo) {
        // Not one of our tracked repositories
        return;
      }

      scope.setTag("repository_id", repo.id.toString());

      // Extract the short SHA from branch name (sync-to-abc1234 -> abc1234)
      const shortSha = branchName.replace("sync-to-", "");

      // Use the full SHA from desired_handout_sha if it matches the short SHA prefix,
      // otherwise fall back to the short SHA (handles edge cases). synced_handout_sha is tried
      // too: when a LATER revision has already raised desired_handout_sha, it is the row's
      // other recorded sha that this branch can still name in full.
      const syncedSha = repo.desired_handout_sha?.startsWith(shortSha)
        ? repo.desired_handout_sha
        : repo.synced_handout_sha?.startsWith(shortSha)
          ? repo.synced_handout_sha
          : shortSha;

      // WHICH REVISION THIS PULL REQUEST IS FOR, and why the answer decides what survives.
      //
      // A sync that could not be delivered records `blocked_by_student_changes` along with the
      // revision it was blocked at and the paths that blocked it, and it carries forward the
      // pull request an EARLIER revision opened, because that PR is still open and still the
      // thing the student has to merge. When they merge it, this handler runs -- for the older
      // revision. Replacing sync_data wholesale then deleted a live revision's status and its
      // unresolved paths, while sync_blocked_at stayed set: the row read "Sync Finalizing",
      // the instructor lost the only record of what was actually blocking, and the durable
      // marker sat there with nothing to explain it.
      //
      // The branch name carries the revision as its 7-character prefix, which is what makes
      // the two cases distinguishable at all.
      const priorSyncData = (repo.sync_data ?? {}) as {
        status?: string;
        blocked_handout_sha?: string;
        unresolved_paths?: string[];
        last_sync_error?: string;
        terminal_reason?: string;
        branch_name?: string;
      };
      // The durable COLUMN, not a display status, is what says a person is still needed. Two
      // outcomes set it and both carry an earlier revision's pull request: the blocked one
      // ("every changed file is the student's own work") and a terminal failure
      // (sync_branch_not_ours, sync_branch_moved, sync_tree_too_large). Recognizing only the
      // first meant merging that older PR cleared the marker and overwrote a terminal
      // failure's state -- and because desired_handout_sha already equalled the newer
      // revision, non-forced queueing then skipped the repository as up to date while it sat
      // on the older one.
      const wasBlocked = repo.sync_blocked_at !== null;
      const blockedRevision = wasBlocked ? priorSyncData.blocked_handout_sha : undefined;
      // Only a blocker on a DIFFERENT revision survives. When the merged PR is the blocked
      // revision's own, merging it is what resolved it. A blocker whose revision was not
      // recorded is preserved: an unreadable marker is not a cleared one, and the failure
      // direction has to be a repository that stays visibly stuck rather than one that
      // reports itself finished.
      const stillBlockedOnNewerRevision = wasBlocked && !blockedRevision?.startsWith(shortSha);
      scope.setTag("sync_pr_merge_preserves_block", String(stillBlockedOnNewerRevision));

      // For "Rebase and merge" PRs, merge_commit_sha is null, so fall back to head SHA
      const effectiveMergeSha = payload.pull_request.merge_commit_sha || payload.pull_request.head.sha;

      scope.setTag("short_sha", shortSha);
      scope.setTag("synced_sha", syncedSha);
      scope.setTag("merge_sha", effectiveMergeSha);

      // Update the repository sync status
      const { error: updateError } = await adminSupabase
        .from("repositories")
        .update({
          synced_handout_sha: syncedSha,
          synced_repo_sha: effectiveMergeSha,
          // The marker is cleared by a merge of the revision it was set for, and only that.
          // A newer revision is still undelivered and still needs a person, so its retry
          // record has to outlive an older pull request being merged.
          ...(stillBlockedOnNewerRevision ? {} : { sync_blocked_at: null, sync_block_reason: null }),
          sync_data: {
            // The newer revision's blocker, kept ahead of this PR's bookkeeping so a merge of
            // an older pull request cannot report the repository as finished. Its own status
            // is carried rather than assumed, because the two shapes are not interchangeable:
            // one names the files the student has to apply, the other names the error class a
            // person has to act on.
            ...(stillBlockedOnNewerRevision
              ? {
                  status: priorSyncData.status,
                  blocked_handout_sha: blockedRevision,
                  unresolved_paths: priorSyncData.unresolved_paths,
                  last_sync_error: priorSyncData.last_sync_error,
                  terminal_reason: priorSyncData.terminal_reason
                }
              : // Nothing newer is blocked, so this merge IS the outcome -- but a sync can
                // write some files and still leave others to the student, and those paths are
                // recorded alongside the open pull request. They are the only record that
                // those handout changes never arrived, and they do not stop being absent
                // because the PR carrying the rest was merged. Carried when this merge is the
                // pull request they were recorded with.
                priorSyncData.branch_name === branchName && priorSyncData.unresolved_paths?.length
                ? { unresolved_paths: priorSyncData.unresolved_paths }
                : {}),
            pr_number: payload.pull_request.number,
            pr_url: payload.pull_request.html_url,
            pr_state: "merged",
            branch_name: branchName,
            last_sync_attempt: new Date().toISOString(),
            merge_sha: effectiveMergeSha,
            merged_by: payload.pull_request.merged_by?.login,
            merged_at: payload.pull_request.merged_at
          }
        })
        .eq("id", repo.id);

      if (updateError) {
        scope.setTag("error_source", "repository_update_failed");
        Sentry.captureException(updateError, scope);
        throw updateError;
      }

      Sentry.addBreadcrumb({
        message: `Updated repository ${repoFullName} after sync PR #${payload.pull_request.number} was merged`,
        level: "info"
      });

      console.log(
        `[PULL_REQUEST] Sync PR merged: ${repoFullName} PR#${payload.pull_request.number}, synced to ${syncedSha}`
      );
    } catch (error) {
      Sentry.captureException(error, scope);
      // Don't throw - allow webhook to complete
    }
  })();

  // Propagate a transient PR-ingest failure now that sync-PR bookkeeping has run,
  // so the entry handler leaves this delivery incomplete and GitHub redelivers it.
  if (prIngestError) {
    throw prIngestError;
  }
});

// Type guard to check if a unit is a mutation test unit
export function isMutationTestUnit(unit: GradedUnit): unit is MutationTestUnit {
  return "locations" in unit;
}

// Type guard to check if a unit is a regular test unit
export function isRegularTestUnit(unit: GradedUnit): unit is RegularTestUnit {
  return "tests" in unit && "testCount" in unit;
}

serveWithSentryFlush(async (req) => {
  console.log("[ENTRY] Received webhook request");
  if (req.headers.get("Authorization") !== Deno.env.get("EVENTBRIDGE_SECRET")) {
    return Response.json(
      {
        message: "Unauthorized"
      },
      {
        status: 401
      }
    );
  }

  const body = await req.json();
  const scope = new Sentry.Scope();
  scope.setContext("webhook", {
    body: JSON.stringify(body)
  });
  scope.setTag("webhook_id", body.id);
  scope.setTag("webhook_name", body["detail-type"]);
  scope.setTag("webhook_source", "github");
  if (body?.detail?.repository) {
    scope.setTag("repository", body.detail.repository.full_name);
    scope.setTag("repository_id", body.detail.repository.id?.toString());
  }
  if (body?.detail?.action) {
    scope.setTag("webhook_action", body.detail.action);
  }
  scope.addAttachment({ filename: "webhook.json", data: JSON.stringify(body) });
  const eventName = body["detail-type"];
  const id = body.id;
  console.log(`[ENTRY] id=${id} type=${eventName}`);

  try {
    maybeCrash("entry.before_status_upsert");

    // Use Redis for webhook status tracking with 24-hour TTL
    const redis = getRedisClient();
    if (!redis) {
      console.error("Redis client not available, cannot track webhook status");
      Sentry.captureMessage("Redis client not available for webhook status tracking", scope);
      // Continue processing without status tracking
    }

    let attemptCount = 1;
    const webhookKey = `webhook:${id}`;
    const ttlSeconds = 10800; // 3 hours

    if (redis) {
      try {
        // Try to get existing status from Redis
        const existingStatus = await redis.get(webhookKey);

        if (!existingStatus) {
          // First delivery - create new status
          const newStatus: WebhookStatus = {
            completed: false,
            attempt_count: 1,
            event_name: eventName,
            last_attempt_at: new Date().toISOString()
          };
          await redis.set(webhookKey, JSON.stringify(newStatus), { ex: ttlSeconds });
          attemptCount = 1;
        } else {
          // Redelivery - parse existing status
          // Upstash Redis client may return object directly or as string
          const status =
            typeof existingStatus === "string"
              ? (JSON.parse(existingStatus) as WebhookStatus)
              : (existingStatus as WebhookStatus);

          if (status.completed) {
            return Response.json({ message: "Duplicate webhook received" }, { status: 200 });
          }

          // Increment attempt count
          attemptCount = (status.attempt_count || 0) + 1;
          const updatedStatus: WebhookStatus = {
            ...status,
            attempt_count: attemptCount,
            last_attempt_at: new Date().toISOString(),
            event_name: eventName
          };
          await redis.set(webhookKey, JSON.stringify(updatedStatus), { ex: ttlSeconds });
        }

        scope.setTag("attempt_count", String(attemptCount));
      } catch (redisError) {
        console.error("Redis error during webhook status check:", redisError);
        Sentry.captureException(redisError, scope);
        // Continue processing despite Redis error
      }
    }

    try {
      console.log(`[DISPATCH] id=${id} type=${eventName} attempt=${attemptCount}`);
      maybeCrash("entry.before_dispatch");
      await eventHandler.receive({
        id: id || "",
        name: eventName as "push" | "check_run" | "workflow_run" | "workflow_job" | "membership" | "organization",
        payload: body.detail
      });
      maybeCrash("entry.after_dispatch_before_complete");

      // Mark as completed in Redis
      if (redis) {
        try {
          const existingStatus = await redis.get(webhookKey);
          if (existingStatus) {
            const status =
              typeof existingStatus === "string"
                ? (JSON.parse(existingStatus) as WebhookStatus)
                : (existingStatus as WebhookStatus);
            const completedStatus: WebhookStatus = {
              ...status,
              completed: true,
              last_error: undefined
            };
            await redis.set(webhookKey, JSON.stringify(completedStatus), { ex: ttlSeconds });
          }
        } catch (redisError) {
          console.error("Redis error marking webhook complete:", redisError);
          Sentry.captureException(redisError, scope);
        }
      }
    } catch (err) {
      console.log(`Error processing webhook for ${eventName} id ${id}`);
      console.error(err);
      captureWebhookException(err, scope);

      // Log error in Redis
      if (redis) {
        try {
          const existingStatus = await redis.get(webhookKey);
          if (existingStatus) {
            const status =
              typeof existingStatus === "string"
                ? (JSON.parse(existingStatus) as WebhookStatus)
                : (existingStatus as WebhookStatus);
            const errorStatus: WebhookStatus = {
              ...status,
              last_error: (err as Error)?.message || "unknown error",
              last_attempt_at: new Date().toISOString()
            };
            await redis.set(webhookKey, JSON.stringify(errorStatus), { ex: ttlSeconds });
          }
        } catch (redisError) {
          console.error("Redis error logging webhook error:", redisError);
          Sentry.captureException(redisError, scope);
        }
      }

      return Response.json(
        {
          message: "Error processing webhook"
        },
        {
          status: 500
        }
      );
    }
    console.log(`Completed processing webhook for ${eventName} id ${id}`);
  } catch (err) {
    console.log(`Error processing webhook for ${eventName} id ${id}`);
    console.error(err);
    captureWebhookException(err, scope);
    return Response.json(
      {
        message: "Error processing webhook"
      },
      {
        status: 500
      }
    );
  }
  return Response.json({
    message: "Triggered webhook"
  });
});
