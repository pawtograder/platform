/**
 * Unit tests for the handout sync's student-work guard.
 *
 * These pin the decisions that stand between an instructor's update and a student's own
 * code. On 2026-09-11 a sync replaced server/src/services/user.service.ts in
 * neu-cs4530/fa26-ip1-Shashankmore20 with the handout's copy and auto-merged it, dropping
 * 16 lines the student had written. The merge was clean, because the overwrite happened
 * while the branch was being built and so never reached git as a conflict. Every case
 * below is a step on the path that produced that.
 *
 * Run from supabase/functions:  deno test --no-check _shared/syncConflictGuard.test.ts
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  ancestorPaths,
  classifyStudentFile,
  countsTowardSyncSize,
  decideFileAction,
  findBlockingAncestor,
  isSyncBranchSafeToReset,
  pathsNeedingBlobLookup,
  renderUnresolvedSection,
  resolveAutoMerge,
  type ChangedFileShape,
  type SyncBranchCommit,
  type TreeEntry,
  type UnresolvedFile
} from "./syncConflictGuard.ts";

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);
const blob = (sha: string): TreeEntry => ({ sha, type: "blob" });
/**
 * A commit the sync wrote, shaped like the real thing. The field values are taken from
 * production commits: `khoury-pawtograder[bot]` authors, GitHub's own `web-flow` account
 * commits, and GitHub signs it.
 */
const ours = (sha = "abc1234"): SyncBranchCommit => ({
  subject: `Sync handout updates to ${sha}`,
  authorType: "Bot",
  committerLogin: "web-flow",
  verified: true
});

Deno.test("a file the student has not touched is safe to overwrite", () => {
  assertEquals(classifyStudentFile(blob(BLOB_A), blob(BLOB_A)), "unmodified");
});

// The Shashankmore20 case: same path, different content, and the overwrite that followed.
Deno.test("a file whose content differs is the student's", () => {
  assertEquals(classifyStudentFile(blob(BLOB_A), blob(BLOB_B)), "content_differs");
});

Deno.test("a file only the student has is theirs", () => {
  assertEquals(classifyStudentFile(blob(BLOB_A), undefined), "only_in_your_repo");
});

Deno.test("a file the student deleted stays deleted", () => {
  assertEquals(classifyStudentFile(undefined, blob(BLOB_A)), "deleted_in_your_repo");
});

// A handout adding a path neither side has yet is the ordinary case, not a conflict.
Deno.test("a path absent on both sides is not a conflict", () => {
  assertEquals(classifyStudentFile(undefined, undefined), "unmodified");
});

// The case a blob-only view of the tree could not see. Both sides read as absent, the path
// looked like a new file nobody owned, and writing a blob there replaces the tree, deleting
// every file the student keeps under it while auto-merge stays on.
Deno.test("a directory where the handout wants a file is never overwritten", () => {
  assertEquals(classifyStudentFile({ sha: BLOB_A, type: "tree" }, undefined), "directory_in_your_repo");
  assertEquals(classifyStudentFile({ sha: BLOB_A, type: "tree" }, blob(BLOB_B)), "directory_in_your_repo");
});

Deno.test("a submodule is treated the same as a directory", () => {
  assertEquals(classifyStudentFile({ sha: BLOB_A, type: "commit" }, blob(BLOB_B)), "directory_in_your_repo");
});

// The inverse: the handout adds foo/bar.ts and the student has a FILE called foo, so the
// new path cannot exist without replacing it.
Deno.test("a file standing where a parent directory has to go blocks the path", () => {
  const student = new Map<string, TreeEntry>([["server", blob(BLOB_A)]]);
  assertEquals(findBlockingAncestor("server/src/models.ts", student), "server");
});

Deno.test("a clear path has no blocking ancestor", () => {
  const student = new Map<string, TreeEntry>([
    ["server", { sha: BLOB_A, type: "tree" }],
    ["server/src", { sha: BLOB_B, type: "tree" }]
  ]);
  assertEquals(findBlockingAncestor("server/src/models.ts", student), undefined);
  assertEquals(findBlockingAncestor("README.md", student), undefined);
});

Deno.test("ancestors are every proper parent, shortest first, and never the path itself", () => {
  assertEquals(ancestorPaths("server/src/services/user.service.ts"), ["server", "server/src", "server/src/services"]);
  assertEquals(ancestorPaths("README.md"), []);
});

// The failure this is written against: a truncated tree omits paths it does not disprove.
// Reading those as absent would classify the file "unmodified" and hand the overwrite back.
Deno.test("a truncated tree forces a per-file lookup for the paths it did not answer", () => {
  const entries = new Map<string, TreeEntry>([["kept.ts", blob(BLOB_A)]]);
  assertEquals(pathsNeedingBlobLookup(entries, true, ["kept.ts", "missing.ts"]), ["missing.ts"]);
});

