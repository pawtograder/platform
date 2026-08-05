// Pure predicate for "was this push to a student repo made by the handout-sync
// machinery rather than by the student?". Extracted so it can be unit-tested
// without a webhook payload fixture or a GitHub mock.
//
// This matters for repo-only assignments (no autograder), where EVERY student
// push becomes a submission. Instructor-driven handout syncs also land on the
// student repo's default branch, and without this check they would silently
// become the student's newest active submission.
//
// Sync pushes arrive by two routes, and each leaves a different fingerprint:
//
//  1. `template_pr` — the worker opens a `sync-to-<sha7>` branch, titles the PR
//     `[Instructor Update] Sync handout to <sha7>`, and auto-merges it. The
//     resulting push to the default branch carries GitHub's merge-commit
//     message, which names the `sync-to-` branch.
//  2. `fork_merge_upstream` — GitHub's merge-upstream API fast-forwards the
//     fork, so the repo's head becomes *exactly* the handout's head commit.
//     There is no distinguishing commit message, so we match on the SHA
//     instead.
//
// Both checks are conservative: a false positive costs the student one
// submission for a push whose head is byte-identical to the handout (nothing of
// their own in it), while a false negative would fabricate a submission the
// student never made.

/** Branch prefix used by `syncRepositoryToHandout` for its sync PRs. */
export const SYNC_BRANCH_PREFIX = "sync-to-";

/**
 * The full generated sync branch name: `sync-to-` followed by an abbreviated commit
 * sha (`toSha.substring(0, 7)` in `syncRepositoryToHandout`). Requiring the hex
 * suffix — and a word boundary before it — is what separates instructor machinery
 * from a student branch that merely starts with the same words.
 */
export const SYNC_BRANCH_NAME_RE = /(?:^|[\s/])sync-to-[0-9a-f]{7,40}\b/;

/** Title prefix used by `syncRepositoryToHandout` for its sync PRs. */
export const SYNC_PR_TITLE_PREFIX = "[Instructor Update]";

/**
 * Subject prefix of the COMMIT `syncRepositoryToHandout` creates on the sync branch
 * (`Sync handout updates to <sha7>`). Distinct from the PR title, and the only marker that
 * survives a squash or rebase merge: those replay the commit's own message, not the PR
 * title, so without this a sync landed by anything other than a merge commit reads as
 * student work.
 */
export const SYNC_COMMIT_MESSAGE_PREFIX = "Sync handout updates to";

export type HandoutSyncPushInputs = {
  /** `head_commit.message` of the push, if any. */
  headCommitMessage: string | null | undefined;
  /** `payload.after` — the new head sha of the pushed ref. */
  afterSha: string | null | undefined;
  /** The handout's current head sha (`assignments.latest_template_sha`). */
  latestTemplateSha: string | null | undefined;
  /** Handout sha this repo is being moved to (`repositories.desired_handout_sha`). */
  desiredHandoutSha: string | null | undefined;
  /** Handout sha this repo last reached (`repositories.synced_handout_sha`). */
  syncedHandoutSha: string | null | undefined;
  /** Repo-side sha the last sync produced (`repositories.synced_repo_sha`). */
  syncedRepoSha: string | null | undefined;
};

/**
 * True when the push looks like handout-sync machinery rather than student work.
 *
 * `synced_handout_sha` is deliberately treated as a sync marker even though it
 * describes an *already completed* sync: on a fast-forward the repo head equals
 * that handout sha, so a student push can only match it by containing no work of
 * their own.
 */
export function isHandoutSyncPush(inputs: HandoutSyncPushInputs): boolean {
  const { headCommitMessage, afterSha } = inputs;

  // Route 1: the sync PR landing on the default branch. Three shapes, because the merge
  // method is not ours to choose: the worker requests `merge_method: "merge"`, but that is
  // rejected outright on a repo where merge commits are disabled, leaving the PR for
  // someone to land with Squash or Rebase instead.
  if (headCommitMessage) {
    // Squash or rebase: the sync commit's own message is replayed, and the sync PR has
    // exactly one commit so GitHub uses that commit's subject rather than the PR title.
    // Neither `sync-to-` nor the PR-title prefix appears anywhere in it.
    if (headCommitMessage.split("\n").some((line) => line.trimStart().startsWith(SYNC_COMMIT_MESSAGE_PREFIX))) {
      return true;
    }
    // Merge-commit shape: "Merge pull request #N from <owner>/sync-to-<sha7>". Matched
    // against the FULL generated branch name, not a bare `sync-to-` substring — the
    // worker always names the branch `sync-to-<short sha>`, so requiring the hex suffix
    // keeps a student branch called e.g. `sync-to-tests` from being mistaken for
    // instructor machinery. On a repo-only assignment that push IS the submission, so a
    // false positive here silently discards their work.
    if (/merge pull request/i.test(headCommitMessage) && SYNC_BRANCH_NAME_RE.test(headCommitMessage)) {
      return true;
    }
    // Squash-merged sync PR: the commit message is the PR title, so the prefix is at
    // the START of a line. Anchored deliberately — a bare `includes` matched anywhere in
    // the message, so a student writing "fixing what [Instructor Update] broke" had that
    // push silently discarded instead of recorded as their submission.
    if (headCommitMessage.split("\n").some((line) => line.trimStart().startsWith(SYNC_PR_TITLE_PREFIX))) {
      return true;
    }
  }

  // Route 2: fork fast-forward — the repo head IS a handout sha we know about.
  if (!afterSha) return false;
  const syncShas = [inputs.latestTemplateSha, inputs.desiredHandoutSha, inputs.syncedHandoutSha, inputs.syncedRepoSha];
  // Full-SHA equality only. Short-prefix matching has caused truncated-SHA
  // false positives elsewhere in this codebase, and a false positive here means
  // dropping a real submission.
  return syncShas.some((sha) => !!sha && sha === afterSha);
}
