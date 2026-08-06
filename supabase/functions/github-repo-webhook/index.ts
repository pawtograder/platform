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
import micromatch from "npm:micromatch";
import safeRegex from "npm:safe-regex@2";
import { Buffer } from "node:buffer";
import { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import {
  getDefaultBranchHeadSha,
  getFileFromRepo,
  getOctoKit,
  triggerWorkflow,
  SecondaryRateLimitError,
  PrimaryRateLimitError,
  END_TO_END_REPO_PREFIX
} from "../_shared/GitHubWrapper.ts";
import { resolveEmptySubmissionVerdict } from "../_shared/emptySubmissionVerdict.ts";
import { isHandoutSyncPush } from "../_shared/handoutSyncPush.ts";
import {
  computeHandoutFileHashesForCommit,
  seedHandoutFileHashes,
  type HandoutHashCaches
} from "../_shared/handoutFileHashes.ts";
import { buildTooLargeErrorName } from "../_shared/tooLargeErrorName.ts";
import { GradedUnit, MutationTestUnit, PawtograderConfig, RegularTestUnit } from "../_shared/PawtograderYml.d.ts";
import { ingestPrSubmissionFiles } from "../_shared/PrSubmissionFiles.ts";
import { prStateFromPullRequest } from "../_shared/PrState.ts";
import {
  ingestSubmissionFilesFromRepo,
  SubmissionFileTooLargeError,
  SubmissionTooLargeError,
  MAX_FILE_SIZE_MB
} from "../_shared/SubmissionIngestion.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { createRedis, type RedisClient } from "../_shared/Redis.ts";
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
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("DENO_DEPLOYMENT_ID")!,
    sendDefaultPii: true,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}
const GRADER_WORKFLOW_PATH = ".github/workflows/grade.yml";

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

/**
 * Push-mode zero-runner submission creation.
 *
 * For a push-mode assignment with no autograder, every push is a complete
 * submission on its own — there is no grade.yml workflow to run. This creates
 * the submissions row directly (mirroring the column set the autograder uses, so
 * the existing BEFORE/AFTER-INSERT triggers assign ordinal/is_active and
 * provision the grading review) and ingests the repo's files via the shared
 * ingestion core. No repository_check_run and no triggerWorkflow dispatch.
 *
 * `submitted_via` is set to 'git' (the submissions_submitted_via_valid CHECK
 * allows 'git' | 'upload' | 'manual' | 'pr'; this is a git-push submission, the
 * same channel as the autograder path, which leaves it null). run_number /
 * run_attempt are 0 since there is no GitHub Actions run backing this.
 *
 * Due-date handling mirrors the autograder's core gate: compute the final due
 * date via calculate_final_due_date and, if the push is after it, skip creating
 * a submission — unless the commit is #NOT-GRADED and the assignment allows it.
 * (The autograder's late-token auto-apply / staff-bypass nuances rely on OIDC
 * actor + check-run context that the webhook doesn't have, and are intentionally
 * not replicated here.)
 *
 * Idempotent: re-delivery of the same push is a no-op if a submission already
 * exists for this (repository, sha).
 */
