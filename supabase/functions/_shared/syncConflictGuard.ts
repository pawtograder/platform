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

/**
 * Git file modes, as the tree API reports them. A blob arrives as one of the first three.
 *
 * The mode is part of what a file IS, not decoration on it: 100755 is an executable script and
 * 100644 is the same bytes that will not run, and 120000 is a symlink whose "content" is the
 * path it points at. Two entries with equal blob shas and different modes are NOT the same
 * file, which is why `classifyStudentFile` compares them.
 */
export type BlobMode = "100644" | "100755" | "120000";
export const BLOB_MODES: readonly BlobMode[] = ["100644", "100755", "120000"];

/**
 * Whether a mode is one a blob tree entry may carry, narrowing it when it is.
 *
 * A type guard rather than a boolean because the tree-write API takes the mode as a union of
 * literals, and the whole point of carrying modes is that the one written is the one read: a
 * cast in between would let a "040000" out of a tree listing be handed to a blob entry.
 */
export function isBlobMode(mode: string | undefined): mode is BlobMode {
  return !!mode && (BLOB_MODES as readonly string[]).includes(mode);
}

/**
 * One path in a repo at one commit. `commit` is a submodule.
 *
 * `mode` is undefined when the source could not report one: the Contents API, which the
 * truncated-tree fallback uses, returns no mode at all. Undefined means "unknown", never
 * "100644" -- see `classifyStudentFile` for why a comparison against an unknown mode is not
 * allowed to claim the two sides differ OR agree.
 */
