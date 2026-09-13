// Decisions that keep a handout sync from overwriting a student's own work.
//
// The sync branch is based on `syncedRepoSha`, so GitHub does a real 3-way merge and a
// student's commits made AFTER the last sync are safe: they appear on the other side of
// the merge and collide as conflicts GitHub reports. Work done BEFORE the last sync is
// not protected by that, because `createBranchAndCommit` writes the template's content
// into the branch on top of it. The overwrite then reads as an intentional change from
// base to head, `pr.mergeable` comes back true, and auto-merge merges it with no conflict
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

/**
 * The shape of one changed file, as much of it as the merge decision needs. Mirrors the
 * fields of `FileChange` that `createBranchAndCommit` branches on.
 */
export type ChangedFileShape = {
  /** Path in the repo, which decides whether the handout owns the file outright. */
  path: string;
  status?: string;
  isBinary?: boolean;
  /** The file carries a text patch. */
  hasPatch: boolean;
  /** That patch only deletes, which the sync handles by mirroring or removing. */
  patchDeletesFile: boolean;
};

/** What the sync should do with one changed file. */
export type FileAction =
  /** Not the student's. Handle it the way the sync always has. */
  | "write"
  /** The student's, but a normal text patch. Try to merge into their copy; skip if it fails. */
  | "attempt_patch"
  /** The student's, and nothing here can merge. Leave their version completely alone. */
  | "skip"
  /** Already in the state the handout wants. Nothing to write and nothing to report. */
  | "noop";

/**
 * The grading workflow, which the handout owns outright.
 *
 * Written as a literal rather than imported from `GitHubWrapper.ts`, which exports the same
 * path for its own callers: this module is deliberately free of GitHub imports so it can be
 * unit-tested against no mock at all, and pulling octokit in here to read one string would
 * cost every test and every bundle that dependency. `GitHubSyncHelpers.ts` imports both and
 * pins them to each other, so a change to either side fails to compile.
 */
export const GRADE_WORKFLOW_PATH = ".github/workflows/grade.yml";

/**
 * Paths where the handout's state wins over the student's, in both directions.
 *
 * Every other file in this module belongs to the student the moment they touch it. This one
 * does not, because it is not their work: it is the switch that decides whether their
 * submissions get graded at all, and `assignments.has_autograder` is the instructor's answer
 * to that question.
 *
 * `assignment-sync-autograder-workflow` only ever edits the HANDOUT, and relies on
 * `queue_repository_syncs` to carry `grade.yml` downstream to repos that already exist. Its
 * own comments say so. Leaving the file to a student who edited it breaks the toggle in both
 * directions, silently and permanently:
 *
 *   * Turning grading OFF removes `grade.yml` from the handout. The student's copy differs,
 *     so the deletion is skipped, their workflow stays live, and every push keeps consuming
 *     Actions minutes and showing the failing check the toggle exists to remove.
 *   * Turning grading ON adds it back. Their file stands at the same path, so writing it is
 *     skipped and `#submit` dispatches a workflow that is not there, which records nothing
 *     and loses the student's work.
 *
 * The list is exactly one path on purpose. Everything else under `.github/` is the
 * student's to edit, and a wider rule would overwrite work this module is here to protect.
 */
const HANDOUT_OWNED_PATHS: readonly string[] = [GRADE_WORKFLOW_PATH];

/** Whether the handout's version of this path wins whatever the student has done to it. */
export function isHandoutOwnedPath(path: string): boolean {
  return HANDOUT_OWNED_PATHS.includes(path);
}