async function createPushDirectSubmission(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  opts: {
    allowNotGradedSubmissions: boolean;
    permitEmptySubmissions: boolean;
    scope: Sentry.Scope;
  }
): Promise<void> {
  const { allowNotGradedSubmissions, permitEmptySubmissions, scope } = opts;
  const headCommit = payload.head_commit;
  if (!headCommit) return; // guarded by caller, narrows the type
  const repoName = payload.repository.full_name;
  const sha = headCommit.id;
  const isNotGraded = headCommit.message.toUpperCase().includes("#NOT-GRADED");

  // Idempotency: a re-delivered webhook must not create a duplicate submission
  // for the same commit. (run_number/run_attempt are always 0 here, so
  // repository+sha uniquely identifies this push-direct submission.)
  const { data: existing, error: existingErr } = await adminSupabase
    .from("submissions")
    .select("id, grading_review_id, is_active, is_not_graded")
    .eq("repository", repoName)
    .eq("sha", sha)
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    Sentry.captureException(existingErr, scope);
    throw existingErr;
  }
  // A surviving row from a run whose cleanup ALSO failed is incomplete, not a
  // completed submission: returning here on redelivery meant ingestion and cleanup
  // were never retried, so a broken row could persist forever.
  //
  // The marker is a NULL grading_review_id, not a zero file count. Every completed
  // submission has a review, assigned by the AFTER-INSERT hook, whereas
  // cleanupPushDirectSubmission nulls it as its first step — so NULL means "cleanup
  // started and did not finish". File count cannot be used: a legitimately empty
  // submission has zero files (permit_empty_submissions=true, or the path where
  // empty detection is skipped for want of submissionFiles), and treating those as
  // incomplete would delete an ACCEPTED submission and its grading on redelivery.
  const existingIsIncomplete = existing !== null && existing.grading_review_id === null;
  if (existing && existingIsIncomplete) {
    scope.setTag("push_direct_incomplete_row_resumed", String(existing.id));
    console.log(
      `Found an incomplete push-direct submission ${existing.id} for ${repoName}@${sha} (no grading review); removing it and retrying`
    );
    const removed = await cleanupPushDirectSubmission(adminSupabase, existing.id, scope);
    if (!removed) {
      // Still cannot clear it — throw so GitHub retries rather than silently
      // leaving the student with a permanently fileless submission.
      throw new Error(
        `Could not remove the incomplete push-direct submission ${existing.id} for ${repoName}@${sha}; ` +
          `rejecting this delivery so GitHub retries it`
      );
    }
    await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, existing.id);
  } else if (existing) {
    scope.setTag("push_direct_submission_skipped", "already_exists");
    console.log(`Push-direct submission already exists for ${repoName}@${sha} (id=${existing.id}); skipping`);
    // A force-push BACK to an already-recorded commit is not a redelivery, and the sha-keyed
    // lookup cannot tell them apart. Student pushes A, then B, then force-pushes A again: this
    // branch is reached with A's submission already present but inactive, so treating it as a
    // duplicate left B active while the repository head — and the student's latest intent — is
    // A. The gradebook then grades code the student rolled back.
    //
    // The caller has verified that this sha IS the current head, which is exactly what makes
    // promotion correct here rather than a guess.
    if (existing.is_active === false) {
      await promoteSubmissionForCurrentHead(adminSupabase, studentRepo, existing, repoName, sha, scope);
      return;
    }
    // Before returning, make sure SOMETHING is active. A retained oversized rejection keeps
    // its grading review on purpose, so this branch is where a redelivery for that commit
    // lands — and if the reactivation that should have followed the rejection failed
    // transiently, the throw that asked for this redelivery could never repair anything: the
    // check above reads the retained row as complete and returned here. The student's last
    // valid submission then stayed inactive permanently.
    //
    // No exclusion is passed: reactivatePreviousSubmission already skips retained rejections
    // and returns untouched when a submission is already active, so this is a no-op on an
    // ordinary duplicate delivery and a repair on the one that needs it. It throws on
    // failure, which correctly asks for another delivery.
    await reactivatePreviousSubmission(adminSupabase, studentRepo, scope);
    return;
  }

  // The handout's recorded hashes cover only the configured submissionFiles, so build
  // the same matcher to compare like with like. Read BEFORE the submission is inserted:
  // this decides whether the emptiness check can run at all, and a failure here must not
  // cost an insert plus the trigger work that demotes the student's previous submission.
  const { data: graderConfigRow, error: graderConfigError } = await adminSupabase
    .from("autograder")
    .select("config")
    .eq("id", studentRepo.assignment_id)
    .maybeSingle();
  if (graderConfigError) {
    // Transient (statement timeout, pool exhaustion). Throwing makes GitHub redeliver,
    // which is the only way this push gets recorded. Returning or rejecting instead
    // would answer 200 and lose real student work with no retry.
    Sentry.captureException(graderConfigError, scope);
    throw graderConfigError;
  }
  const submissionFilesConfig = (graderConfigRow?.config as unknown as PawtograderConfig | null)?.submissionFiles;
  const expectedFilePatterns = submissionFilesConfig
    ? [...(submissionFilesConfig.files ?? []), ...(submissionFilesConfig.testFiles ?? [])]
    : [];
  // One compiled matcher for all files, rather than recompiling every glob per file.
  const expectedFileMatcher = expectedFilePatterns.length > 0 ? micromatch.matcher(expectedFilePatterns) : null;
  const emptyHashFilter = expectedFileMatcher ? (relativePath: string) => expectedFileMatcher(relativePath) : null;
  scope.setTag("empty_hash_filter_patterns", String(expectedFilePatterns.length));

  // With no submissionFiles globs there is nothing to narrow the empty-check hash to, so
  // the comparison would be over a different file set than the handout hashes and could
  // never be meaningful. Skip the check instead of rejecting: a repo-only assignment has
  // no reason to maintain a pawtograder.yml, so rejecting would silently discard every
  // push on the very assignments this path exists for. The instructor hand-grades these
  // submissions and can see an untouched repo for themselves.
  const canDetectEmpty = emptyHashFilter !== null;
  if (!canDetectEmpty) {
    scope.setTag("push_direct_empty_check", "skipped_no_submission_files");
    console.log(
      `Not checking emptiness for ${repoName}@${sha}: assignment ${studentRepo.assignment_id} has no ` +
        `submissionFiles configured, so there is no comparable handout hash`
    );
  }

  // Resolve a profile id for the due-date calculation. For group repos use any
  // member's profile (mirrors the autograder fallback).
  let profileId = studentRepo.profile_id;
  if (!profileId && studentRepo.assignment_group_id) {
    const { data: member } = await adminSupabase
      .from("assignment_groups_members")
      .select("profile_id")
      .eq("assignment_group_id", studentRepo.assignment_group_id)
      .limit(1)
      .maybeSingle();
    if (member) profileId = member.profile_id;
  }

  // Due-date gate (uses the same RPC the autograder uses).
  const { data: finalDueDateResult, error: dueDateError } = await adminSupabase.rpc("calculate_final_due_date", {
    assignment_id_param: studentRepo.assignment_id,
    // No resolvable profile (e.g. a group repo with no matched member): pass null, not a
    // bogus UUID — Postgres rejects a non-UUID string, whereas null already falls back to the
    // assignment's due_date via calculate_effective_due_date. The generated RPC type marks
    // this param required, but the underlying SQL `uuid` parameter is nullable, so narrow it.
    student_profile_id_param: (profileId || null) as string,
    assignment_group_id_param: studentRepo.assignment_group_id || undefined
  });
  if (dueDateError) {
    Sentry.captureException(dueDateError, scope);
    throw dueDateError;
  }
  // Gate on the webhook *receive* time, NOT head_commit.timestamp: the commit
  // timestamp is student-controllable (`git commit --date=...`), so a backdated
  // commit pushed after the deadline must not slip through. This matches the
  // autograder path, which gates on the check-run created_at (server time).
  const pushTime = new Date();
  const finalDueDate = new Date(finalDueDateResult);
  if (pushTime.getTime() > finalDueDate.getTime() && !(isNotGraded && allowNotGradedSubmissions)) {
    scope.setTag("push_direct_submission_skipped", "after_due_date");
    console.log(`Push-direct submission for ${repoName}@${sha} is after the due date; skipping`);
    return;
  }

  // Re-verify that this commit is STILL the repo head, immediately before the insert.
  //
  // The caller already checked, but everything between that check and here — the due-date RPC,
  // the grader config read, the profile lookup — is time in which push B can advance the branch
  // and have its own handler insert first. This delivery would then insert afterwards and the
  // BEFORE-INSERT trigger, which promotes by insertion order, would demote B and make the older
  // commit active. Re-reading here narrows the window from "everything above" to the insert
  // itself.
  //
  // Honest about the remainder: this does not serialize the two handlers, so a branch advance in
  // the final milliseconds can still interleave. Closing that completely needs a lock the
  // insert participates in (an RPC taking an advisory lock per repository), which is not worth
  // adding speculatively — a wrong active submission is recoverable by pushing again, and the
  // next push's delivery repairs it.
  try {
    const headBeforeInsert = await getDefaultBranchHeadSha(repoName, scope);
    if (headBeforeInsert && headBeforeInsert !== sha) {
      scope.setTag("push_direct_submission_skipped", "superseded_before_insert");
      console.log(
        `Skipping push-direct submission for ${repoName}@${sha}: the head advanced to ${headBeforeInsert} while ` +
          `this delivery was being prepared`
      );
      return;
    }
  } catch (headErr) {
    // Same reasoning as the caller's check: an unverifiable head must not be assumed current,
    // because guessing wrong silently changes which commit is graded. GitHub redelivers.
    scope.setTag("student_repo_head_recheck_failed", "true");
    Sentry.captureException(headErr, scope);
    throw new Error(
      `Could not re-confirm that ${sha} is the current head of ${repoName} before recording it ` +
        `(${headErr instanceof Error ? headErr.message : String(headErr)}); rejecting this delivery so GitHub ` +
        `retries it`
    );
  }

  // Create the submission row. Column set mirrors the autograder insert so the
  // BEFORE-INSERT trigger (ordinal/is_active) and AFTER-INSERT hook (grading
  // review) run identically. Do NOT set ordinal/is_active/grading_review_id.
  const { data: inserted, error: insertError } = await adminSupabase
    .from("submissions")
    .insert({
      profile_id: studentRepo.profile_id,
      assignment_group_id: studentRepo.assignment_group_id,
      assignment_id: studentRepo.assignment_id,
      repository: repoName,
      repository_id: studentRepo.id,
      sha,
      run_number: 0,
      run_attempt: 0,
      class_id: studentRepo.class_id,
      submitted_via: "git",
      is_not_graded: isNotGraded
    })
    .select("id")
    .single();
  if (insertError) {
    // 23505 = unique_violation: concurrent re-delivery won the race. Treat as
    // a no-op so we don't force GitHub to retry the whole delivery.
    if (insertError.code === "23505") {
      scope.setTag("push_direct_submission_insert_race", "true");
      return;
    }
    // 23514 = check_violation: the submissions insert trigger rejects an
    // individual submission when the student has since joined a group for this
    // assignment. Skip gracefully (the group repo's push handles submissions)
    // rather than throw + force endless webhook retries.
    if (insertError.code === "23514") {
      scope.setTag("push_direct_submission_skipped", "group_transition");
      console.log(`Push-direct submission for ${repoName}@${sha} rejected by group-transition check; skipping`);
      return;
    }
    Sentry.captureException(insertError, scope);
    throw insertError;
  }
  const submissionId = inserted.id;
  scope.setTag("submission_id", submissionId.toString());
  console.log(`Created push-direct submission ${submissionId} for ${repoName}@${sha}`);

  // E2E fast path: under E2E_MOCK_GITHUB an E2E student repo isn't a real GitHub
  // repo, so bypass the clone and write a single canned file (parallels the
  // PrSubmissionFiles / autograder-create-submission E2E mocks) so this push
  // path is end-to-end testable without GitHub.
  const e2eMock = Deno.env.get("E2E_MOCK_GITHUB") === "true" && repoName.startsWith(END_TO_END_REPO_PREFIX);
  if (e2eMock) {
    const mockContents = `// push-direct submission mock for ${repoName}@${sha}\n`;
    const { error: mockErr } = await adminSupabase.from("submission_files").insert({
      submission_id: submissionId,
      name: "Main.java",
      profile_id: studentRepo.profile_id,
      assignment_group_id: studentRepo.assignment_group_id,
      contents: mockContents,
      class_id: studentRepo.class_id,
      is_binary: false,
      file_size: mockContents.length
    });
    if (mockErr) {
      Sentry.captureException(mockErr, scope);
      throw mockErr;
    }
    return;
  }

  // Ingest the repo's files (whole tree; push-mode has no submissionFiles glob).
  // The insert above and this ingest are NOT in one transaction, so if ingest
  // fails we must clean up the just-created row — otherwise the idempotency
  // pre-check would return early on re-delivery and leave a permanent fileless
  // submission. Mirrors the autograder's reject-and-cleanup behavior.
  try {
    const ingestResult = await ingestSubmissionFilesFromRepo({
      adminSupabase,
      submissionId,
      classId: studentRepo.class_id,
      profileId: studentRepo.profile_id,
      groupId: studentRepo.assignment_group_id,
      repo: repoName,
      sha,
      // Compare the pushed tree against the assignment's recorded handout
      // versions, exactly as the Actions-backed path does. Without this, an
      // untouched starter-template push would become the newest active
      // submission on an assignment that prohibits empty submissions. Only
      // requested when the comparison can be made comparable (see canDetectEmpty).
      detectEmptyForAssignmentId: canDetectEmpty ? studentRepo.assignment_id : undefined,
      // Store the WHOLE tree (hand-grading wants the full repo) but compare only
      // the configured submissionFiles, because that is the set the handout hashes
      // cover. Without narrowing, the two hashes are computed over different file
      // sets and can never match, so emptiness would always read "not empty".
      emptyHashFilter: emptyHashFilter ?? undefined,
      scope
    });

    // Decided by a pure, unit-tested helper: `isEmpty === null` means two different
    // things (check never requested vs check failed) and conflating them previously
    // rejected and retried every push on repo-only assignments. See
    // _shared/emptySubmissionVerdict.ts for the truth table.
    const emptyVerdict = resolveEmptySubmissionVerdict({
      permitEmptySubmissions,
      canDetectEmpty,
      isEmpty: ingestResult.isEmpty
    });
    scope.setTag("push_direct_empty_verdict", emptyVerdict);
    // Only when there is a verdict to record. `is_empty_submission` is NOT NULL
    // DEFAULT false, so writing `false` for the no-verdict case (the common one on
    // a repo-only assignment, which has no submissionFiles) rewrites the value the
    // INSERT already stored - one round trip plus a full-row audit entry per push.
    if (ingestResult.isEmpty !== null) {
      const { error: emptyFlagError } = await adminSupabase
        .from("submissions")
        .update({ is_empty_submission: ingestResult.isEmpty })
        .eq("id", submissionId);
      if (emptyFlagError) {
        // Throw rather than log-and-continue: the catch below deletes the partial
        // submission and rethrows, so GitHub redelivers and we try again. Accepting
        // it would leave a submission whose empty-state metadata was never recorded.
        Sentry.captureException(emptyFlagError, scope);
        throw emptyFlagError;
      }
    }
    if (emptyVerdict !== "accept") {
      // "retry_unknown": the check ran and its handout-hash lookup failed after
      // retries — a transient DB problem, not a verdict. Throw so the shared catch
      // below cleans up and GitHub redelivers; returning 200 would acknowledge the
      // delivery and permanently lose a real, non-empty push.
      if (emptyVerdict === "retry_unknown") {
        scope.setTag("push_direct_submission_rejected", "empty_unknown");
        throw new Error(
          `Could not determine whether ${repoName}@${sha} is an empty submission (handout hash lookup failed); ` +
            `rejecting this delivery so GitHub retries it`
        );
      }
      scope.setTag("push_direct_submission_rejected", "empty");
      console.log(
        `Rejecting push-direct submission for ${repoName}@${sha}: matches the handout and this assignment does ` +
          `not permit empty submissions`
      );
      const removed = await cleanupPushDirectSubmission(adminSupabase, submissionId, scope);
      // Restore the previous submission whether or not cleanup finished. The insert
      // already demoted it, so skipping this on a partial failure leaves the student
      // with NO active submission — a worse outcome than the rejection itself.
      // `excludeSubmissionId` keeps a surviving zombie row from being promoted.
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, submissionId);
      if (!removed) {
        // The rejected submission row is still there (inactive, with its grading review
        // unlinked), so it needs manual cleanup. Surface it rather than returning 200 as
        // though the rejection worked.
        scope.setTag("push_direct_empty_cleanup_failed", "true");
        Sentry.captureMessage(
          `Failed to remove rejected empty push-direct submission ${submissionId} for ${repoName}@${sha}`,
          scope
        );
        // Throw rather than return 200. cleanupPushDirectSubmission unlinks the grading
        // review before deleting, so a partial failure leaves exactly the row shape the
        // idempotency check at the top of this function reads as "resume me" — but only a
        // redelivery ever re-runs that check, and a 200 gives GitHub no reason to send
        // one. Acknowledging here would strand the row permanently.
        scope.setTag("push_direct_retry_reason", "empty_cleanup_incomplete");
        throw new Error(
          `Rejected empty push-direct submission ${submissionId} for ${repoName}@${sha} could not be removed; ` +
            `rejecting this delivery so GitHub retries it`
        );
      }
      return;
    }
  } catch (ingestErr) {
    const isTooLarge = ingestErr instanceof SubmissionTooLargeError || ingestErr instanceof SubmissionFileTooLargeError;
    // For an oversized push we KEEP the submission row, deactivated, so the student
    // has something to see. Deleting it left them with no history entry, no failing
    // check (this path creates none by design) and no reachable error — the push
    // simply looked accepted. An inactive row with its review intact cannot be graded
    // but does appear in submission history, and the workflow_run_error below can
    // attach to it, which is the only surface a student can actually reach.
    //
    // Its review link is deliberately left in place: a NULL grading_review_id is the
    // marker for "cleanup started and did not finish", and nulling it here would make
    // a redelivery treat this deliberate row as junk to be deleted and re-ingested.
    const removed = isTooLarge
      ? await deactivateRejectedSubmission(adminSupabase, submissionId, scope)
      : await cleanupPushDirectSubmission(adminSupabase, submissionId, scope);
    // Restoration now throws on failure. Capture it separately so it neither masks
    // ingestErr in Sentry nor silently turns a permanent rejection into a success:
    // a failed restoration must force a retry even for too_large, because the
    // student is otherwise left with no active submission. Redelivery converges —
    // the rejected row is already gone, so each retry re-runs the path and gets
    // another chance to restore, and stops retrying once restoration succeeds.
    let reactivateErr: unknown;
    try {
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, submissionId);
    } catch (e) {
      reactivateErr = e;
      Sentry.captureException(ingestErr, scope);
    }
    if (!removed) {
      // Returning 200 here gave GitHub no reason to redeliver, so the incomplete row
      // stayed forever — with the oversized error recorded unattached and therefore
      // invisible to the student. The incomplete marker is only useful if something
      // comes back for it, so force a retry. Deferred until after the error recording
      // below so the explanation is written first.
      scope.setTag("push_direct_cleanup_failed", "true");
      Sentry.captureMessage(
        `Failed to remove partial push-direct submission ${submissionId} for ${repoName}@${sha}`,
        scope
      );
    }
    if (isTooLarge) {
      // Permanent (repo/file too big): record it here, BEFORE the reactivation
      // rethrow below. Recording after that rethrow meant an unrelated restoration
      // failure suppressed the record entirely and turned a delivery that can never
      // succeed into an unbounded retry loop that re-clones an oversized repo each
      // time. The upsert is idempotent on (repository_id, run_number, run_attempt,
      // name), so writing it before a retry is safe.
      scope.setTag("push_direct_submission_rejected", "too_large");
      Sentry.captureException(ingestErr, scope);
      // Attached to the retained submission, which is what makes it student-visible:
      // workflow_run_error's student RLS branch requires submission_id IS NOT NULL and
      // the student-facing reader embeds it through `submissions`.
      // The commit is part of the message deliberately. The upsert key is
      // (repository_id, run_number, run_attempt, name) and every push-direct submission
      // uses 0/0, so two oversized pushes with the same message — same filename, same
      // size — collided: the second upsert moved the single row's submission_id to the
      // newer submission and left the earlier rejection in history with no explanation.
      // Naming the commit makes the key unique per push and tells the student which push
      // was rejected.
      const shortSha = sha.slice(0, 7);
      // `name` is CHECK (length <= 500) — workflow_run_error_name_length, from
      // 20250801174131. A deeply nested path pushed the file-too-large message past that,
      // and because the message is deterministic, the upsert failed identically on every
      // retry: the retained row was cleaned up each time and the student never received the
      // rejection at all. buildTooLargeErrorName shortens the PATH rather than the sentence,
      // from the middle, so the leading directories and the file name itself both survive —
      // those are what identify the file to the student. It lives in _shared with tests
      // because the invariant is a length bound, which is only meaningful if something checks
      // it. The untruncated path is recorded in `data` below.
      const tooLargeMessage =
        ingestErr instanceof SubmissionFileTooLargeError
          ? buildTooLargeErrorName({
              kind: "file_too_large",
              shortSha,
              fileName: ingestErr.fileName,
              fileSize: ingestErr.fileSize,
              perFileLimitMb: MAX_FILE_SIZE_MB
            })
          : buildTooLargeErrorName({
              kind: "submission_too_large",
              shortSha,
              observedMb: ingestErr.observedMb,
              limitMb: ingestErr.limitMb
            });
      const { error: recordError } = await adminSupabase.from("workflow_run_error").upsert(
        {
          repository_id: studentRepo.id,
          class_id: studentRepo.class_id,
          submission_id: removed ? submissionId : null,
          // No Actions run backs a push-direct submission, so 0/0 mirrors what the
          // submissions rows use for this path.
          run_number: 0,
          run_attempt: 0,
          name: tooLargeMessage,
          is_private: false,
          data: {
            repository_name: repoName,
            sha,
            error_type: ingestErr instanceof SubmissionFileTooLargeError ? "file_too_large" : "submission_too_large",
            // The FULL path, since the one in `name` may have been shortened to fit the
            // length constraint. `data` is jsonb with no such limit.
            ...(ingestErr instanceof SubmissionFileTooLargeError
              ? { file_name: ingestErr.fileName, file_size: ingestErr.fileSize }
              : { observed_mb: ingestErr.observedMb, limit_mb: ingestErr.limitMb }),
            detected_at: new Date().toISOString()
          }
        },
        { onConflict: "repository_id,run_number,run_attempt,name" }
      );
      if (recordError) {
        // Do NOT acknowledge the delivery. Without this record the retained row is a
        // bare inactive submission with no explanation — the exact silent state
        // retaining it was meant to replace. And a redelivery could not repair it: the
        // idempotency pre-check sees the retained row's non-null grading_review_id,
        // reads it as complete, and returns before reaching this upsert.
        //
        // So drop the retained row and retry from scratch. Either the student gets a
        // row WITH its explanation, or there is no row and the delivery is retried —
        // never a row without an explanation.
        scope.setTag("too_large_record_failed", "true");
        Sentry.captureException(recordError, scope);
        await cleanupPushDirectSubmission(adminSupabase, submissionId, scope);
        await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, submissionId);
        throw new Error(
          `Could not record the oversized-submission error for ${repoName}@${sha} (${recordError.message}); ` +
            `rejecting this delivery so GitHub retries it`
        );
      }
    }
    if (reactivateErr) {
      scope.setTag("push_direct_retry_reason", "reactivate_failed");
      throw reactivateErr;
    }
    if (!removed) {
      // The row is neither properly retained (too_large) nor removed (everything else),
      // so it is in a state nothing else will come back for. The explanation has been
      // recorded above where applicable; now force the redelivery that the incomplete
      // marker exists to be repaired by.
      scope.setTag("push_direct_retry_reason", "cleanup_incomplete");
      throw new Error(
        `Push-direct submission ${submissionId} for ${repoName}@${sha} could not be cleaned up or retained; ` +
          `rejecting this delivery so GitHub retries it`
      );
    }
    if (isTooLarge) {
      // Stop here: don't make GitHub retry a delivery that can never succeed.
      return;
    }
    // Transient (clone/storage/db): rethrow so GitHub redelivers. Cleanup above
    // means the retry starts fresh rather than short-circuiting on a stub row.
    throw ingestErr;
  }
}

