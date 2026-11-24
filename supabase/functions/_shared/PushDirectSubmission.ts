/**
 * Push-direct submissions: the submission a push to a push-mode, no-autograder assignment
 * becomes, created straight from the webhook with no Actions run behind it.
 *
 * Shared by github-repo-webhook and forgejo-repo-webhook. Each webhook decides whether a push is a
 * submission at all (default branch, repository readiness, handout syncs, staff pushes, superseded
 * deliveries), then calls `createPushDirectSubmission` with a `PushDirectPush` that carries what
 * differs between the hosts: where the head sha comes from, the push time, and which host the
 * files are downloaded from. Everything after that (deadline and late tokens, idempotency on a
 * redelivered sha, empty and oversized rejections, restoring the previous active submission) is
 * the same on both.
 *
 * Error messages below say "GitHub retries it" because this code was written for GitHub's webhook,
 * which EventBridge redelivers. On Forgejo the same throw answers 500, which Forgejo shows as a
 * failed delivery that staff can redeliver from the hook's settings.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import micromatch from "npm:micromatch";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { resolveEmptySubmissionVerdict } from "./emptySubmissionVerdict.ts";
import { END_TO_END_REPO_PREFIX } from "./GitHubWrapper.ts";
import type { PawtograderConfig } from "./PawtograderYml.d.ts";
import { type GitProviderName, ilikeLiteral } from "./RepoPush.ts";
import {
  ingestSubmissionFilesFromRepo,
  MAX_FILE_SIZE_MB,
  SubmissionFileTooLargeError,
  SubmissionTooLargeError
} from "./SubmissionIngestion.ts";
import type { Database } from "./SupabaseTypes.d.ts";
import { buildTooLargeErrorName } from "./tooLargeErrorName.ts";

type RepositoryRow = Database["public"]["Tables"]["repositories"]["Row"];

/** The push being recorded, in the terms both hosts can supply. */
export type PushDirectPush = {
  /** Which host the repository is on, so its files are downloaded from there. */
  provider: GitProviderName;
  /** `owner/name`, as stored in `submissions.repository`. */
  repoName: string;
  /** The pushed head commit. */
  sha: string;
  headCommitMessage: string;
  /**
   * When the host says the push landed (GitHub's `repository.pushed_at`), or when the webhook
   * request arrived (Forgejo, whose payload has no push time), or null to use the time this check
   * runs. Must not come from the commit itself: a commit date is whatever the student's clock or
   * `git commit --date` said.
   */
  pushedAt: Date | null;
  /**
   * The repository's current default-branch head, or undefined when it can't be known (the E2E
   * GitHub stub). Throws when the lookup fails, so the delivery is retried instead of guessed.
   */
  getHeadSha: () => Promise<string | undefined>;
};

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
export async function createPushDirectSubmission(
  adminSupabase: SupabaseClient<Database>,
  push: PushDirectPush,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  opts: {
    allowNotGradedSubmissions: boolean;
    permitEmptySubmissions: boolean;
    /**
     * The assignment's automatic late-token policy, applied to a late push exactly as the
     * Actions path applies it. It belongs to the assignment, so a repo-only assignment honours
     * it too. `classLateTokensPerStudent` is the course-wide allotment every assignment draws from;
     * it only shapes the rejection message, since the RPC reads the balance itself.
     */
    lateTokenPolicy: { maxLateTokens: number; requireTokensBeforeDueDate: boolean; classLateTokensPerStudent: number };
    /**
     * The pusher is course staff pushing to a repository that is their own — the Instructor Test
     * Assignment case. The Actions path exempts staff-triggered submissions from the deadline,
     * token and empty-submission gates, and this path must do the same or a repo-only test
     * assignment behaves differently from an autograded one for the same person.
     */
    actorIsStaffOwner?: boolean;
    scope: Sentry.Scope;
  }
): Promise<void> {
  const { allowNotGradedSubmissions, permitEmptySubmissions, lateTokenPolicy, actorIsStaffOwner, scope } = opts;
  const { repoName, sha } = push;
  const isNotGraded = push.headCommitMessage.toUpperCase().includes("#NOT-GRADED");

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
  // The host's OWN push timestamp, not our receive time.
  //
  // GitHub's `repository.pushed_at` (converted by the caller) is set server-side by GitHub when the
  // push lands and is identical in every redelivery of that push, whereas `new Date()` changes on each
  // attempt: an on-time push whose first delivery threw transiently came back after the deadline and
  // was then treated as late — silently skipped, or spending late tokens the student should not have
  // needed. It is also not student-controllable, which is the property that ruled out
  // head_commit.timestamp (`git commit --date=...`). Falls back to now when absent (Forgejo's payload
  // has no push time), which is the previous behavior.
  const pushedAt = push.pushedAt;
  const pushTime = pushedAt && !Number.isNaN(pushedAt.getTime()) ? pushedAt : new Date();
  scope.setTag(
    "push_time_source",
    !pushedAt ? "processing_time" : push.provider === "forgejo" ? "forgejo_received_at" : `${push.provider}_pushed_at`
  );
  const finalDueDate = new Date(finalDueDateResult);
  const isLate =
    !actorIsStaffOwner && pushTime.getTime() > finalDueDate.getTime() && !(isNotGraded && allowNotGradedSubmissions);
  scope.setTag("push_direct_is_late", String(isLate));
  // Idempotency: a re-delivered webhook must not create a duplicate submission
  // for the same commit.
  //
  // Scoped to run_number = run_attempt = 0, which is what push-direct ingestion writes. On
  // (repository, sha) alone this also matched a HISTORICAL Actions-backed submission for the
  // same commit — reachable when the autograder was disabled and a student reverts or
  // force-pushes to a sha that was graded through Actions earlier. The unique index permits a
  // distinct 0/0 row, so that submission is not a duplicate of this push at all: treating it as
  // one skipped the hand-graded submission the student is now owed, or promoted a stale Actions
  // result as though it were this push.
  //
  // Keyed on the repository ROW, not only its name: names are unique per provider, so `org/repo`
  // can be a GitHub repository and a different Forgejo one. Matching on the name alone let a
  // Forgejo push find a GitHub submission for the same name and sha and skip, promote or delete it.
  // submissions_repository_id_sha_run_unique carries the same key, so the insert below agrees.
  const { data: existing, error: existingErr } = await adminSupabase
    .from("submissions")
    .select("id, is_active, is_not_graded, ingestion_pending, created_at")
    .eq("repository_id", studentRepo.id)
    .eq("repository", repoName)
    .eq("sha", sha)
    .eq("run_number", 0)
    .eq("run_attempt", 0)
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    Sentry.captureException(existingErr, scope);
    throw existingErr;
  }
  // Whether the row is a completed submission is read from `ingestion_pending` alone. It is set on
  // insert and cleared only once the files and the verdict (accepted, or retained as a rejection) are
  // written; cleanupPushDirectSubmission and a failed deactivateRejectedSubmission set it again in the
  // same write that unlinks the review, so a row whose cleanup stopped partway is pending too.
  //
  // The grading review is NOT the marker. The AFTER-INSERT hook provisions one only when the
  // assignment has a grading rubric, so an accepted submission on an assignment without one is
  // complete with a NULL review: reading NULL as "incomplete" deleted and re-ingested that accepted
  // submission on redelivery, and on Forgejo a late redelivery then recorded a deadline rejection in
  // its place. And the review is provisioned before ingestion starts, so a non-NULL one is no proof
  // that ingestion finished either. File count cannot be used: a legitimately empty submission has
  // zero files (permit_empty_submissions=true, or the path where empty detection is skipped for want
  // of submissionFiles).
  //
  //   - ingestion_pending = false: complete, whatever its review state.
  //   - pending and younger than INGESTION_STALE_MS: possibly still in progress in another delivery,
  //     so this one asks to be retried rather than deleting work out from under it (or, worse,
  //     acknowledging it as a duplicate and losing the retry).
  //   - pending and older than that: abandoned, or a cleanup that stopped. Reclaimed: deleted and
  //     re-ingested.
  // Rows written before ingestion_pending existed got the column's default, false. The migration
  // that added it (20261124120000) marks the ones the old NULL-review test treated as incomplete
  // pending, restricted to assignments that would have given them a review; see its step 1.
  const existingIsPending = existing !== null && existing.ingestion_pending === true;
  const existingIsAbandoned =
    existing !== null && existingIsPending && Date.now() - new Date(existing.created_at).getTime() > INGESTION_STALE_MS;
  if (existing && existingIsPending && !existingIsAbandoned) {
    scope.setTag("push_direct_submission_skipped", "ingestion_in_progress");
    throw new Error(
      `Push-direct submission ${existing.id} for ${repoName}@${sha} is still being ingested by another delivery; ` +
        `rejecting this delivery so it is retried once that one finishes or is abandoned`
    );
  }
  const existingIsIncomplete = existingIsAbandoned;
  // Why this row exists, resolved once. Needed before the late-token decision below as well as by
  // the branches further down, and it costs one query either way.
  const existingRejectionType =
    existing && !existingIsIncomplete ? await getRejectionErrorType(adminSupabase, existing.id) : null;

  // The automatic late-token spend, AFTER the idempotency lookup rather than before it.
  //
  // Spending a token is a permanent, externally visible act: apply_late_token_extension consumes
  // the student's balance and writes a due-date exception. Running it ahead of the lookup charged
  // for deliveries that go on to create nothing at all — a force-push back to an already-recorded
  // commit, or an ordinary duplicate delivery — and the RPC cannot absorb that, because its only
  // no-op guard is `NOW() <= calculate_final_due_date(...)`: once the extension it granted has
  // elapsed, the next redelivery is late again and buys another one. A push that failed and was
  // redelivered a few times could therefore cost several days of the student's allowance for one
  // commit. So only spend where this delivery can still record a submission:
  //   - no existing row: an ordinary new push;
  //   - an incomplete row: it is cleaned up below and re-ingested;
  //   - a retained `after_due_date` rejection: the whole point is to re-ask the deadline question,
  //     and it can only be answered differently if the balance or an exception has changed.
  // Every other branch below merely promotes, repairs or returns, and none of them needs a new
  // extension: `calculate_final_due_date` already includes any extension previously granted, so
  // `isLate` alone gives the promotion path the same answer the accepting path got.
  //
  // hasFinalizedEarly is checked FIRST, mirroring the Actions path: a student who finalized early
  // has a NEGATIVE due-date exception, which is what makes this push late, and
  // apply_late_token_extension would happily add a positive extension that offsets it and report
  // success. Spending their tokens to undo their own finalization — and to activate a submission
  // after the one their self-review is tied to — is not something the token policy is for.
  const mayRecordSubmission = !existing || existingIsIncomplete || existingRejectionType === "after_due_date";
  // Why the push ended up uncovered, for the student-facing rejection below. "You have no late
  // tokens left" is only true when the balance was actually consulted and came up short. The
  // assignment may offer no tokens, the policy may decline to spend them automatically
  // (require_tokens_before_due_date, which is the default), or the student's own early
  // finalization may rule it out — and in each of those the balance is never read, so reporting
  // exhaustion states something we did not check and sends the student to the wrong remedy.
  // A course with no allotment gets its own outcome: "no late tokens left" would suggest the
  // student spent tokens they were never given.
  let lateTokenOutcome: "none_offered" | "none_in_course" | "not_automatic" | "finalized_early" | "exhausted" =
    lateTokenPolicy.maxLateTokens <= 0
      ? "none_offered"
      : lateTokenPolicy.classLateTokensPerStudent <= 0
        ? "none_in_course"
        : lateTokenPolicy.requireTokensBeforeDueDate
          ? "not_automatic"
          : "exhausted";
  let stillLate = isLate;
  if (isLate && mayRecordSubmission) {
    if (await hasFinalizedEarly(adminSupabase, studentRepo, scope)) {
      scope.setTag("push_direct_finalized_early", "true");
      lateTokenOutcome = "finalized_early";
    } else {
      const extended = await applyAutomaticLateTokens({
        adminSupabase,
        studentRepo,
        profileId,
        pushTime,
        finalDueDate,
        lateTokenPolicy,
        scope
      });
      if (extended) {
        stillLate = false;
        scope.setTag("push_direct_late_token_applied", "true");
      }
    }
  }

  if (existing && existingIsIncomplete) {
    scope.setTag("push_direct_incomplete_row_resumed", String(existing.id));
    console.log(
      `Found an incomplete push-direct submission ${existing.id} for ${repoName}@${sha} (ingestion never finished); removing it and retrying`
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
    // Classified above, before the late-token decision: what happens next depends on why this row
    // exists, and two of the three answers were unreachable while the is_active test ran ahead of
    // them.
    //
    // A DEADLINE rejection is about timing, not about the commit, so it must not be permanent.
    // Once an instructor grants an extension that very same commit is timely — and treating the row
    // like an oversized rejection (which IS permanent) forced the student to manufacture a new
    // commit to be graded at all. Checked before the is_active branch, because such a row is
    // normally inactive and would otherwise be handed to the promotion path, which refuses every
    // rejection type and returns.
    if (existingRejectionType === "after_due_date" && !stillLate) {
      scope.setTag("push_direct_deadline_rejection_retried", String(existing.id));
      console.log(
        `Reprocessing ${repoName}@${sha}: its earlier rejection was for the deadline, which the current deadline ` +
          `check now passes`
      );
      const removed = await cleanupPushDirectSubmission(adminSupabase, existing.id, scope);
      if (!removed) {
        throw new Error(
          `Could not remove the stale deadline rejection ${existing.id} for ${repoName}@${sha}; rejecting this ` +
            `delivery so GitHub retries it`
        );
      }
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, existing.id);
      // Deliberately does NOT return: the push is ingested fresh below, as though it had just
      // arrived, which is what the extension makes it.
    } else if (existing.is_active === false) {
      // A force-push BACK to an already-recorded commit is not a redelivery, and the sha-keyed
      // lookup cannot tell them apart. Student pushes A, then B, then force-pushes A again: this
      // branch is reached with A's submission present but inactive, so treating it as a duplicate
      // left B active while the repository head — and the student's latest intent — is A. The
      // gradebook then grades code the student rolled back.
      //
      // The caller has verified that this sha IS the current head, which is what makes promotion
      // correct here rather than a guess. Subject to the SAME deadline as a new submission:
      // promoting an earlier commit changes which submission is graded, so a force-push after the
      // cutoff must not do it when a post-deadline push cannot create one.
      if (stillLate) {
        scope.setTag("force_push_promote_skipped", "after_due_date");
        console.log(
          `Not promoting submission ${existing.id} for ${repoName}@${sha}: the force-push arrived after the due date`
        );
        // Refusing to promote is not the same as having nothing to do, and this branch used to
        // return straight out. That made it a dead end for the redelivery a rejection asks for:
        // recordRejectedPush inserts (demoting the student's previous submission), deactivates the
        // rejected row and only THEN restores the previous one, so a transient failure of that last
        // step leaves both inactive. The redelivery finds the rejected row here — inactive, review
        // intact, still late — and returned 200 without repairing anything, so the student was left
        // with no active submission at all, permanently. Excluding this row keeps the rejection from
        // being promoted; the probe inside makes it a no-op when something is already active.
        await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, existing.id);
        return;
      }
      await promoteSubmissionForCurrentHead(adminSupabase, studentRepo, existing, push, scope);
      // Promotion is allowed to REFUSE — a retained rejection or an is_not_graded row is not
      // something to make active — and a refusal leaves the same hole the late branch above
      // repairs. A retained oversized or empty rejection is deactivated but keeps its grading
      // review, so a redelivery for that commit lands HERE, not in the duplicate branch below
      // whose comment describes this case: the row is inactive, so this branch claims it first.
      // If the reactivation that should have followed the original rejection failed transiently,
      // the throw that asked for this redelivery could never repair anything — promotion declines
      // on the rejection marker and this returned 200, leaving the student with no active
      // submission at all, permanently.
      //
      // Deliberately NO excludeSubmissionId, unlike the late branch above. The probe honours the
      // exclusion, so passing this row would hide the submission promotion just made active and
      // send the search on to promote a second one — the very 23505 the probe was added to stop.
      // Omitting it makes the probe see the successful promotion and return untouched, and both
      // reasons promotion can refuse are already filtered out of the candidate search: a retained
      // rejection by the workflow_run_error marker, an is_not_graded row by the query itself. So
      // this row can never be what gets promoted here.
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope);
      return;
    } else if (existingRejectionType) {
      // A rejected row that is STILL ACTIVE is a failed deactivation, not a duplicate.
      // deactivateRejectedSubmission writes the workflow_run_error first and deactivates second, so
      // an outage between them leaves the row active with its review intact — which every check
      // reads as a completed submission, so the redelivery the caller asked for returned without
      // retrying anything and a rejected push stayed the graded submission indefinitely. The error
      // row is the durable marker that makes this recognisable.
      scope.setTag("push_direct_retry_failed_deactivation", String(existing.id));
      console.log(`Retrying the deactivation of rejected submission ${existing.id} for ${repoName}@${sha}`);
      const deactivated = await deactivateRejectedSubmission(adminSupabase, existing.id, scope);
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, existing.id);
      if (!deactivated) {
        throw new Error(
          `Rejected submission ${existing.id} for ${repoName}@${sha} is still active and could not be deactivated; ` +
            `rejecting this delivery so GitHub retries it`
        );
      }
      return;
    } else {
      // An ordinary duplicate delivery: the row is complete, active and carries no rejection
      // marker, so there is nothing to redo. Retained rejections do NOT reach here — they are
      // deactivated, which the is_active branch above claims first, and a failed deactivation
      // leaves them active but marked, which the branch above that claims. Both repair
      // themselves.
      //
      // Still worth the check before returning, because "active" was read from the row this
      // delivery matched, not from the student's submission set as a whole: a demotion that
      // outlived its promotion leaves nothing active at all. No exclusion is passed, since this
      // row is a legitimate candidate. reactivatePreviousSubmission returns untouched when
      // something is already active, so this is a no-op on the normal path, and it throws on
      // failure, which correctly asks for another delivery.
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope);
      return;
    }
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
  // Staff pushing to their own test repository are exempt, as they are on the Actions path: an
  // instructor verifying the pipeline with an untouched clone should not be told their submission
  // was empty.
  const canDetectEmpty = emptyHashFilter !== null && !actorIsStaffOwner;
  if (!canDetectEmpty) {
    scope.setTag("push_direct_empty_check", "skipped_no_submission_files");
    console.log(
      `Not checking emptiness for ${repoName}@${sha}: assignment ${studentRepo.assignment_id} has no ` +
        `submissionFiles configured, so there is no comparable handout hash`
    );
  }

  // The deadline decision, using the values computed above. Gated on the webhook *receive*
  // time, NOT head_commit.timestamp: the commit timestamp is student-controllable
  // (`git commit --date=...`), so a backdated commit pushed after the deadline must not slip
  // through. This matches the autograder path, which gates on the check-run created_at.
  if (stillLate) {
    // The token policy was already applied (or found insufficient, or refused because the student
    // finalized early) when `stillLate` was resolved above.
    //
    // Recorded, not silently dropped. This feature tells students that every push is a
    // submission, so a push that produces nothing has to say why — and the only surface a student
    // can read is a workflow_run_error attached to a submission they own (its RLS requires
    // submission_id IS NOT NULL). The Actions path has a run to carry that message; this path has
    // to make somewhere to put it, so it records a rejected submission: fileless, inactive, and
    // ungradeable, exactly like the empty and oversized rejections.
    scope.setTag("push_direct_submission_rejected", "after_due_date");
    scope.setTag("push_direct_late_token_outcome", lateTokenOutcome);
    console.log(`Push-direct submission for ${repoName}@${sha} is after the due date; recording a rejection`);
    const lateTokenClause = {
      none_offered: "",
      none_in_course: ", and this course does not give late tokens, so none could be applied",
      not_automatic:
        ", and late tokens for this assignment have to be applied before the deadline, so none covered this push",
      finalized_early:
        ", and you have already finalized your work for this assignment, so late tokens were not applied",
      exhausted: " and you have no late tokens left to cover it"
    }[lateTokenOutcome];
    await recordRejectedPush({
      adminSupabase,
      studentRepo,
      repoName,
      sha,
      isNotGraded,
      errorType: "after_due_date",
      errorName:
        `Your submission at commit ${sha.slice(0, 7)} was not recorded: it was pushed after the deadline for this ` +
        `assignment${lateTokenClause}. Contact your instructor if you believe this is wrong.`,
      scope
    });
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
    const headBeforeInsert = await push.getHeadSha();
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

  // The submission the insert below will demote. If this push is then rejected, that is the one to
  // put back, and it is recorded with the rejection so a retry restores the same one.
  const displacedSubmissionId = await findActiveSubmissionId(adminSupabase, studentRepo);

  // Create the submission row. Column set mirrors the autograder insert so the
  // BEFORE-INSERT trigger (ordinal/is_active) and AFTER-INSERT hook (grading
  // review) run identically. Do NOT set ordinal/is_active/grading_review_id.
  // `ingestion_pending` stays true until the files and the verdict are written.
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
      is_not_graded: isNotGraded,
      ingestion_pending: true
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
    const { error: mockDoneErr } = await adminSupabase
      .from("submissions")
      .update({ ingestion_pending: false })
      .eq("id", submissionId);
    if (mockDoneErr) {
      Sentry.captureException(mockDoneErr, scope);
      throw mockDoneErr;
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
      gitProvider: push.provider,
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
    // An accepted push is complete once this write lands, so it also clears ingestion_pending, in
    // the same write. A rejected one stays pending until the rejection is retained below.
    // `is_empty_submission` is written only when there is a verdict to record: it is NOT NULL
    // DEFAULT false, so writing `false` for the no-verdict case (the common one on a repo-only
    // assignment, which has no submissionFiles) would rewrite the value the INSERT already stored.
    const accepted = emptyVerdict === "accept";
    if (ingestResult.isEmpty !== null || accepted) {
      const { error: emptyFlagError } = await adminSupabase
        .from("submissions")
        .update({
          ...(ingestResult.isEmpty !== null ? { is_empty_submission: ingestResult.isEmpty } : {}),
          ...(accepted ? { ingestion_pending: false } : {})
        })
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
      // RETAINED, not deleted — the same shape as an oversized rejection.
      //
      // Deleting it left the student with nothing: no submission, and no error either, because a
      // workflow_run_error is only visible to a student when it is attached to a submission they
      // can read (its RLS requires submission_id IS NOT NULL). So an automatic-submission feature
      // silently discarded their push while the commit history showed an ordinary entry. The
      // Actions path says "Empty submissions are not permitted"; this is how that message reaches
      // a student when there is no Actions run to carry it.
      //
      // Inactive and fileless, so it cannot be graded, and the assignment page labels a submission
      // with an attached error as "Error".
      const errorName =
        `Your submission at commit ${sha.slice(0, 7)} was not recorded: it is identical to the assignment's ` +
        `starter code, and this assignment does not accept empty submissions. Make your changes and push again.`;
      const { error: emptyRecordError } = await adminSupabase.from("workflow_run_error").upsert(
        {
          repository_id: studentRepo.id,
          class_id: studentRepo.class_id,
          submission_id: submissionId,
          run_number: 0,
          run_attempt: 0,
          name: errorName,
          is_private: false,
          data: {
            repository_name: repoName,
            sha,
            error_type: "empty_submission",
            displaced_submission_id: displacedSubmissionId,
            detected_at: new Date().toISOString()
          }
        },
        { onConflict: "repository_id,run_number,run_attempt,name" }
      );
      if (emptyRecordError) {
        // Without the explanation the retained row is a bare inactive submission — the silent
        // state this change exists to remove. Fall back to deleting it so the student is not left
        // with an unexplained row, then ask for a redelivery.
        scope.setTag("empty_record_failed", "true");
        Sentry.captureException(emptyRecordError, scope);
        await cleanupPushDirectSubmission(adminSupabase, submissionId, scope);
        await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, submissionId, displacedSubmissionId);
        throw new Error(
          `Could not record the empty-submission rejection for ${repoName}@${sha} (${emptyRecordError.message}); ` +
            `rejecting this delivery so GitHub retries it`
        );
      }
      // Strips the files and deactivates, leaving the review attached so the row stays visible.
      const deactivated = await deactivateRejectedSubmission(adminSupabase, submissionId, scope);
      // The insert demoted the student's previous submission; put it back.
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, submissionId, displacedSubmissionId);
      if (!deactivated) {
        scope.setTag("push_direct_retry_reason", "empty_deactivation_incomplete");
        throw new Error(
          `Rejected empty push-direct submission ${submissionId} for ${repoName}@${sha} could not be deactivated; ` +
            `rejecting this delivery so GitHub retries it`
        );
      }
      return;
    }
  } catch (ingestErr) {
    const isTooLarge = ingestErr instanceof SubmissionTooLargeError || ingestErr instanceof SubmissionFileTooLargeError;
    if (isTooLarge) {
      // Permanent (repo/file too big): recorded FIRST, before the row is deactivated below.
      //
      // The error row is the durable marker for "this submission was rejected" — it is what
      // getRejectionErrorType reads, and what stops promoteSubmissionForCurrentHead from ever
      // making a fileless rejection the graded submission. Writing it after the deactivation
      // inverted that: between the two calls the row sat inactive, fileless and review-intact with
      // NO marker, so a worker killed in that window (edge-function wall clock, a deploy) left a
      // submission that every later check reads as an ordinary one. The next delivery for that sha
      // — a redelivery, or the student force-pushing back to it — then promoted the empty rejection
      // over their real work. Two other rejection paths already write the marker first, and the
      // comment on the redelivery branch above states that ordering as the invariant; this is the
      // one place that broke it.
      //
      // Recording here also keeps the pre-existing property that an unrelated restoration failure
      // below cannot suppress the record and turn a permanently failing delivery into an unbounded
      // retry loop that re-clones an oversized repo each time. The upsert is idempotent on
      // (repository_id, run_number, run_attempt, name), so a retry is safe.
      scope.setTag("push_direct_submission_rejected", "too_large");
      Sentry.captureException(ingestErr, scope);
      // Attached to the retained submission, which is what makes it student-visible:
      // workflow_run_error's student RLS branch requires submission_id IS NOT NULL and
      // the student-facing reader embeds it through `submissions`. The row is retained rather
      // than deleted on this path, so the id is always the right one to attach to.
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
          submission_id: submissionId,
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
            displaced_submission_id: displacedSubmissionId,
            detected_at: new Date().toISOString()
          }
        },
        { onConflict: "repository_id,run_number,run_attempt,name" }
      );
      if (recordError) {
        // Do NOT acknowledge the delivery. Without this record the retained row is a
        // bare submission with no explanation — the exact silent state retaining it was
        // meant to replace. And a redelivery could not repair it: a retained row is no
        // longer ingestion_pending, so the idempotency pre-check reads it as complete and
        // returns before reaching this upsert.
        //
        // So drop the row and retry from scratch. Either the student gets a row WITH its
        // explanation, or there is no row and the delivery is retried — never a row
        // without an explanation.
        scope.setTag("too_large_record_failed", "true");
        Sentry.captureException(recordError, scope);
        await cleanupPushDirectSubmission(adminSupabase, submissionId, scope);
        await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, submissionId, displacedSubmissionId);
        throw new Error(
          `Could not record the oversized-submission error for ${repoName}@${sha} (${recordError.message}); ` +
            `rejecting this delivery so GitHub retries it`
        );
      }
    }
    // For an oversized push we KEEP the submission row, deactivated, so the student
    // has something to see. Deleting it left them with no history entry, no failing
    // check (this path creates none by design) and no reachable error — the push
    // simply looked accepted. An inactive row with its review intact cannot be graded
    // but does appear in submission history, and the workflow_run_error below can
    // attach to it, which is the only surface a student can actually reach.
    //
    // Its review link is deliberately left in place, and retaining it clears
    // ingestion_pending, so a redelivery reads this deliberate row as complete rather than
    // as junk to be deleted and re-ingested.
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
      await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, submissionId, displacedSubmissionId);
    } catch (e) {
      reactivateErr = e;
      // `e`, not `ingestErr`. The comment above says to capture the restoration failure
      // "separately so it neither masks ingestErr", and reporting ingestErr here did the
      // opposite: it filed a second copy of the clone error (already captured for the
      // too_large branch) and threw away the only record of WHY the student's previous
      // submission could not be restored.
      Sentry.captureException(e, scope);
    }
    if (!removed) {
      // Returning 200 here gave GitHub no reason to redeliver, so the incomplete row
      // stayed forever. The incomplete marker is only useful if something comes back
      // for it, so force a retry — the explanation, where there is one, was already
      // written above.
      scope.setTag("push_direct_cleanup_failed", "true");
      Sentry.captureMessage(
        `Failed to remove partial push-direct submission ${submissionId} for ${repoName}@${sha}`,
        scope
      );
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
/**
 * Is this push from course staff acting on a repository that is not their own?
 *
 * syncRepoPermissions grants instructors and graders `maintain` on every student repository, so
 * staff CAN push to one — to debug, or to help a student. Recording that as the student's
 * submission replaces their active gradebook entry with someone else's commit, and after the
 * deadline it can spend the student's automatic late tokens.
 *
 * Deliberately narrow: it excludes staff pushing to SOMEONE ELSE's repo. Staff pushing to their
 * own repository is a real submission — the Instructor Test Assignment flow provisions exactly
 * that, so treating every staff push as foreign would break it.
 *
 * Returns false when the pusher cannot be resolved. An unknown GitHub login is far more likely to
 * be a student whose account is not linked than a staff member, and dropping a student's
 * submission is the worse error.
 */
export async function resolvePusherStanding(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  pusherLogin: string | null | undefined,
  scope: Sentry.Scope,
  /**
   * A Forgejo pusher is the login of a `git_accounts` row on this instance. Omitted for GitHub,
   * whose pusher is `users.github_username`.
   */
  forgejoInstanceUrl?: string
): Promise<{ isForeignStaff: boolean; isOwnerStaff: boolean }> {
  const notStaff = { isForeignStaff: false, isOwnerStaff: false };
  if (!pusherLogin) return notStaff;
  const user =
    forgejoInstanceUrl === undefined
      ? await findGitHubPusher(adminSupabase, pusherLogin)
      : await findForgejoPusher(adminSupabase, forgejoInstanceUrl, pusherLogin);
  if (!user) {
    scope.setTag("pusher_role", forgejoInstanceUrl === undefined ? "unknown_github_login" : "unknown_forgejo_login");
    return notStaff;
  }
  const { data: role, error: roleError } = await adminSupabase
    .from("user_roles")
    .select("role, private_profile_id")
    .eq("user_id", user.user_id)
    .eq("class_id", studentRepo.class_id)
    // (user_id, class_id) is unique only among ACTIVE rows — idx_user_roles_one_active_per_class
    // is partial, `WHERE disabled = false` (20260522120001) — and dropping an enrollment sets
    // disabled = true rather than deleting the row. So anyone re-added after being dropped, or a
    // TA who was previously enrolled as a student, has two rows here and maybeSingle() raised
    // PGRST116. That threw out of handlePushToStudentRepo and answered 500, and because the error
    // is deterministic every GitHub redelivery hit it again: on a repo-only assignment, where this
    // is the only path that records a submission, their pushes were lost with nothing to show for
    // it. The filter is also the correct semantics — a dropped instructor is not current staff.
    .eq("disabled", false)
    .limit(1)
    .maybeSingle();
  if (roleError) throw roleError;
  if (!role || (role.role !== "instructor" && role.role !== "grader")) return notStaff;
  scope.setTag("pusher_role", role.role);

  // Their own individual repo: a genuine submission, and a STAFF one.
  if (studentRepo.profile_id && role.private_profile_id === studentRepo.profile_id) {
    return { isForeignStaff: false, isOwnerStaff: true };
  }
  // Their own group's repo: also genuine. Staff are not normally group members, so this is the
  // Instructor Test Assignment case again.
  if (studentRepo.assignment_group_id) {
    const { data: membership, error: membershipError } = await adminSupabase
      .from("assignment_groups_members")
      .select("id")
      .eq("assignment_group_id", studentRepo.assignment_group_id)
      .eq("profile_id", role.private_profile_id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (membership) return { isForeignStaff: false, isOwnerStaff: true };
  }
  return { isForeignStaff: true, isOwnerStaff: false };
}

async function findGitHubPusher(
  adminSupabase: SupabaseClient<Database>,
  pusherLogin: string
): Promise<{ user_id: string } | null> {
  const { data: user, error: userError } = await adminSupabase
    .from("users")
    .select("user_id")
    .ilike("github_username", pusherLogin)
    .maybeSingle();
  if (userError) throw userError;
  return user;
}

/**
 * Forgejo logins are case-insensitive, and a login can contain `_`, so the match is ILIKE with the
 * pattern characters escaped. More than one row (the same login claimed twice) is treated as unknown.
 */
async function findForgejoPusher(
  adminSupabase: SupabaseClient<Database>,
  instanceUrl: string,
  pusherLogin: string
): Promise<{ user_id: string } | null> {
  const { data: accounts, error } = await adminSupabase
    .from("git_accounts")
    .select("user_id")
    .eq("provider", "forgejo")
    .eq("instance_url", instanceUrl)
    .ilike("login", ilikeLiteral(pusherLogin))
    .limit(2);
  if (error) throw error;
  return accounts?.length === 1 ? accounts[0] : null;
}

/**
 * Does this submission carry the oversized-rejection marker?
 *
 * deactivateRejectedSubmission writes that workflow_run_error BEFORE deactivating, which is what
 * makes it a durable signal rather than a race: a row with the marker was rejected, whatever
 * state the rest of the cleanup reached.
 */
async function getRejectionErrorType(
  adminSupabase: SupabaseClient<Database>,
  submissionId: number
): Promise<string | null> {
  const { data: rejectionErrors, error } = await adminSupabase
    .from("workflow_run_error")
    .select("submission_id, data")
    .eq("submission_id", submissionId);
  if (error) throw error;
  for (const e of rejectionErrors ?? []) {
    const errorType = (e.data as { error_type?: string } | null)?.error_type;
    if (errorType && REJECTION_ERROR_TYPES.has(errorType)) return errorType;
  }
  return null;
}

/**
 * Record a push that was refused before ingestion as a visible, ungradeable submission.
 *
 * Used for the deadline rejection, which has no submission of its own to attach an explanation to:
 * a workflow_run_error is only readable by the student when `submission_id IS NOT NULL`, so
 * returning early left the push looking accepted — no submission, no error, and a commit-history
 * entry indistinguishable from a successful one.
 *
 * The row is inserted with no files, its explanation attached, then deactivated, and the
 * submission the insert demoted is restored. Failures propagate: a row without its explanation is
 * the silent state this exists to remove, so that case deletes the row and asks for a redelivery.
 */
async function recordRejectedPush(params: {
  adminSupabase: SupabaseClient<Database>;
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"];
  repoName: string;
  sha: string;
  isNotGraded: boolean;
  errorType: string;
  errorName: string;
  scope: Sentry.Scope;
}): Promise<void> {
  const { adminSupabase, studentRepo, repoName, sha, isNotGraded, errorType, errorName, scope } = params;
  // What the insert demotes, recorded with the rejection so it, and not merely the highest
  // ordinal, is what gets restored, on this delivery and on any retry.
  const displacedSubmissionId = await findActiveSubmissionId(adminSupabase, studentRepo);
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
      is_not_graded: isNotGraded,
      // Not complete until the explanation is attached and the row is deactivated.
      ingestion_pending: true
    })
    .select("id")
    .single();
  if (insertError) {
    // 23505: a row for this commit already exists, so the rejection is already recorded (or this
    // is a redelivery). 23514: the student has since joined a group, and the group repo's push
    // owns submissions now. Neither is worth a retry.
    if (insertError.code === "23505" || insertError.code === "23514") {
      scope.setTag("rejected_push_insert_skipped", insertError.code);
      return;
    }
    Sentry.captureException(insertError, scope);
    throw insertError;
  }
  const { error: recordError } = await adminSupabase.from("workflow_run_error").upsert(
    {
      repository_id: studentRepo.id,
      class_id: studentRepo.class_id,
      submission_id: inserted.id,
      run_number: 0,
      run_attempt: 0,
      name: errorName,
      is_private: false,
      data: {
        repository_name: repoName,
        sha,
        error_type: errorType,
        displaced_submission_id: displacedSubmissionId,
        detected_at: new Date().toISOString()
      }
    },
    { onConflict: "repository_id,run_number,run_attempt,name" }
  );
  if (recordError) {
    scope.setTag("rejected_push_record_failed", "true");
    Sentry.captureException(recordError, scope);
    await cleanupPushDirectSubmission(adminSupabase, inserted.id, scope);
    await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, inserted.id, displacedSubmissionId);
    throw new Error(
      `Could not record the rejection for ${repoName}@${sha} (${recordError.message}); rejecting this delivery so ` +
        `GitHub retries it`
    );
  }
  const deactivated = await deactivateRejectedSubmission(adminSupabase, inserted.id, scope);
  // The insert demoted whatever was active; the rejected row must not inherit that place.
  await reactivatePreviousSubmission(adminSupabase, studentRepo, scope, inserted.id, displacedSubmissionId);
  if (!deactivated) {
    throw new Error(
      `Rejected submission ${inserted.id} for ${repoName}@${sha} could not be deactivated; rejecting this delivery ` +
        `so GitHub retries it`
    );
  }
}