/**
 * The single decision both the size pre-flight and the commit path ask.
 *
 * They have to agree. Sizing a file the commit path then writes under-counts the budget;
 * sizing a file the commit path skips aborts syncs over bytes nobody reads; and filtering a
 * file out of the sync entirely when it was merge-eligible loses the instructor's change
 * with no PR to show for it.
 *
 * Only one combination merges: a normal text patch against a file whose content differs.
 * That is the case `createBranchAndCommit` applies the patch for, which is the one path
 * that merges the instructor's change INTO the student's work rather than over it. Every
 * other reason, and every other file shape, has no merge available:
 *
 *   * A deletion, a delete-only patch, a binary, or an added file is written wholesale.
 *   * A file the student deleted must stay deleted. Its patch would otherwise apply against
 *     the empty base the 404 handling substitutes, and recreate the file they removed.
 *   * A directory, a submodule, or a blocked path cannot be written at all, and must not
 *     reach the patch handling, where fetching it throws "Path is a directory, not a file".
 *
 * One combination is neither of those: the handout DELETES a file the student had already
 * deleted. Both sides agree the file should be gone and it already is, so there is nothing
 * to write, but reporting it as unresolved would be a false claim ("you deleted this file,
 * so it was not restored") about a deletion that needed no action, and, through
 * `resolveAutoMerge`, would hold the whole pull request open over it. That is "noop".
 *
 * A handout deletion arrives in TWO shapes and both have to reach "noop": status "removed",
 * and status "modified" carrying a patch that only deletes, the `+0,0` form GitHub's
 * compare returns, which is why `patchDeletesEntireFile` exists at all. Matching only the
 * first would leave the second reported and auto-merge held, which is the bug this case was
 * written against.
 *
 * A handout-owned path short-circuits all of that and is handled the way the sync handled
 * every file before this module existed. See `HANDOUT_OWNED_PATHS` for why one path is not
 * the student's to keep. Two of its placements bound that:
 *
 *   * It sits BELOW the "noop" case, because when the handout is deleting the workflow and
 *     the student already deleted it, both sides already agree, and emitting a tree entry
 *     to delete a path that is not in the base tree asks GitHub to remove an object that
 *     does not exist.
 *   * It does not apply to a directory, a submodule, or a path a file of the student's
 *     stands in the way of. Those cannot be written at all: writing the file would replace
 *     what is there, and the text path would throw "Path is a directory, not a file" and fail
 *     the whole sync. Owning a path is permission to overwrite the file at it, never
 *     permission to delete a tree the student is keeping work in.
 */
export function decideFileAction(file: ChangedFileShape, reason: UnresolvedReason | undefined): FileAction {
  if (!reason) return "write";
  // The handout is removing it and the student already removed it. Both sides want the same
  // thing and the repo is already there.
  if (reason === "deleted_in_your_repo" && (file.status === "removed" || file.patchDeletesFile)) return "noop";
  const pathIsWritable = reason !== "directory_in_your_repo" && reason !== "path_blocked_in_your_repo";
  if (isHandoutOwnedPath(file.path) && pathIsWritable) return "write";
  if (reason !== "content_differs") return "skip";
  const mergeableShape = file.hasPatch && !file.isBinary && !file.patchDeletesFile && file.status !== "removed";
  return mergeableShape ? "attempt_patch" : "skip";
}

/** Whether the sync will read and write this file, and so whether its size counts. */
export function countsTowardSyncSize(file: ChangedFileShape, reason: UnresolvedReason | undefined): boolean {
  const action = decideFileAction(file, reason);
  return action === "write" || action === "attempt_patch";
}

/** Git object kinds a recursive tree listing can return for a path. */
export type TreeEntryType = "blob" | "tree" | "commit";

/** One path in a repo at one commit. `commit` is a submodule. */
export type TreeEntry = {
  sha: string;
  type: TreeEntryType;
};

/**
 * One path in a repo at one commit: what kind of object stands there, its content address,
 * and how big it is when it is a blob.
 *
 * The three travel together because GitHub returns them together. A recursive tree listing
 * carries `type`, `sha` and `size` on the same item, so a caller that wants sizes and a
 * caller that wants blob shas are asking for one response, not two.
 */
export type RepoTreeEntry = TreeEntry & { size?: number };

export type RepoTree = {
  entries: Map<string, RepoTreeEntry>;
  /**
   * GitHub truncated the listing. A path missing from a truncated tree is unknown, not
   * absent, and reading it as absent would classify a file as unmodified and re-enable the
   * overwrite this module exists to prevent. Returned rather than only logged so the caller
   * can resolve those paths one at a time.
   */
  truncated: boolean;
};

const TREE_TYPE_CODES: Record<TreeEntryType, number> = { blob: 0, tree: 1, commit: 2 };
const TREE_TYPES_BY_CODE: TreeEntryType[] = ["blob", "tree", "commit"];

/** One cached entry: path, type code, and -- for blobs only -- sha and size. */
type CachedTreeRow = [string, number] | [string, number, string] | [string, number, string, number];