Deno.test("a complete tree needs no lookups, because a missing path there is really absent", () => {
  const entries = new Map<string, TreeEntry>([["kept.ts", blob(BLOB_A)]]);
  assertEquals(pathsNeedingBlobLookup(entries, false, ["kept.ts", "missing.ts"]), []);
});

Deno.test("auto-merge survives a sync that touched nothing of the student's", () => {
  assertEquals(resolveAutoMerge(true, []), true);
});

Deno.test("one unresolved file holds the pull request open", () => {
  const unresolved: UnresolvedFile[] = [{ path: "server/src/services/user.service.ts", reason: "content_differs" }];
  assertEquals(resolveAutoMerge(true, unresolved), false);
});

// The gate only ever removes auto-merge. A caller that did not ask for it must not get it
// just because the sync happened to be clean.
Deno.test("a caller that did not request auto-merge still does not get it", () => {
  assertEquals(resolveAutoMerge(false, []), false);
});

Deno.test("a sync branch carrying only our commits can be reset", () => {
  assertEquals(isSyncBranchSafeToReset([ours("abc1234"), ours("9f8e7d6")]), true);
});

// A student resolving the update by hand pushes to this branch. Force-updating it then
// deletes the resolution, which is the same class of loss as overwriting the file.
Deno.test("a sync branch with someone else's commit is not ours to reset", () => {
  const student: SyncBranchCommit = {
    subject: "fix merge conflict in user.service",
    authorType: "User",
    committerLogin: "student42",
    verified: false
  };
  assertEquals(isSyncBranchSafeToReset([ours(), student]), false);
});

// `git commit --amend` keeps the original AUTHOR, so a student amending our commit hands
// back something that still says the App wrote it and still carries our subject. The
// committer is the give-away: theirs, not GitHub's.
Deno.test("an amended commit is not ours, even though the author survives the amend", () => {
  const amended: SyncBranchCommit = {
    subject: "Sync handout updates to abc1234",
    authorType: "Bot",
    committerLogin: "student42",
    verified: false
  };
  assertEquals(isSyncBranchSafeToReset([amended]), false);
});

// The same amend from a student who has commit signing set up. GitHub reports the commit
// as verified, because the signature is valid; it is just not ours.
Deno.test("a verified signature is not ours when the committer is the student", () => {
  const signedAmend: SyncBranchCommit = {
    subject: "Sync handout updates to abc1234",
    authorType: "Bot",
    committerLogin: "student42",
    verified: true
  };
  assertEquals(isSyncBranchSafeToReset([signedAmend]), false);
});

// GitHub maps a commit to an account by email, so committing as GitHub's own address makes
// the committer login match. Signing is what that cannot fake.
Deno.test("a spoofed committer without a valid signature is not ours", () => {
  const spoofed: SyncBranchCommit = {
    subject: "Sync handout updates to abc1234",
    authorType: "Bot",
    committerLogin: "web-flow",
    verified: false
  };
  assertEquals(isSyncBranchSafeToReset([spoofed]), false);
});

// The subject is a string anyone can type. handoutSyncPush.ts records this repo already
// misclassifying student commits as instructor machinery once, which silently discarded a
// submission on a repo-only assignment; here the same mistake deletes the commit.
Deno.test("a student commit wearing our subject line is still not ours", () => {
  const impostor: SyncBranchCommit = {
    subject: "Sync handout updates to deadbee",
    authorType: "User",
    committerLogin: "student42",
    verified: false
  };
  assertEquals(isSyncBranchSafeToReset([impostor]), false);
});

// A check we cannot make is not a check that passed.
Deno.test("an unattributed commit is not safe to reset", () => {
  assertEquals(isSyncBranchSafeToReset([{ subject: "Sync handout updates to abc1234" }]), false);
});

// Requiring account type "Bot" on the COMMITTER would have rejected every commit this sync
// has ever written, because GitHub's committer account is an ordinary User.
Deno.test("our own commits pass, with GitHub as an ordinary User committer", () => {
  assertEquals(isSyncBranchSafeToReset([{ ...ours(), committerLogin: "web-flow" }]), true);
});

Deno.test("a branch with no commits ahead of the base is trivially resettable", () => {
  assertEquals(isSyncBranchSafeToReset([]), true);
});

// A commit subject that merely mentions the sync must not pass as ours.
Deno.test("a subject that only looks like ours does not pass, even from the App", () => {
  assertEquals(isSyncBranchSafeToReset([{ ...ours(), subject: 'Revert "Sync handout updates to abc1234"' }]), false);
  assertEquals(isSyncBranchSafeToReset([{ ...ours(), subject: "Sync handout updates to my own branch" }]), false);
});