/**
 * Has this student (or group) finalized their submission early?
 *
 * Early finalization is recorded as a NEGATIVE due-date exception, which is itself what makes a
 * later push late. The Actions path checks for it before touching late tokens, and this path must
 * too: apply_late_token_extension would otherwise grant a positive extension that offsets the
 * finalization and report success, spending the student's tokens to undo their own decision and
 * activating a submission later than the one their self-review is attached to.
 */
async function hasFinalizedEarly(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  scope: Sentry.Scope
): Promise<boolean> {
  let query = adminSupabase
    .from("assignment_due_date_exceptions")
    .select("hours, minutes")
    .eq("assignment_id", studentRepo.assignment_id);
  if (studentRepo.assignment_group_id) {
    query = query.eq("assignment_group_id", studentRepo.assignment_group_id);
  } else if (studentRepo.profile_id) {
    query = query.eq("student_id", studentRepo.profile_id);
  } else {
    // Neither owner resolvable: no exception can be attributed, so nothing to find.
    return false;
  }
  const { data: exceptions, error } = await query.limit(1000);
  if (error) {
    // Throw rather than assume "not finalized": guessing wrong spends the student's tokens and
    // overrides a finalization they chose. GitHub redelivers.
    Sentry.captureException(error, scope);
    throw error;
  }
  return (exceptions ?? []).some((e) => (e.hours ?? 0) < 0 || (e.minutes ?? 0) < 0);
}