/**
 * Pack a tree into the smallest honest JSON.
 *
 * The obvious encoding -- an array of `[path, {sha, type}]` pairs -- spends about 24 characters
 * per entry on repeated key names, which on a 20k-file repo is half a megabyte of the word
 * "sha". Positional rows drop that, and a tree or submodule row stops after its type code,
 * because a non-blob entry is read for its type alone: `classifyStudentFile` answers
 * "directory_in_your_repo" before it ever compares a sha, and `findBlockingAncestor` only
 * asks whether the entry is a tree.
 */
export function encodeRepoTree(tree: RepoTree): string {
  const rows: CachedTreeRow[] = [];
  for (const [path, entry] of tree.entries) {
    const code = TREE_TYPE_CODES[entry.type];
    if (entry.type !== "blob") {
      rows.push([path, code]);
    } else if (typeof entry.size === "number") {
      rows.push([path, code, entry.sha, entry.size]);
    } else {
      rows.push([path, code, entry.sha]);
    }
  }
  return JSON.stringify({ v: 1, t: tree.truncated ? 1 : 0, e: rows });
}

/**
 * Read a cached tree back, or undefined when the value is not one.
 *
 * Undefined means "fetch it again", which is the only safe reading of a value we cannot
 * parse: inventing an empty tree from a malformed cache entry would report every path as
 * absent, and absent is the answer that permits the overwrite.
 */
export function decodeRepoTree(cached: unknown): RepoTree | undefined {
  const parsed = (typeof cached === "string" ? safeJsonParse(cached) : cached) as
    | { v?: number; t?: number; e?: CachedTreeRow[] }
    | undefined;
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.e)) return undefined;

  const entries = new Map<string, RepoTreeEntry>();
  for (const row of parsed.e) {
    const [path, code, sha, size] = row as [string, number, string?, number?];
    const type = TREE_TYPES_BY_CODE[code];
    if (typeof path !== "string" || !type) return undefined;
    // A blob with no sha would be two content addresses that compare equal to each other and
    // to nothing real, which reads as "unmodified" and permits the overwrite. Only a tree or
    // a submodule may arrive without one, matching what a per-path lookup returns.
    if (type === "blob" && !sha) return undefined;
    entries.set(path, { sha: sha ?? "", type, size });
  }
  return { entries, truncated: parsed.t === 1 };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

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

/** Every proper ancestor of a path, shortest first. Never the path itself. */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join("/"));
  }
  return ancestors;
}

/**
 * The student's file that stands where one of this path's parent directories has to go.
 *
 * The inverse of the directory case: the handout adds `foo/bar.ts` while the student has a
 * file called `foo`. Writing the new path requires `foo` to become a directory, so their
 * file is replaced. Returns the blocking path, or undefined when the way is clear.
 *
 * Enumerated with `ancestorPaths` rather than a second copy of the same loop, because
 * `findStudentModifiedFiles` uses that function to decide which ancestors to LOOK UP on a
 * truncated tree and this one to decide which ones BLOCK: two loops that disagreed about
 * what an ancestor is would look up one set and test another, and the failure direction is
 * a missed block, which is an overwrite of the student's file.
 */
export function findBlockingAncestor(path: string, student: Map<string, TreeEntry>): string | undefined {
  // Anything that is not a directory blocks, not just a file. A submodule at `vendor`
  // is a `commit` entry, and writing vendor/config.ts through it replaces the gitlink,
  // which loses the student's pinned revision as surely as overwriting a file.
  return ancestorPaths(path).find((ancestor) => {
    const entry = student.get(ancestor);
    return !!entry && entry.type !== "tree";
  });
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
 * The account GitHub records as the committer when GitHub itself builds a commit: the web
 * editor, the Contents API, the merge API. Global to github.com rather than specific to a
 * deployment or an org, unlike the App's own login, which differs everywhere this chart is
 * installed.
 *
 * NOT the committer of the commits this sync writes. `createBranchAndCommit` builds those
 * with the Git Database API (`POST /git/commits`), which records the App's own
 * `<slug>[bot]` account and leaves them unsigned. See `isOurSyncCommit`.
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
  /** Login of the committer. */
  committerLogin?: string;
  /**
   * GitHub account type of the commit's committer. "Bot" for a commit the App itself
   * committed, which is what the Git Database API produces.
   */
  committerType?: string;
  /** Whether GitHub considers the commit's signature valid. */
  verified?: boolean;
};