// Best-effort cleanup of a push-direct submission whose file ingest failed:
// remove any uploaded binary objects, then the file rows, then the submission.
/**
 * Re-activate the newest surviving submission for this student/group after a
 * rejected submission is deleted.
 *
 * The submissions BEFORE-INSERT trigger demotes the previous active row when a
 * new one arrives, and `submissions_one_active_individual_per_student` /
 * `submissions_one_active_group_per_group` allow only one active row. So deleting
 * a rejected submission leaves the student with NO active submission — their
 * previous good work disappears from the gradebook and review flows until they
 * push again.
 */
/**
 * Make an already-recorded submission active again because its commit is the repo head.
 *
 * Reached when a student force-pushes back to a commit that already has a submission. The
 * (repository, sha) idempotency lookup reads that as a redelivery, so without this the NEWER
 * submission stays active while the head is the older commit — the gradebook grades code the
 * student rolled back.
 *
 * Refuses in the two cases where an inactive row is inactive ON PURPOSE:
 *   - is_not_graded: the student asked for it not to be graded.
 *   - a retained oversized rejection: it was refused and was never ingested, so promoting it
 *     would make an empty submission the graded one.
 *
 * Demotes before promoting, since submissions_one_active_* permits only one active row.
 */
async function promoteSubmissionForCurrentHead(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  existing: { id: number; is_not_graded: boolean | null },
  repoName: string,
  sha: string,
  scope: Sentry.Scope
): Promise<void> {
  if (existing.is_not_graded) {
    scope.setTag("force_push_promote_skipped", "is_not_graded");
    return;
  }
  const { data: rejectionErrors, error: rejectionErr } = await adminSupabase
    .from("workflow_run_error")
    .select("submission_id, data")
    .eq("submission_id", existing.id);
  if (rejectionErr) throw rejectionErr;
  const wasRejected = (rejectionErrors ?? []).some((e) => {
    const errorType = (e.data as { error_type?: string } | null)?.error_type;
    return errorType === "file_too_large" || errorType === "submission_too_large";
  });
  if (wasRejected) {
    scope.setTag("force_push_promote_skipped", "retained_rejection");
    return;
  }

  // Demote the current active row for this submitter first. Scoped exactly like the unique
  // indexes: the group for a group repo, the individual otherwise.
  let demote = adminSupabase
    .from("submissions")
    .update({ is_active: false })
    .eq("assignment_id", studentRepo.assignment_id)
    .eq("is_active", true)
    .neq("id", existing.id);
  demote = studentRepo.assignment_group_id
    ? demote.eq("assignment_group_id", studentRepo.assignment_group_id)
    : demote.eq("profile_id", studentRepo.profile_id!).is("assignment_group_id", null);
  const { error: demoteErr } = await demote;
  if (demoteErr) throw demoteErr;

  const { error: promoteErr } = await adminSupabase
    .from("submissions")
    .update({ is_active: true })
    .eq("id", existing.id);
  if (promoteErr) {
    // Nothing is active now, since the demotion succeeded. Throwing asks GitHub to redeliver,
    // and this branch is idempotent, so the retry re-promotes.
    scope.setTag("force_push_promote_failed", "true");
    Sentry.captureException(promoteErr, scope);
    throw promoteErr;
  }
  scope.setTag("force_push_promoted_submission", String(existing.id));
  console.log(`Re-activated submission ${existing.id}: ${repoName} was force-pushed back to ${sha}`);
}