// A normal text patch, the shape the sync can actually merge.
const textPatch: ChangedFileShape = { status: "modified", isBinary: false, hasPatch: true, patchDeletesFile: false };

// The one combination that merges. createBranchAndCommit applies the patch to the student's
// own content, which is the outcome worth having, so it is fetched and written and its size
// has to count. The previous version filtered these out of the sync entirely, which lost the
// instructor's change with no PR to show for it.
Deno.test("a text file the student edited is still patched, and still counts toward size", () => {
  assertEquals(decideFileAction(textPatch, "content_differs"), "attempt_patch");
  assertEquals(countsTowardSyncSize(textPatch, "content_differs"), true);
});

Deno.test("a file nobody has touched is written normally", () => {
  assertEquals(decideFileAction(textPatch, undefined), "write");
  assertEquals(countsTowardSyncSize(textPatch, undefined), true);
});

// Every other shape of a content_differs file is written wholesale, so there is no merge to
// attempt and no reason to weigh bytes nobody reads.
Deno.test("content_differs on a shape with no merge available is skipped and not sized", () => {
  const shapes: Record<string, ChangedFileShape> = {
    binary: { status: "modified", isBinary: true, hasPatch: false, patchDeletesFile: false },
    added: { status: "added", isBinary: false, hasPatch: false, patchDeletesFile: false },
    removed: { status: "removed", isBinary: false, hasPatch: true, patchDeletesFile: false },
    deleteOnlyPatch: { status: "modified", isBinary: false, hasPatch: true, patchDeletesFile: true }
  };
  for (const [name, shape] of Object.entries(shapes)) {
    assertEquals(decideFileAction(shape, "content_differs"), "skip", name);
    assertEquals(countsTowardSyncSize(shape, "content_differs"), false, name);
  }
});

// A file the student deleted must stay deleted. Its patch would otherwise apply against the
// empty base the 404 handling substitutes, recreating the file they removed, with nothing
// reported and auto-merge still on.
Deno.test("a file the student deleted is never recreated, even by a patch that would apply", () => {
  assertEquals(decideFileAction(textPatch, "deleted_in_your_repo"), "skip");
  assertEquals(countsTowardSyncSize(textPatch, "deleted_in_your_repo"), false);
});

// These cannot be written at all, and must not reach the patch handling: fetching a
// directory there throws "Path is a directory, not a file".
Deno.test("a directory, a submodule or a blocked path never reaches patch handling", () => {
  for (const reason of ["directory_in_your_repo", "path_blocked_in_your_repo", "only_in_your_repo"] as const) {
    assertEquals(decideFileAction(textPatch, reason), "skip", reason);
    assertEquals(countsTowardSyncSize(textPatch, reason), false, reason);
  }
});

// A submodule ancestor is a `commit` entry, not a blob. Writing vendor/config.ts through it
// replaces the gitlink and loses the student's pinned revision.
Deno.test("a submodule standing where a parent directory has to go blocks the path", () => {
  const student = new Map<string, TreeEntry>([["vendor", { sha: BLOB_A, type: "commit" }]]);
  assertEquals(findBlockingAncestor("vendor/config.ts", student), "vendor");
});

Deno.test("nothing unresolved renders no section, so the caller can concatenate it blind", () => {
  assertEquals(renderUnresolvedSection([]), "");
});

Deno.test("the section names every file, its reason, and that the PR will not self-merge", () => {
  const section = renderUnresolvedSection([
    { path: "server/src/services/user.service.ts", reason: "content_differs" },
    { path: "assets/logo.png", reason: "only_in_your_repo" },
    { path: "README.md", reason: "deleted_in_your_repo" },
    { path: "docs", reason: "directory_in_your_repo" },
    { path: "server/lib/util.ts", reason: "path_blocked_in_your_repo" }
  ]);

  assertStringIncludes(section, "server/src/services/user.service.ts");
  assertStringIncludes(section, "assets/logo.png");
  assertStringIncludes(section, "README.md");
  assertStringIncludes(section, "you changed this file");
  assertStringIncludes(section, "the handout added a file at the same path");
  assertStringIncludes(section, "you deleted this file");
  assertStringIncludes(section, "you have a folder at this path");
  assertStringIncludes(section, "you have a file where this path needs a folder");
  assertStringIncludes(section, "will NOT merge on its own");

  // Sorted, so the same set of files always produces the same body and a re-sync does not
  // look like a different update. The expectation is derived from the same comparator the
  // renderer uses rather than hand-written, because the collation order of "README.md"
  // against "assets/logo.png" is not the ASCII one.
  const paths = ["server/src/services/user.service.ts", "assets/logo.png", "README.md"];
  const expected = paths.slice().sort((a, b) => a.localeCompare(b));
  const rendered = paths.slice().sort((a, b) => section.indexOf(a) - section.indexOf(b));
  assertEquals(rendered, expected);
});