/**
 * Spend late tokens automatically for a push that arrived after the deadline, mirroring the
 * Actions path. Returns true when the deadline has been extended and the push may proceed.
 *
 * The policy belongs to the ASSIGNMENT (require_tokens_before_due_date = false plus a non-zero
 * token allowance), not to the autograder, so a repo-only assignment has to honour it too.
 *
 * Safe on redelivery: apply_late_token_extension returns success without spending anything once
 * the extension it would grant already covers the deadline.
 */
async function applyAutomaticLateTokens(params: {
  adminSupabase: SupabaseClient<Database>;
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"];
  profileId: string | null;
  pushTime: Date;
  finalDueDate: Date;
  lateTokenPolicy: { maxLateTokens: number; requireTokensBeforeDueDate: boolean };
  scope: Sentry.Scope;
}): Promise<boolean> {
  const { adminSupabase, studentRepo, profileId, pushTime, finalDueDate, lateTokenPolicy, scope } = params;
  if (lateTokenPolicy.requireTokensBeforeDueDate || lateTokenPolicy.maxLateTokens <= 0) return false;
  // No resolvable profile means no token balance to spend against.
  if (!profileId) {
    scope.setTag("late_token_skipped", "no_profile");
    return false;
  }
  // Same arithmetic as the Actions path: whole days of extension, at least one.
  const minutesLate = Math.ceil((pushTime.getTime() - finalDueDate.getTime()) / 60000);
  const hoursLate = Math.max(1, Math.ceil(minutesLate / 60));
  const tokensNeeded = Math.ceil(hoursLate / 24);
  const { data: result, error: rpcError } = await adminSupabase.rpc("apply_late_token_extension", {
    p_assignment_id: studentRepo.assignment_id,
    // Both params are nullable in SQL — exactly one of them is set, depending on whether this
    // is a group submission — but the generated RPC types mark them required, the same mismatch
    // the calculate_final_due_date call above narrows.
    p_student_id: (studentRepo.assignment_group_id ? null : profileId) as string,
    p_assignment_group_id: (studentRepo.assignment_group_id ?? null) as number,
    p_class_id: studentRepo.class_id,
    p_creator_id: profileId,
    p_hours_late: tokensNeeded * 24,
    p_tokens_needed: tokensNeeded
  });
  if (rpcError) {
    // Throw rather than treat it as "no tokens": that would discard a push the policy entitles
    // the student to submit, with nothing to detect it. GitHub redelivers.
    scope.setTag("late_token_rpc_failed", "true");
    Sentry.captureException(rpcError, scope);
    throw rpcError;
  }
  const applied = (result as { success?: boolean } | null)?.success === true;
  if (!applied) scope.setTag("late_token_insufficient", "true");
  return applied;
}