/**
 * Whether one commit on a sync branch is one this sync wrote.
 *
 * The SUBJECT is a string anyone can type, and this repo has already lost work to matching
 * on it too loosely: the comments on SYNC_COMMIT_SUBJECT_RE and SYNC_PR_TITLE_RE record
 * ordinary student commits being taken for instructor machinery, which silently discarded a
 * submission on a repo-only assignment. Here the same mistake deletes their commit outright.
 * So the subject is necessary and never sufficient.
 *
 * The AUTHOR being a Bot is also necessary and not sufficient, because `git commit --amend`
 * keeps the original author. A student can check out the sync branch, amend our commit, and
 * hand back something that still says the App wrote it.
 *
 * What separates the two is the COMMITTER, which an amend always rewrites to the person who
 * amended. There are two shapes it legitimately takes, because two different APIs write
 * commits into these repos:
 *
 *   * `createBranchAndCommit` builds the sync commit with the Git Database API
 *     (`POST /git/blobs` -> `POST /git/trees` -> `POST /git/commits`) and passes no
 *     `author`, no `committer` and no `signature`. GitHub fills both identities from the
 *     installation token, so the committer is the App's own `<slug>[bot]` account, an
 *     account of type "Bot", and the commit is UNSIGNED. Requiring `web-flow` or
 *     `verified` here would reject every commit this sync has ever written, refuse every
 *     branch reset, and leave the repository permanently unsyncable.
 *   * Anything GitHub builds on our behalf (the merge API, the Contents API) is committed
 *     by GitHub's own `web-flow` account and IS signed with GitHub's key.
 *
 * Checking the committer by TYPE rather than by login is what makes the first shape work on
 * any deployment: the App's login differs everywhere this chart is installed, and hardcoding
 * one would be wrong on GitHub Enterprise Server. A student's amend gives a committer of
 * type "User", so it is still rejected. A different bot's commit would have to also carry
 * our anchored, sha-qualified subject to pass, which Dependabot and friends do not.
 *
 * Anything unreadable is unsafe, matching this module's stance that a check we cannot make
 * is not a check that passed. The failure direction is a refused reset, which is loud, and
 * never a deleted commit, which is not.
 */
export function isOurSyncCommit(commit: SyncBranchCommit): boolean {
  if (commit.authorType !== "Bot") return false;
  if (!SYNC_COMMIT_SUBJECT_RE.test(commit.subject.trim())) return false;
  // GitHub built it: its own account, its own signature.
  if (commit.committerLogin === GITHUB_API_COMMITTER_LOGIN && commit.verified === true) return true;
  // We built it with the Git Database API: committed by the App, unsigned.
  return commit.committerType === "Bot";
}

/**
 * Whether an existing sync branch can be reset to a new base.
 *
 * The sync force-updates its branch when it already exists, which discards whatever is on
 * it. That is fine while every commit is one of ours, and destroys a student's conflict
 * resolution as soon as it is not.
 */
export function isSyncBranchSafeToReset(commits: readonly SyncBranchCommit[]): boolean {
  return commits.every(isOurSyncCommit);
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
/**
 * How many files the section names before it stops and says how many are left.
 *
 * A pull request body is capped at 65536 characters and `createPullRequest` neither
 * truncates nor retries: an over-long body is a 422 that matches none of the recovery
 * branches, so it throws AFTER the branch and commit already exist and takes the whole sync
 * with it. Each row here costs around 100 characters, and a handout-wide reformat can leave
 * hundreds of files to the student at once, so the list has to have an end. A reader who
 * needs all of them has `sync_data.unresolved_paths`, which is not length-limited.
 */
const MAX_UNRESOLVED_ROWS = 200;

export function renderUnresolvedSection(unresolved: readonly UnresolvedFile[]): string {
  if (unresolved.length === 0) return "";

  const sorted = unresolved.slice().sort((a, b) => a.path.localeCompare(b.path));
  const shown = sorted.slice(0, MAX_UNRESOLVED_ROWS);
  const rows =
    shown.map((file) => `- \`${file.path}\` (${REASON_TEXT[file.reason]})`).join("\n") +
    (sorted.length > shown.length ? `\n- ...and ${sorted.length - shown.length} more` : "");

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