/** Page size for the paginated candidate scan in reactivatePreviousSubmission. */
const PAGE_SIZE = 50;

async function reactivatePreviousSubmission(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  scope: Sentry.Scope,
  /**
   * The submission being rejected. Excluded from the search because cleanup can fail
   * partway, and promoting the row we just rejected would be worse than doing nothing.
   */
  excludeSubmissionId?: number
): Promise<void> {
  try {
    // Built fresh per page rather than once: a postgrest builder is mutable and returns
    // itself, so reusing one across the paginated loop below would accumulate modifiers.
    const candidatePage = (offset: number) => {
      let base = adminSupabase
        .from("submissions")
        .select("id, is_active, ordinal")
        .eq("assignment_id", studentRepo.assignment_id)
        // #NOT-GRADED rows are deliberately left inactive by the insert trigger, so
        // promoting one would activate a submission the student asked not to be
        // graded. Only ever restore a gradeable submission.
        .eq("is_not_graded", false);
      if (excludeSubmissionId !== undefined) {
        base = base.neq("id", excludeSubmissionId);
      }
      // Scope to the same submitter the unique indexes key on: the group when this
      // is a group repo, otherwise the individual (group id explicitly NULL).
      const scoped = studentRepo.assignment_group_id
        ? base.eq("assignment_group_id", studentRepo.assignment_group_id)
        : base.eq("profile_id", studentRepo.profile_id!).is("assignment_group_id", null);
      return scoped.order("ordinal", { ascending: false }).range(offset, offset + PAGE_SIZE - 1);
    };

    // Several candidates, not one. A push-direct submission rejected as oversized is
    // RETAINED as an inactive history row (see deactivateRejectedSubmission), and it is
    // gradeable-looking: is_not_graded is false, its grading review is intact, and it has
    // the highest ordinal. Taking the top row alone therefore promoted a rejection —
    // either violating submissions_one_active_* when the student's real submission was
    // still active (throwing, so the webhook retried forever), or making code that was
    // never ingested the active submission when nothing else was.
    //
    // Paginated, NOT a fixed window. A first attempt took the newest 20 rows and gave up
    // if all of them were rejections — but a student who accumulates 20 oversized
    // rejections above an older valid submission would then have that submission demoted
    // by the 21st rejected push and never restored, so their last good work disappears
    // from the gradebook while still existing. Walk backwards until a promotable row is
    // found or the rows run out.
    let newest: { id: number; is_active: boolean | null; ordinal: number } | undefined;
    for (let offset = 0; newest === undefined; offset += PAGE_SIZE) {
      const { data: candidates, error: newestErr } = await candidatePage(offset);
      if (newestErr) throw newestErr;
      if (!candidates || candidates.length === 0) return;

      // A retained rejection is identified by the oversized workflow_run_error attached to
      // it. That row is what makes the retention student-visible, and it is written before
      // the submission is deactivated, so its presence is a durable marker rather than a
      // race.
      const { data: rejectionErrors, error: rejectionErr } = await adminSupabase
        .from("workflow_run_error")
        .select("submission_id, data")
        .in(
          "submission_id",
          candidates.map((c) => c.id)
        );
      if (rejectionErr) throw rejectionErr;
      const rejectedIds = new Set(
        (rejectionErrors ?? [])
          .filter((e) => {
            const errorType = (e.data as { error_type?: string } | null)?.error_type;
            return errorType === "file_too_large" || errorType === "submission_too_large";
          })
          .map((e) => e.submission_id)
      );
      newest = candidates.find((c) => !rejectedIds.has(c.id));
      // A short page is the last page: every row was a rejection and there are no more.
      if (newest === undefined && candidates.length < PAGE_SIZE) return;
    }
    // Nothing left to promote, or something is already active (the unique indexes
    // guarantee at most one, so leave it alone).
    if (!newest || newest.is_active) return;

    const { error: promoteErr } = await adminSupabase
      .from("submissions")
      .update({ is_active: true })
      .eq("id", newest.id);
    if (promoteErr) throw promoteErr;
    scope.setTag("reactivated_previous_submission", String(newest.id));
    console.log(`Re-activated submission ${newest.id} after rejecting a push-direct submission`);
  } catch (e) {
    // NOT best-effort. Swallowing this left the student with no active submission at
    // all — the insert had already demoted their previous one — while the caller
    // returned 200, so GitHub never retried and nothing repaired it. Their last good
    // work simply vanished from the gradebook. Rethrow so the delivery is retried:
    // the rejected submission is already deleted, so a redelivery re-runs the whole
    // path cleanly and gets another chance to restore the prior row.
    scope.setTag("reactivate_previous_submission_failed", "true");
    Sentry.captureException(e, scope);
    throw e;
  }
}