async function promoteSubmissionForCurrentHead(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  existing: { id: number; is_not_graded: boolean | null },
  push: PushDirectPush,
  scope: Sentry.Scope
): Promise<void> {
  const { repoName, sha } = push;
  if (existing.is_not_graded) {
    scope.setTag("force_push_promote_skipped", "is_not_graded");
    return;
  }
  if (await getRejectionErrorType(adminSupabase, existing.id)) {
    scope.setTag("force_push_promote_skipped", "retained_rejection");
    return;
  }

  // The caller's head check ran before the existing-row lookup, the late-token decision and the
  // rejection check above, and a newer push can be accepted in that time. Promoting then would
  // demote the newer submission and activate this older one, so the graded commit would not be the
  // branch head. So: note the newest submission recorded so far and the submitter's promotion
  // version, re-read the head, and let the promotion RPC refuse if a newer submission has been
  // recorded or another promotion has committed by the time it runs. The version is what catches two
  // overlapping force-push deliveries that both find their commit already recorded: neither inserts,
  // so the id fence alone let the one that read its head first promote a commit that was no longer the
  // head over the one that was. The RPC demotes, activates and bumps the version in one transaction;
  // see promote_push_direct_submission (20261124120000) for how it settles a push that lands during
  // the call.
  const fence = await findNewestSubmissionId(adminSupabase, studentRepo);
  const { data: promotionVersion, error: versionErr } = await adminSupabase.rpc("push_direct_promotion_version", {
    p_submission_id: existing.id
  });
  if (versionErr) {
    scope.setTag("force_push_promotion_version_failed", "true");
    Sentry.captureException(versionErr, scope);
    throw versionErr;
  }
  let head: string | undefined;
  try {
    head = await push.getHeadSha();
  } catch (headErr) {
    scope.setTag("force_push_head_recheck_failed", "true");
    Sentry.captureException(headErr, scope);
    throw new Error(
      `Could not re-confirm that ${sha} is the current head of ${repoName} before re-activating submission ` +
        `${existing.id} (${headErr instanceof Error ? headErr.message : String(headErr)}); rejecting this ` +
        `delivery so GitHub retries it`
    );
  }
  if (head && head !== sha) {
    scope.setTag("force_push_promote_skipped", "head_moved");
    console.log(`Not re-activating submission ${existing.id}: ${repoName} has moved on to ${head}`);
    return;
  }

  const { data: outcome, error: promoteErr } = await adminSupabase.rpc("promote_push_direct_submission", {
    p_submission_id: existing.id,
    p_newer_than_submission_id: fence ?? 0,
    p_expected_promotion_version: promotionVersion ?? 0
  });
  if (promoteErr) {
    // Including a 23505 from a push accepted during the call: the retry finds that newer row and
    // refuses. The transaction rolled back, so the previous active submission is untouched.
    scope.setTag("force_push_promote_failed", "true");
    Sentry.captureException(promoteErr, scope);
    throw promoteErr;
  }
  if (outcome !== "promoted") {
    scope.setTag("force_push_promote_skipped", String(outcome));
    console.log(`Not re-activating submission ${existing.id} for ${repoName}@${sha}: ${outcome}`);
    return;
  }
  scope.setTag("force_push_promoted_submission", String(existing.id));
  console.log(`Re-activated submission ${existing.id}: ${repoName} was force-pushed back to ${sha}`);
}