export type TreeEntry = {
  sha: string;
  type: TreeEntryType;
  mode?: string;
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

/**
 * Modes as one character rather than six, for the same reason the type is a code: this value
 * is repeated once per file in a repository, and a 20k-file tree pays for every character of
 * it. `MODE_UNKNOWN` is a real value, not a default -- it is what a mode the source could not
 * report round-trips as.
 */
const MODE_UNKNOWN = 9;
const TREE_MODE_CODES: Record<string, number> = {
  "100644": 0,
  "100755": 1,
  "120000": 2,
  "040000": 3,
  "160000": 4
};
const TREE_MODES_BY_CODE: Record<number, string> = {
  0: "100644",
  1: "100755",
  2: "120000",
  3: "040000",
  4: "160000"
};

/** One cached entry: path, type code, content address, mode code, and -- for blobs -- size. */
type CachedTreeRow = [string, number, string, number] | [string, number, string, number, number];

/**
 * The cache format version, which is part of the Redis key (see `getRepoTree`).
 *
 * Bumped to 2 when non-blob entries started carrying their sha, and to 3 when every entry
 * started carrying its mode. Both are fields `classifyStudentFile` compares, and both have the
 * same failure shape if a value written by an older version is read by a newer one: two
 * absent fields compare equal, the path reads as "unmodified", and the overwrite this module
 * exists to prevent is permitted. The version is part of the KEY, not just the payload, so an
 * older value is never read at all -- and this Redis is shared across previews, staging and
 * production, so an old shape really can be sitting in it. The old keys expire on their own.
 */
export const REPO_TREE_CACHE_VERSION = 3;

/**
 * Pack a tree into the smallest honest JSON.
 *
 * The obvious encoding -- an array of `[path, {sha, type}]` pairs -- spends about 24 characters
 * per entry on repeated key names, which on a 20k-file repo is half a megabyte of the word
 * "sha". Positional rows drop that. A row stops after the sha unless the entry has a size,
 * which only blobs do.
 *
 * The sha is kept for a tree and a submodule too, and that is not symmetry for its own sake:
 * `classifyStudentFile` compares them. A directory the student has exactly as the handout had
 * it is a matching tree sha, and dropping the sha made that case indistinguishable from a
 * directory full of their own work.
 */
export function encodeRepoTree(tree: RepoTree): string {
  const rows: CachedTreeRow[] = [];
  for (const [path, entry] of tree.entries) {
    const code = TREE_TYPE_CODES[entry.type];
    const modeCode = entry.mode !== undefined ? (TREE_MODE_CODES[entry.mode] ?? MODE_UNKNOWN) : MODE_UNKNOWN;
    if (typeof entry.size === "number") {
      rows.push([path, code, entry.sha, modeCode, entry.size]);
    } else {
      rows.push([path, code, entry.sha, modeCode]);
    }
  }
  return JSON.stringify({ v: REPO_TREE_CACHE_VERSION, t: tree.truncated ? 1 : 0, e: rows });
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
  if (!parsed || parsed.v !== REPO_TREE_CACHE_VERSION || !Array.isArray(parsed.e)) return undefined;

  const entries = new Map<string, RepoTreeEntry>();
  for (const row of parsed.e) {
    const [path, code, sha, modeCode, size] = row as [string, number, string?, number?, number?];
    const type = TREE_TYPES_BY_CODE[code];
    if (typeof path !== "string" || !type) return undefined;
    // A blob with no sha would be two content addresses that compare equal to each other and
    // to nothing real, which reads as "unmodified" and permits the overwrite. Only a tree or
    // a submodule may arrive without one, matching what a per-path lookup returns.
    if (type === "blob" && !sha) return undefined;
    // A row that stopped before its mode is a value from a shape this version does not write.
    // Reading it as "mode unknown" would be inventing agreement out of a missing field, so it
    // is a cache miss instead.
    if (typeof modeCode !== "number") return undefined;
    entries.set(path, { sha: sha ?? "", type, mode: TREE_MODES_BY_CODE[modeCode], size });
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
  //
  // Unless the handout had the same thing there. A handout that replaces a directory with a
  // file at the same path shows up here as a tree on the student's side, and on an untouched
  // repository that tree is the handout's own, sha for sha. Blaming the student for it
  // reported a file as theirs that they had never opened AND left the update half-applied:
  // the new file was skipped while the removals beneath the old directory went through, which
  // is a state no auto-merge can complete.
  //
  // Only an exact match, and only with real shas on both sides. A matching tree sha means the
  // subtree is byte-identical, which is what makes the rest of the update coherent: the files
  // the handout diff removes under that path are exactly the files standing there, so the tree
  // this sync builds empties the directory and writes the blob in its place. A per-path lookup
  // on a truncated tree answers a directory with an empty sha (`fetchTreeEntryAtRef`), and two
  // empty shas comparing equal would be the overwrite again, so an absent sha never matches.
  if (student && student.type !== "blob") {
    const handoutHasTheSameThing =
      !!handout && handout.type === student.type && !!student.sha && student.sha === handout.sha;
    if (!handoutHasTheSameThing) return "directory_in_your_repo";
    return "unmodified";
  }

  if (student === undefined && handout === undefined) {
    // Neither side has the path. The handout is adding a genuinely new file and there is
    // nothing of the student's to protect.
    return "unmodified";
  }
  if (student === undefined) return "deleted_in_your_repo";
  if (handout === undefined) return "only_in_your_repo";
  if (student.sha !== handout.sha) return "content_differs";
  // Same bytes, and still possibly not the same file. A student who made a tracked script
  // executable changed its MODE and nothing else, so the blob shas match while their 100755
  // differs from the handout's 100644 -- and the sync writes a tree entry, which carries a
  // mode, so calling that "unmodified" hands back the change as a clean auto-merge that
  // quietly un-executes their script. A symlink against a regular file with the same bytes is
  // the same trap with worse consequences.
  //
  // Only when BOTH modes are known. The Contents API, which the truncated-tree fallback reads,
  // reports no mode at all, and an unknown mode must not be read as agreement (that is the
  // overwrite) or as difference (that would report every path in a large repository as the
  // student's work). Unknown means the sha comparison stands on its own, which is where this
  // module was before modes were carried at all.
  if (student.mode && handout.mode && student.mode !== handout.mode) return "content_differs";
  return "unmodified";
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
export function findBlockingAncestor(
  path: string,
  student: Map<string, TreeEntry>,
  handout?: Map<string, TreeEntry>
): string | undefined {
  // Anything that is not a directory blocks, not just a file. A submodule at `vendor`
  // is a `commit` entry, and writing vendor/config.ts through it replaces the gitlink,
  // which loses the student's pinned revision as surely as overwriting a file.
  //
  // Unless the handout put it there. This is the mirror of the directory case in
  // `classifyStudentFile`: a handout that replaces a FILE at `config` with a directory
  // containing `config/settings.ts` leaves an untouched repository holding the old handout's
  // own `config` blob, and blaming the student for it skipped the new file while the removal
  // of `config` went through -- an incomplete structural update that cannot auto-merge, and a
  // file reported as theirs that they never touched. An exact match with real shas on both
  // sides is what makes the rest coherent: the entry standing in the way is exactly the one
  // the handout diff removes, so the tree this sync builds deletes it and writes the
  // directory in its place. `handout` is optional because two callers ask this question and
  // only one of them has a handout tree to compare against; without one, every non-tree
  // ancestor blocks, as it did before.
  return ancestorPaths(path).find((ancestor) => {
    const entry = student.get(ancestor);
    if (!entry || entry.type === "tree") return false;
    const handoutEntry = handout?.get(ancestor);
    const handoutPutItThere =
      !!handoutEntry && handoutEntry.type === entry.type && !!entry.sha && entry.sha === handoutEntry.sha;
    return !handoutPutItThere;
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
