// Decisions that keep a handout sync from overwriting a student's own work.
//
// The sync branch is based on `syncedRepoSha`, so GitHub does a real 3-way merge and a
// student's commits made AFTER the last sync are safe: they appear on the other side of
// the merge and collide as conflicts GitHub reports. Work done BEFORE the last sync is
// not protected by that, because `createBranchAndCommit` writes the template's content
// into the branch on top of it. The overwrite then reads as an intentional change from
// base to head, `pr.mergeable` comes back true, and auto-merge lands it with no conflict
// shown to anyone.
//
// That is not theoretical. On 2026-09-11 a handout sync replaced
// server/src/services/user.service.ts in neu-cs4530/fa26-ip1-Shashankmore20 with the
// template's copy, dropping 16 lines of the student's implementation, and the merge was
// clean. The patch had failed to apply precisely BECAUSE the student had edited the file,
// so the fallback was most destructive exactly where there was most to lose.
//
// The primitive below is the question nothing in the sync used to ask: has the student
// touched this file since the last sync? Git blob shas are content addresses, so the
// student's blob at `syncedRepoSha` and the handout's blob at `fromSha` are equal exactly
// when the file is byte-identical. Anything else means the student's copy is theirs, and
// no sync path may write over it.

import { SYNC_COMMIT_SUBJECT_RE } from "./handoutSyncPush.ts";

/** Why the sync left a file alone instead of writing the handout's version. */
export type UnresolvedReason =
  /** The student's copy differs from the handout copy the update was computed against. */
  | "content_differs"
  /** The file exists only in the student's repo, so the handout is adding a path they already use. */
  | "only_in_your_repo"
  /** The student deleted a file the handout is still changing. */
  | "deleted_in_your_repo"
  /** The path is a directory or submodule in the student's repo, not a file. */
  | "directory_in_your_repo"
  /** A parent of the path is a file in the student's repo, so the directory cannot exist. */
  | "path_blocked_in_your_repo";

export type UnresolvedFile = {
  path: string;
  reason: UnresolvedReason;
};

/** Git object kinds a recursive tree listing can return for a path. */
export type TreeEntryType = "blob" | "tree" | "commit";

/** One path in a repo at one commit. `commit` is a submodule. */
export type TreeEntry = {
  sha: string;
  type: TreeEntryType;
};

/**
 * Decide whether the sync may write over a file.
 *
 * Both arguments are blob shas, or undefined when the path is absent on that side.
 * `studentBlobSha` is read at the last sync point, `handoutBlobSha` at the handout
 * revision the update was computed from.
 *
 * Returns "unmodified" when the two agree, which is the only case where the student's
 * copy is known to be the handout's copy and overwriting costs nothing.
 */
export function classifyStudentFile(
  student: TreeEntry | undefined,
  handout: TreeEntry | undefined
): "unmodified" | UnresolvedReason {
  // A directory or submodule where the handout wants a file is the worst case in this whole
  // module. Writing a blob at that path replaces the tree, which deletes every file the
  // student has underneath it, and a blob-only view of the tree cannot see it coming: both
  // sides look absent and the path reads as a new file nobody owns.
  if (student && student.type !== "blob") return "directory_in_your_repo";

  if (student === undefined && handout === undefined) {
    // Neither side has the path. The handout is adding a genuinely new file and there is
    // nothing of the student's to protect.
    return "unmodified";
  }
  if (student === undefined) return "deleted_in_your_repo";
  if (handout === undefined) return "only_in_your_repo";
  return student.sha === handout.sha ? "unmodified" : "content_differs";
}

/**
 * The student's file that stands where one of this path's parent directories has to go.
 *
 * The inverse of the directory case: the handout adds `foo/bar.ts` while the student has a
 * file called `foo`. Writing the new path requires `foo` to become a directory, so their
 * file is replaced. Returns the blocking path, or undefined when the way is clear.
 */
export function findBlockingAncestor(path: string, student: Map<string, TreeEntry>): string | undefined {
  const segments = path.split("/");
  // Every proper ancestor, shortest first. The path itself is classifyStudentFile's job.
  for (let i = 1; i < segments.length; i++) {
    const ancestor = segments.slice(0, i).join("/");
    if (student.get(ancestor)?.type === "blob") return ancestor;
  }
  return undefined;
}

/** Every proper ancestor of a path, shortest first. */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join("/"));
  }
  return ancestors;
}

/**
 * Paths that a truncated tree cannot answer for, and which therefore need a per-file
 * lookup before any overwrite decision is made.
 *
 * GitHub truncates a recursive tree response for very large repos. A path missing from a
 * truncated tree is unknown, not absent, and reading it as absent would classify the file
 * as unmodified and re-enable the overwrite this module exists to prevent. A complete tree
 * needs no lookups, because a missing path there really is absent.
 */