/** Restricts a submissions query to this repository's submitter, as the one-active indexes do. */
// The builder types are generic over the selected columns, so take anything with eq and is.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forSubmitter<Q extends { eq: (...args: any[]) => Q; is: (...args: any[]) => Q }>(
  query: Q,
  studentRepo: RepositoryRow
): Q {
  return studentRepo.assignment_group_id
    ? query.eq("assignment_group_id", studentRepo.assignment_group_id)
    : query.eq("profile_id", studentRepo.profile_id!).is("assignment_group_id", null);
}

/** The submitter's active submission for this assignment, if any. */
async function findActiveSubmissionId(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: RepositoryRow
): Promise<number | null> {
  const { data, error } = await forSubmitter(
    adminSupabase.from("submissions").select("id").eq("assignment_id", studentRepo.assignment_id).eq("is_active", true),
    studentRepo
  )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** The submitter's most recently inserted submission for this assignment, if any. */
async function findNewestSubmissionId(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: RepositoryRow
): Promise<number | null> {
  const { data, error } = await forSubmitter(
    adminSupabase.from("submissions").select("id").eq("assignment_id", studentRepo.assignment_id),
    studentRepo
  )
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** The submission a rejected push displaced, as recorded with its rejection. */
async function findDisplacedSubmissionId(
  adminSupabase: SupabaseClient<Database>,
  rejectedSubmissionId: number
): Promise<number | null> {
  const { data, error } = await adminSupabase
    .from("workflow_run_error")
    .select("data")
    .eq("submission_id", rejectedSubmissionId);
  if (error) throw error;
  for (const row of data ?? []) {
    const displaced = (row.data as { displaced_submission_id?: unknown } | null)?.displaced_submission_id;
    if (typeof displaced === "number") return displaced;
  }
  return null;
}

/**
 * A push-direct row left by a delivery that stopped after its insert: still `ingestion_pending` this
 * long after it was created is abandoned, not in progress. Well past the edge function's wall-clock
 * limit, so a live delivery is never mistaken for a dead one.
 */
const INGESTION_STALE_MS = 10 * 60 * 1000;

/**
 * `data.error_type` values that mark a submission as REJECTED and retained for visibility only.
 *
 * Such a row is deliberately inactive and fileless, so it must never be promoted — not by the
 * reactivation scan, and not by the force-push path. Kept as one set because three call sites test
 * it and the empty-submission type was added after the first two, which is exactly how they would
 * have drifted.
 */
const REJECTION_ERROR_TYPES = new Set(["file_too_large", "submission_too_large", "empty_submission", "after_due_date"]);

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
  excludeSubmissionId?: number,
  /**
   * The submission the rejected push displaced, when the caller knows it. Otherwise it is read
   * from the rejection's workflow_run_error, where it is recorded so a retry restores the same one.
   */
  displacedSubmissionId?: number | null
): Promise<void> {
  try {
    // Is ANY submission already active for this submitter? Asked up front, and about the whole
    // set rather than about one candidate row.
    //
    // The check further down — `if (!newest || newest.is_active) return` — only asks whether the
    // HIGHEST-ordinal promotable row is active, and reads "it is not" as "nothing is". That is
    // false exactly where promoteSubmissionForCurrentHead has just done its job: a force-push back
    // to an earlier commit deliberately makes a LOWER-ordinal row active while the newer one stays
    // inactive. Any later delivery for that commit then reached here and promoted the newer row on
    // top of the active older one, which submissions_one_active_individual_per_student /
    // submissions_one_active_group_per_group (20260424200000) reject with 23505 — thrown, so the
    // webhook answered 500 and GitHub redelivered into the identical deterministic failure. When
    // the promote did land it silently undid the revert the student had asked for.
    //
    // The unique indexes guarantee at most one active row, so finding one means there is nothing
    // to restore. `excludeSubmissionId` is honoured here too: the row being rejected does not count
    // as the student's active submission even while its deactivation is still pending.
    let activeProbe = adminSupabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", studentRepo.assignment_id)
      .eq("is_active", true);
    if (excludeSubmissionId !== undefined) {
      activeProbe = activeProbe.neq("id", excludeSubmissionId);
    }
    activeProbe = studentRepo.assignment_group_id
      ? activeProbe.eq("assignment_group_id", studentRepo.assignment_group_id)
      : activeProbe.eq("profile_id", studentRepo.profile_id!).is("assignment_group_id", null);
    const { data: alreadyActive, error: alreadyActiveErr } = await activeProbe.limit(1).maybeSingle();
    if (alreadyActiveErr) throw alreadyActiveErr;
    if (alreadyActive) {
      scope.setTag("reactivate_previous_submission_skipped", "already_active");
      return;
    }

    // Restore what the rejected push displaced, not merely the highest ordinal. After a force-push
    // back to A, A is active while a newer B is inactive; a rejected push C then demotes A, and the
    // ordinal scan below would pick B, so a rejected push would change which accepted work is
    // graded. The probe above has already established that nothing newer has taken the active slot.
    const preferredId =
      displacedSubmissionId !== undefined
        ? displacedSubmissionId
        : excludeSubmissionId !== undefined
          ? await findDisplacedSubmissionId(adminSupabase, excludeSubmissionId)
          : null;
    if (preferredId !== null && preferredId !== excludeSubmissionId) {
      const { data: preferred, error: preferredErr } = await forSubmitter(
        adminSupabase
          .from("submissions")
          .select("id, is_not_graded, ingestion_pending")
          .eq("id", preferredId)
          .eq("assignment_id", studentRepo.assignment_id),
        studentRepo
      ).maybeSingle();
      if (preferredErr) throw preferredErr;
      if (
        preferred &&
        !preferred.is_not_graded &&
        !preferred.ingestion_pending &&
        !(await getRejectionErrorType(adminSupabase, preferred.id))
      ) {
        const { error: promoteErr } = await adminSupabase
          .from("submissions")
          .update({ is_active: true })
          .eq("id", preferred.id);
        if (promoteErr) throw promoteErr;
        scope.setTag("reactivated_previous_submission", String(preferred.id));
        scope.setTag("reactivated_displaced_submission", "true");
        console.log(`Re-activated displaced submission ${preferred.id} after rejecting a push-direct submission`);
        return;
      }
      // Gone, or no longer promotable: fall back to the newest promotable submission.
      scope.setTag("reactivate_displaced_submission_unavailable", String(preferredId));
    }

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
        .eq("is_not_graded", false)
        // Nor a row whose ingestion is unfinished, or whose cleanup started and stopped partway:
        // its files may be missing. A completed submission with no files keeps the flag false.
        .eq("ingestion_pending", false);
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
          .filter((e) => REJECTION_ERROR_TYPES.has((e.data as { error_type?: string } | null)?.error_type ?? ""))
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
 * Deactivates the row and clears any files already written, keeps its
 * `grading_review_id`, and clears `ingestion_pending` in the same write as the
 * deactivation, so a later redelivery reads this intentional record as complete rather
 * than as junk to delete.
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

    // Deactivating is the last step of retaining a rejection, so it also marks the row complete.
    const { error: deactivateErr } = await adminSupabase
      .from("submissions")
      .update({ is_active: false, ingestion_pending: false })
      .eq("id", submissionId);
    if (deactivateErr) throw deactivateErr;
    scope.setTag("rejected_submission_retained", String(submissionId));
    return true;
  } catch (e) {
    scope.setTag("deactivate_rejected_submission_failed", "true");
    Sentry.captureException(e, scope);
    // Leave the row in the INCOMPLETE state so a redelivery retries it. If we failed
    // before the deactivation, the row is still ACTIVE; were it read as complete, the
    // redelivery would return early and an oversized push could stay the student's active
    // submission indefinitely. ingestion_pending is what the idempotency pre-check reads,
    // and the review is unlinked as cleanupPushDirectSubmission does.
    const { error: markErr } = await adminSupabase
      .from("submissions")
      .update({ grading_review_id: null, is_active: false, ingestion_pending: true })
      .eq("id", submissionId);
    if (markErr) {
      scope.setTag("mark_rejected_submission_incomplete_failed", "true");
      Sentry.captureException(markErr, scope);
    }
    return false;
  }
}

// Rolls back a submission this path just created. It clears only the child rows the
// push-direct submission path writes. When it starts writing to a new table that
// references submissions, add the table here too. The foreign keys are NO ACTION, so a
// missed table makes the final delete fail instead of leaving orphans; see "Deleting
// repositories and submissions" in AGENTS.md and scripts/CheckDeletePaths.ts.
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
    //
    // ingestion_pending is set in the same write, so if a later step fails the row is never restored
    // as the student's active submission: it has lost its review and may have lost its files.
    const { error: unlinkErr } = await adminSupabase
      .from("submissions")
      .update({ grading_review_id: null, is_active: false, ingestion_pending: true })
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