/**
 * Retain a rejected push-direct submission as a visible, ungradeable record.
 *
 * Used for permanent rejections (an oversized repo or file) where the student needs to
 * SEE why their push was not accepted. Deleting the row left them with nothing: this
 * path creates no Actions run and no check run, so a rejected push was
 * indistinguishable from one that worked.
 *
 * Deactivates the row and clears any files already written, but deliberately keeps
 * `grading_review_id`: that column being NULL is the marker for "cleanup started and
 * did not finish", so nulling it here would make a later redelivery mistake this
 * intentional record for junk and delete it.
 *
 * Returns whether the row is in the intended state, so the caller knows if it can
 * attach a workflow_run_error to it.
 */
async function deactivateRejectedSubmission(
  adminSupabase: SupabaseClient<Database>,
  submissionId: number,
  scope: Sentry.Scope
): Promise<boolean> {
  try {
    const { data: bins, error: binsErr } = await adminSupabase
      .from("submission_files")
      .select("storage_key")
      .eq("submission_id", submissionId)
      .eq("is_binary", true);
    // Destructuring only `data` turned a failed lookup into `bins === null`, which then
    // skipped storage removal and deleted the rows anyway — orphaning blobs whose keys
    // those rows were the only record of. Checking the removal result is not enough if
    // the lookup that produced the keys is unchecked.
    if (binsErr) throw binsErr;
    const keys = (bins ?? []).map((b) => b.storage_key).filter((k): k is string => !!k);
    if (keys.length > 0) {
      // Check the result and abort BEFORE deleting the rows, as
      // cleanupPushDirectSubmission does. The submission_files rows are the only record
      // of these storage keys, so removing them after a failed storage delete orphans
      // the blobs permanently with nothing left to find them by.
      const { error: storageErr } = await adminSupabase.storage.from("submission-files").remove(keys);
      if (storageErr) throw storageErr;
    }
    const { error: filesErr } = await adminSupabase.from("submission_files").delete().eq("submission_id", submissionId);
    if (filesErr) throw filesErr;

    const { error: deactivateErr } = await adminSupabase
      .from("submissions")
      .update({ is_active: false })
      .eq("id", submissionId);
    if (deactivateErr) throw deactivateErr;
    scope.setTag("rejected_submission_retained", String(submissionId));
    return true;
  } catch (e) {
    scope.setTag("deactivate_rejected_submission_failed", "true");
    Sentry.captureException(e, scope);
    // Leave the row in the INCOMPLETE state so a redelivery retries it. Keeping
    // grading_review_id populated is right only once the row is safely inactive; if we
    // failed before that, the row is still ACTIVE and would read as a complete
    // submission — so the redelivery would return early and an oversized push could
    // stay the student's active submission indefinitely. Nulling the review is exactly
    // the marker the idempotency pre-check looks for.
    const { error: markErr } = await adminSupabase
      .from("submissions")
      .update({ grading_review_id: null, is_active: false })
      .eq("id", submissionId);
    if (markErr) {
      scope.setTag("mark_rejected_submission_incomplete_failed", "true");
      Sentry.captureException(markErr, scope);
    }
    return false;
  }
}