export function pathsNeedingBlobLookup(
  entries: Map<string, TreeEntry>,
  truncated: boolean,
  paths: readonly string[]
): string[] {
  if (!truncated) return [];
  return paths.filter((path) => !entries.has(path));
}

/**
 * Whether auto-merge may proceed.
 *
 * A sync that left any file to the student is a sync with work still to do in it, so the
 * PR has to stay open for them to finish. This only ever removes auto-merge: a caller that
 * did not ask for it does not get it.
 */
export function resolveAutoMerge(requested: boolean, unresolved: readonly UnresolvedFile[]): boolean {
  return requested && unresolved.length === 0;
}

/**
 * The account GitHub records as the committer when it writes a commit through the API on
 * an App's behalf. Global to github.com rather than specific to a deployment or an org,
 * unlike the App's own login, which differs everywhere this chart is installed.
 */
export const GITHUB_API_COMMITTER_LOGIN = "web-flow";

/** One commit on a sync branch, as much of it as the reset decision needs. */
export type SyncBranchCommit = {
  subject: string;
  /**
   * GitHub account type of the commit's author. "Bot" is the App that writes these
   * commits. Undefined when GitHub could not attribute the commit, which is not a claim
   * that we wrote it.
   */
  authorType?: string;
  /** Login of the committer. Ours is GitHub's own, because GitHub built the commit. */
  committerLogin?: string;
  /** Whether GitHub considers the commit's signature valid. */
  verified?: boolean;
};

/**
 * Whether an existing sync branch can be reset to a new base.
 *
 * The sync force-updates its branch when it already exists, which discards whatever is on
 * it. That is fine while every commit is one of ours, and destroys a student's conflict
 * resolution as soon as it is not.
 *
 * Three things have to hold, and each covers a hole the others leave open.
 *
 * The SUBJECT is a string anyone can type, and this repo has already been bitten by
 * matching on it too loosely: the comments on SYNC_COMMIT_SUBJECT_RE and SYNC_PR_TITLE_RE
 * record ordinary student commits being taken for instructor machinery, which silently
 * discarded a submission on a repo-only assignment. Here the same mistake deletes their
 * commit outright.
 *
 * The AUTHOR being a Bot is necessary and nowhere near sufficient, because `git commit
 * --amend` keeps the original author. A student can check out the sync branch, amend our
 * commit, and hand back something that still says the App wrote it.
 *
 * So the COMMITTER has to be GitHub's own, which is what GitHub records when it builds the
 * commit through the API, AND the signature has to verify. Neither alone is enough:
 *
 *   * Verification alone fails, because a student with commit signing configured produces
 *     a commit GitHub reports as verified. It is their signature, not ours.
 *   * The committer alone fails, because GitHub maps a commit to an account by email, so
 *     setting the committer email to GitHub's makes the login match locally. That commit
 *     cannot be signed with GitHub's key, so verification is what catches it.
 *
 * Note the committer is checked by LOGIN, not by account type. GitHub's committer account
 * is an ordinary User, so requiring type "Bot" on the committer would reject every commit
 * this sync has ever written.
 *
 * Anything unreadable is unsafe, matching this module's stance that a check we cannot make
 * is not a check that passed. The failure direction is a refused reset, which is loud, and
 * never a deleted commit, which is not.
 */
export function isSyncBranchSafeToReset(commits: readonly SyncBranchCommit[]): boolean {
  return commits.every(
    (commit) =>
      commit.authorType === "Bot" &&
      commit.committerLogin === GITHUB_API_COMMITTER_LOGIN &&
      commit.verified === true &&
      SYNC_COMMIT_SUBJECT_RE.test(commit.subject.trim())
  );
}

const REASON_TEXT: Record<UnresolvedReason, string> = {
  content_differs: "you changed this file, so the handout's version was not written over yours",
  only_in_your_repo: "this file is yours; the handout added a file at the same path",
  deleted_in_your_repo: "you deleted this file, so it was not restored or changed",
  directory_in_your_repo: "you have a folder at this path, and writing a file here would delete what is inside it",
  path_blocked_in_your_repo: "you have a file where this path needs a folder, so it was left alone"
};

/**
 * The section of the PR body that tells the student which files the sync did not touch.
 *
 * Returns an empty string when there is nothing to report, so the caller can concatenate
 * it unconditionally.
 */
export function renderUnresolvedSection(unresolved: readonly UnresolvedFile[]): string {
  if (unresolved.length === 0) return "";

  const rows = unresolved
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `- \`${file.path}\` (${REASON_TEXT[file.reason]})`)
    .join("\n");

  return `### Files this update did not change

The instructor changed the files below, and so did you. Your versions are untouched and
this PR does not carry the handout's versions of them, so nothing you wrote is overwritten
when it merges.

${rows}

Apply those changes yourself if you want them. Compare your copy against the handout and
take what you need. This PR will NOT merge on its own while these files are listed, so
merge it when you are ready.

`;
}
