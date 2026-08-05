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

/** Title prefix used by `syncRepositoryToHandout` for its sync PRs. */
export const SYNC_PR_TITLE_PREFIX = "[Instructor Update]";

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

  // Route 1: GitHub's auto-merge commit for a `sync-to-*` PR. Match the branch
  // name inside the merge message rather than the whole message, so it survives
  // "Merge pull request #12 from org/repo-sync-to-abc1234" formatting variants.
  if (headCommitMessage) {
    if (headCommitMessage.includes(SYNC_BRANCH_PREFIX) && /merge pull request/i.test(headCommitMessage)) {
      return true;
    }
    if (headCommitMessage.includes(SYNC_PR_TITLE_PREFIX)) {
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