async function cleanupPushDirectSubmission(
  adminSupabase: SupabaseClient<Database>,
  submissionId: number,
  scope: Sentry.Scope
): Promise<boolean> {
  try {
    // Break the submissions -> submission_reviews reference FIRST. The submissions
    // AFTER-INSERT hook provisions a grading review and points
    // submissions.grading_review_id at it, so deleting the submission row while
    // that reference stands is rejected by the FK — leaving the submission in
    // place. Mirrors safeCleanupRejectedSubmission in autograder-create-submission.
    const { error: unlinkErr } = await adminSupabase
      .from("submissions")
      .update({ grading_review_id: null, is_active: false })
      .eq("id", submissionId);
    if (unlinkErr) throw unlinkErr;

    const { error: reviewsErr } = await adminSupabase
      .from("submission_reviews")
      .delete()
      .eq("submission_id", submissionId);
    if (reviewsErr) throw reviewsErr;

    const { data: bins, error: binsErr } = await adminSupabase
      .from("submission_files")
      .select("storage_key")
      .eq("submission_id", submissionId)
      .eq("is_binary", true);
    if (binsErr) throw binsErr;
    const keys = (bins ?? []).map((b) => b.storage_key).filter((k): k is string => !!k);
    if (keys.length > 0) {
      // Abort on a storage failure rather than deleting the rows anyway: the rows are the
      // only record of these object keys, so dropping them would orphan the blobs
      // permanently. Mirrors safeCleanupRejectedSubmission.
      const { error: storageErr } = await adminSupabase.storage.from("submission-files").remove(keys);
      if (storageErr) throw storageErr;
    }
    const { error: filesErr } = await adminSupabase.from("submission_files").delete().eq("submission_id", submissionId);
    if (filesErr) throw filesErr;

    const { error: subErr } = await adminSupabase.from("submissions").delete().eq("id", submissionId);
    if (subErr) throw subErr;
    return true;
  } catch (cleanupErr) {
    Sentry.captureException(cleanupErr, scope);
    return false;
  }
}

type GitHubCommit = PushEvent["commits"][number];

/**
 * Record one pushed commit in `repository_check_runs`.
 *
 * These rows are the commit history the student and staff UIs read
 * (`CommitHistoryDialog`, `staff-commit-history`), independently of whether any
 * GitHub Actions run is ever attached to them - `check_run_id` stays null until
 * one is. Shared by the Actions path and the push-direct path so a repo-only
 * assignment still has a commit history.
 *
 * Idempotent: a row already present for this repo+sha is left alone, and a
 * concurrent delivery losing the UNIQUE (repository_id, sha) race is a no-op.
 */
async function recordCommitCheckRun(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  commit: GitHubCommit,
  pusherName: string,
  scope: Sentry.Scope
): Promise<void> {
  const { data: existing, error: existingErr } = await adminSupabase
    .from("repository_check_runs")
    .select("id")
    .eq("repository_id", studentRepo.id)
    .eq("sha", commit.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    console.error(existingErr);
    scope.setTag("error_source", "repository_check_run_lookup_failed");
    scope.setTag("error_context", "Error checking existing repository_check_runs");
    Sentry.captureException(existingErr, scope);
    throw existingErr;
  }
  if (existing && existing.id) {
    return;
  }

  const status: ExtendedCheckRunStatus = {
    created_at: new Date().toISOString(),
    commit_author: commit.author.name,
    commit_date: commit.timestamp,
    created_by: "github push by " + pusherName
  };
  const { error: checkRunError } = await adminSupabase.from("repository_check_runs").insert({
    repository_id: studentRepo.id,
    check_run_id: null,
    class_id: studentRepo.class_id,
    assignment_group_id: studentRepo.assignment_group_id,
    commit_message: commit.message,
    sha: commit.id,
    profile_id: studentRepo.profile_id,
    status: status as unknown as Json
  });
  if (checkRunError) {
    // 23505 = unique_violation. With UNIQUE (repository_id, sha) the
    // SELECT-then-INSERT pattern above has a race window: concurrent webhook
    // deliveries for the same commit can both pass the SELECT, then one wins
    // the INSERT and the other returns 23505. Treat that as a no-op so we
    // don't throw and force GitHub to retry the whole delivery.
    if (checkRunError.code === "23505") {
      scope.setTag("repository_check_run_insert_race", "true");
      return;
    }
    console.error(checkRunError);
    scope.setTag("error_source", "repository_check_run_insert_failed");
    scope.setTag("error_context", "Could not create repository_check_run");
    Sentry.captureException(checkRunError, scope);
    throw checkRunError;
  }
}

async function handlePushToStudentRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  scope: Sentry.Scope
) {
  scope.setTag("webhook_handler", "push_to_student_repo");
  scope.setTag("repository", payload.repository.full_name);
  scope.setTag("assignment_id", studentRepo.assignment_id.toString());
  scope.setTag("class_id", studentRepo.class_id.toString());
  scope.setTag("commits_count", payload.commits.length.toString());

  console.log(`Handling push to student repo ${payload.repository.full_name}, ref: ${payload.ref}`);

  // pr-mode guard: when this repo's assignment takes submissions as pull requests
  // (submission_mode='pr'), a push to the fork's main is NOT a submission and
  // must not create a check run or dispatch grade.yml — the PR webhook handles
  // submissions. Skip rather than spin up a grading workflow.
  // Also load has_autograder + due-date inputs for the push-mode zero-runner
  // path below (a push-mode assignment with no autograder creates the
  // submission directly here instead of dispatching grade.yml).
  // Named columns, not `*`: this query runs on EVERY push delivery for every student repo,
  // and `assignments` carries an unbounded `description` body that nothing here reads.
  // Naming them also keeps the column dependency visible to a rename.
  const { data: pushAssignment, error: pushAssignmentErr } = await adminSupabase
    .from("assignments")
    .select(
      "id, submission_mode, has_autograder, repo_mode, allow_not_graded_submissions, permit_empty_submissions, latest_template_sha"
    )
    .eq("id", studentRepo.assignment_id)
    .maybeSingle();
  if (pushAssignmentErr) {
    Sentry.captureException(pushAssignmentErr, scope);
    throw pushAssignmentErr;
  }
  if (pushAssignment?.submission_mode === "pr") {
    scope.setTag("skipped_reason", "pr_mode_assignment");
    console.log(`Skipping push handling for ${payload.repository.full_name}: assignment is pr-mode`);
    return;
  }

  //Get the repo name from the payload
  const repoName = payload.repository.full_name;
  if (payload.ref.includes("refs/tags/pawtograder-submit/")) {
    // If we make a #submit commit or otherwise create a submission, it will trigger creating the tag, so don't do anything on the tag push.
    return;
  }
  if (!payload.head_commit) {
    console.error("No head commit found in payload");
    scope.setTag("error_source", "no_head_commit");
    scope.setTag("error_context", "No head commit found in payload");
    Sentry.captureException(new Error("No head commit found in payload"), scope);
    return;
  }
  console.log(`Received push for ${repoName}, message: ${payload.head_commit.message}`);

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
  // Also guarded: `repo_mode` must still be a repo mode. Switching an existing
  // assignment to none/no_submission coerces has_autograder=false but leaves the
  // old `repositories` rows behind, and a later push to one of those would
  // otherwise be recorded as a git submission for an upload-only assignment.
  const pushRepoModeHasRepo = pushAssignment?.repo_mode !== "none" && pushAssignment?.repo_mode !== "no_submission";
  // A mode with no repository must skip the ACTIONS path below as well, not just the
  // push-direct branch. Guarding only the branch meant a `#submit` push to one of those
  // leftover repos fell through, dispatched its stale grade.yml and stamped
  // workflow_triggered_at — which autograder-create-submission reads as a pre-disable
  // in-flight dispatch and therefore admits, producing an Actions-backed submission for an
  // assignment that has neither a repository nor an autograder. `pushAssignment` null (no
  // matching assignment) is left alone: that is a different case with its own handling
  // below.
  if (pushAssignment && !pushRepoModeHasRepo) {
    scope.setTag("skipped_reason", "assignment_repo_mode_has_no_repo");
    console.log(
      `Skipping push handling for ${repoName}@${payload.after}: assignment ${pushAssignment.id} is ` +
        `repo_mode=${pushAssignment.repo_mode}, so this repository is a leftover from a previous mode`
    );
    return;
  }
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
      return;
    }
    // The `repositories` row is inserted BEFORE createRepo runs, so GitHub's
    // initial branch push for a freshly generated repo can arrive while the row
    // is still is_github_ready=false. That push is the starter template, not
    // student work — recording it would make the handout the student's active
    // submission before they have written a line.
    if (!studentRepo.is_github_ready) {
      scope.setTag("skipped_reason", "repo_not_github_ready");
      console.log(`Skipping push-direct submission for ${repoName}@${payload.after}: repo is still being provisioned`);
      return;
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
    // What is lost is a history entry for an intermediate commit, which is what the behaviour
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
    await createPushDirectSubmission(adminSupabase, payload, studentRepo, {
      allowNotGradedSubmissions: pushAssignment.allow_not_graded_submissions ?? false,
      permitEmptySubmissions: pushAssignment.permit_empty_submissions ?? false,
      scope
    });
    // Record the commit history too. This branch returns instead of falling through
    // to the Actions path's loop, and that loop is what populates
    // `repository_check_runs` - the table CommitHistoryDialog and staff-commit-history
    // read. While the push-direct path required `#submit`, ordinary pushes still fell
    // through and were recorded; now that every push takes this branch, skipping it
    // would leave the commit history permanently empty on exactly the assignments
    // this feature is for. No workflow is dispatched: that stays below, behind
    // `#submit`, on the has_autograder=true path.
    for (const commit of payload.commits) {
      await recordCommitCheckRun(adminSupabase, studentRepo, commit, payload.pusher.name, scope);
    }
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

    await recordCommitCheckRun(adminSupabase, studentRepo, commit, payload.pusher.name, scope);

    // If the workflow file was deleted in this commit, skip triggering - the workflow would fail anyway
    const removedInCommit = commit.removed.includes(GRADER_WORKFLOW_PATH);
    if (removedInCommit) {
      return;
    }
  }
  if (payload.head_commit.message.includes("#submit")) {
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
        await triggerWorkflow(repoName, payload.head_commit.id, "grade.yml");
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
            Sentry.captureException(error, scope);
            console.error(error);
          }
        })
      );
      scope?.setTag("updated_autograders_count", autograders.length.toString());
    } catch (err) {
      // Don't fail the whole webhook if pawtograder.yml is missing/malformed —
      // log it and continue so we still update the latest_autograder_sha below.
      scope?.setTag("error_source", "pawtograder_yml_reconcile_failed");
      scope?.setTag("yml_touched_in_push", ymlTouched.toString());
      console.error("Failed to reconcile pawtograder.yml", err);
      Sentry.captureException(err, scope);
    }
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
      // exactly the behaviour that existed before it.
      scope?.setTag("template_head_lookup_failed", "true");
      Sentry.captureException(headErr, scope);
    }
  }
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
      // Don't fail the whole webhook if grade.yml is missing — log and continue
      // so latest_template_sha still gets updated below.
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
    const { error: assignmentUpdateError } = isStaleDelivery
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
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
      );
      console.log(`[PUSH] repo=${repoName}`);
      //Is it a student repo?
      const { data: studentRepo, error: studentRepoError } = await adminSupabase
        .from("repositories")
        .select("*")
        .eq("repository", repoName)
        .maybeSingle();
      if (studentRepoError) {
        console.error(studentRepoError);
        scope.setTag("error_source", "student_repo_lookup_failed");
        scope.setTag("error_context", "Error getting student repo");
        Sentry.captureException(studentRepoError, scope);
        throw studentRepoError;
      }
      if (studentRepo) {
        // Compare against the repo's ACTUAL default branch, not a hardcoded "main".
        // For no-autograder assignments this webhook is the only thing that creates
        // submissions, so a repo whose default branch is `master` (or anything else)
        // had every push silently ignored. Actions-backed repos survived the
        // hardcoding because the workflow could still call autograder-create-submission.
        // Falls back to "main" when the payload omits default_branch.
        const defaultBranch = payload.repository?.default_branch || "main";
        if (payload.ref !== `refs/heads/${defaultBranch}`) {
          scope.setTag("skipped_reason", "not_default_branch");
          scope.setTag("repo_default_branch", defaultBranch);
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
    Sentry.captureException(err, scope);
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
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
        );
        const checkRun = await adminSupabase
          .from("repository_check_runs")
          .select("*")
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
              await triggerWorkflow(payload.repository.full_name, payload.check_run.head_sha, "grade.yml");
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
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
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
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
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
        .select("class_id")
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
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );

    try {
      const repoFullName = payload.repository.full_name;

      // Find the repository in our database
      const { data: repo, error: repoError } = await adminSupabase
        .from("repositories")
        .select("id, synced_handout_sha, desired_handout_sha")
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
      // otherwise fall back to the short SHA (handles edge cases)
      const syncedSha = repo.desired_handout_sha?.startsWith(shortSha) ? repo.desired_handout_sha : shortSha;

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
          sync_data: {
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

Deno.serve(async (req) => {
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
      Sentry.captureException(err, scope);

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
    Sentry.captureException(err, scope);
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
