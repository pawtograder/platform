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
  decodeRepoTree,
  encodeRepoTree,
  findBlockingAncestor,
  GRADE_WORKFLOW_PATH,
  isHandoutOwnedPath,
  isSyncBranchSafeToReset,
  pathsNeedingBlobLookup,
  renderUnresolvedSection,
  resolveAutoMerge,
  type ChangedFileShape,
  type RepoTree,
  type RepoTreeEntry,
  type SyncBranchCommit,
  type TreeEntry,
  type UnresolvedFile
} from "./syncConflictGuard.ts";

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);
const blob = (sha: string): TreeEntry => ({ sha, type: "blob" });
/**
 * A commit GitHub built on our behalf: the merge API, the Contents API, the web editor.
 * `khoury-pawtograder[bot]` authors it, GitHub's own `web-flow` account commits it, and
 * GitHub signs it. This is the shape a SQUASH-MERGED sync PR leaves on the default branch.
 */
const ours = (sha = "abc1234"): SyncBranchCommit => ({
  subject: `Sync handout updates to ${sha}`,
  authorType: "Bot",
  committerLogin: "web-flow",
  committerType: "User",
  verified: true
});

/**
 * A commit the sync itself wrote, which is a different object from the one above and the
 * one that actually sits on the sync BRANCH: the only commit `assertSyncBranchSafeToReset`
 * ever reads. `createBranchAndCommit` builds it with the Git Database API
 * (`POST /git/commits`) passing no author, no committer and no signature, so GitHub fills
 * both identities from the installation token and leaves it unsigned.
 *
 * Sampling the merged commit on `main` and concluding the branch commit looks the same is
 * how this guard came to demand `web-flow` and a valid signature from commits that can have
 * neither.
 */
const oursOnBranch = (sha = "abc1234"): SyncBranchCommit => ({
  subject: `Sync handout updates to ${sha}`,
  authorType: "Bot",
  committerLogin: "khoury-pawtograder[bot]",
  committerType: "Bot",
  verified: false
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

// THE REGRESSION THIS FILE EXISTS TO PIN. `createBranchAndCommit` writes the commit that
// actually sits on the sync branch with the Git Database API, which GitHub neither signs nor
// attributes to web-flow. Demanding both rejected the sync's own commit, so every branch
// reset threw SyncBranchNotOursError and the repository became permanently unsyncable,
// telling the instructor to delete a branch the sync itself had written.
Deno.test("the commit the sync writes onto the branch is recognized as ours", () => {
  assertEquals(isSyncBranchSafeToReset([oursOnBranch()]), true);
  assertEquals(isSyncBranchSafeToReset([oursOnBranch("abc1234"), oursOnBranch("9f8e7d6")]), true);
});

// A student resolving the update by hand pushes to this branch. Force-updating it then
// deletes the resolution, which is the same class of loss as overwriting the file.
Deno.test("a sync branch with someone else's commit is not ours to reset", () => {
  const student: SyncBranchCommit = {
    subject: "fix merge conflict in user.service",
    authorType: "User",
    committerLogin: "student42",
    committerType: "User",
    verified: false
  };
  assertEquals(isSyncBranchSafeToReset([ours(), student]), false);
  assertEquals(isSyncBranchSafeToReset([oursOnBranch(), student]), false);
});

// `git commit --amend` keeps the original AUTHOR, so a student amending our commit hands
// back something that still says the App wrote it and still carries our subject. The
// committer is what separates them: an amend always rewrites it to whoever amended.
Deno.test("an amended commit is not ours, even though the author survives the amend", () => {
  const amended: SyncBranchCommit = {
    subject: "Sync handout updates to abc1234",
    authorType: "Bot",
    committerLogin: "student42",
    committerType: "User",
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
    committerType: "User",
    verified: true
  };
  assertEquals(isSyncBranchSafeToReset([signedAmend]), false);
});

// GitHub maps a commit to an account by email, so committing as GitHub's own address makes
// the committer login match. For the web-flow shape, signing is what that cannot fake.
Deno.test("a spoofed web-flow committer without a valid signature is not ours", () => {
  const spoofed: SyncBranchCommit = {
    subject: "Sync handout updates to abc1234",
    authorType: "Bot",
    committerLogin: "web-flow",
    committerType: "User",
    verified: false
  };
  assertEquals(isSyncBranchSafeToReset([spoofed]), false);
});

// KNOWN LIMIT, pinned so it is a decision rather than a surprise. Because the sync's own
// commits are unsigned, the Git-Database shape cannot require a signature, and every field
// it does check is one a student can set locally: committing with the App's noreply address
// makes GitHub attribute the commit to the bot. Defeating the guard this way takes
// deliberate forgery and costs the forger their own commit, while requiring a signature
// would reject every commit the sync writes. The guard's job is accidental loss: a student
// resolving the update by hand, which the case above still covers.
Deno.test("a commit forged to look bot-committed is accepted, which is the documented limit", () => {
  const forged: SyncBranchCommit = {
    subject: "Sync handout updates to abc1234",
    authorType: "Bot",
    committerLogin: "khoury-pawtograder[bot]",
    committerType: "Bot",
    verified: false
  };
  assertEquals(isSyncBranchSafeToReset([forged]), true);
});

// Another bot on the org is not this one. Dependabot never writes our anchored subject, so
// the subject check is what keeps `committerType: "Bot"` from meaning "any bot".
Deno.test("a different bot's commit is not ours", () => {
  const dependabot: SyncBranchCommit = {
    subject: "Bump lodash from 4.17.20 to 4.17.21",
    authorType: "Bot",
    committerLogin: "dependabot[bot]",
    committerType: "Bot",
    verified: true
  };
  assertEquals(isSyncBranchSafeToReset([dependabot]), false);
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

// GitHub's own committer account is an ordinary User, so the web-flow shape is recognized by
// LOGIN plus a valid signature, not by account type.
Deno.test("a GitHub-built commit passes, with GitHub as an ordinary User committer", () => {
  assertEquals(isSyncBranchSafeToReset([{ ...ours(), committerLogin: "web-flow", committerType: "User" }]), true);
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
const textPatch: ChangedFileShape = {
  path: "src/main.ts",
  status: "modified",
  isBinary: false,
  hasPatch: true,
  patchDeletesFile: false
};

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

// The handout is deleting a file the student already deleted. Both sides want it gone and it
// already is. Calling that unresolved would report "you deleted this file, so it was not
// restored" about a deletion that needed no action AND, through resolveAutoMerge, hold the
// whole pull request open over it, so one student tidying away a starter file would turn
// every future handout update for that repo into a manual merge.
Deno.test("a deletion the student already made needs no action and is not reported", () => {
  const removal: ChangedFileShape = {
    path: "src/starter.ts",
    status: "removed",
    isBinary: false,
    hasPatch: false,
    patchDeletesFile: false
  };
  assertEquals(decideFileAction(removal, "deleted_in_your_repo"), "noop");
  assertEquals(countsTowardSyncSize(removal, "deleted_in_your_repo"), false);
});

// The other shape a handout deletion arrives in: status "modified" with a `+0,0` patch that
// only deletes. Matching on status alone left this one reported and auto-merge held.
Deno.test("a delete-only patch the student already applied is also a no-op", () => {
  const deleteOnlyPatch: ChangedFileShape = {
    path: "src/starter.ts",
    status: "modified",
    isBinary: false,
    hasPatch: true,
    patchDeletesFile: true
  };
  assertEquals(decideFileAction(deleteOnlyPatch, "deleted_in_your_repo"), "noop");
  assertEquals(countsTowardSyncSize(deleteOnlyPatch, "deleted_in_your_repo"), false);
});

// A file the student deleted that the handout is still CHANGING is a different case: their
// deletion has to survive, and it has to be reported, because the instructor's change was
// not delivered.
Deno.test("a deletion the handout does not share is still reported", () => {
  assertEquals(decideFileAction(textPatch, "deleted_in_your_repo"), "skip");
});

// Every other shape of a content_differs file is written wholesale, so there is no merge to
// attempt and no reason to weigh bytes nobody reads.
Deno.test("content_differs on a shape with no merge available is skipped and not sized", () => {
  const shapes: Record<string, ChangedFileShape> = {
    binary: { path: "assets/logo.png", status: "modified", isBinary: true, hasPatch: false, patchDeletesFile: false },
    added: { path: "src/added.ts", status: "added", isBinary: false, hasPatch: false, patchDeletesFile: false },
    removed: { path: "src/gone.ts", status: "removed", isBinary: false, hasPatch: true, patchDeletesFile: false },
    deleteOnlyPatch: {
      path: "src/emptied.ts",
      status: "modified",
      isBinary: false,
      hasPatch: true,
      patchDeletesFile: true
    }
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

// The autograder toggle only edits the HANDOUT and leaves `queue_repository_syncs` to carry
// grade.yml downstream. A student who edited their copy -- or who has anything at all at that
// path -- used to make both directions of the toggle unenforceable for their repo: the guard
// saw a file they had touched and left it alone, silently and for good.
Deno.test("turning the autograder off removes the workflow even from a student who edited it", () => {
  const removal: ChangedFileShape = {
    path: GRADE_WORKFLOW_PATH,
    status: "removed",
    isBinary: false,
    hasPatch: false,
    patchDeletesFile: false
  };
  // Their copy differs from the handout's, which for any other file is the end of it.
  assertEquals(decideFileAction(removal, "content_differs"), "write");
  assertEquals(countsTowardSyncSize(removal, "content_differs"), true);
});

// The other direction, and the more costly one: the workflow is missing while
// has_autograder is already true, so a `#submit` push dispatches a workflow that is not
// there and the student's work is never recorded.
Deno.test("turning the autograder on writes the workflow over a file standing at that path", () => {
  const added: ChangedFileShape = {
    path: GRADE_WORKFLOW_PATH,
    status: "added",
    isBinary: false,
    hasPatch: false,
    patchDeletesFile: false
  };
  assertEquals(decideFileAction(added, "only_in_your_repo"), "write");
  assertEquals(countsTowardSyncSize(added, "only_in_your_repo"), true);
});

// Owning the path is permission to overwrite the FILE at it, never permission to delete a
// directory the student is keeping work in, and the text path would throw "Path is a
// directory, not a file" and take the whole sync down with it.
Deno.test("the handout does not own a path where the student has a directory", () => {
  const workflow: ChangedFileShape = {
    path: GRADE_WORKFLOW_PATH,
    status: "modified",
    isBinary: false,
    hasPatch: true,
    patchDeletesFile: false
  };
  for (const reason of ["directory_in_your_repo", "path_blocked_in_your_repo"] as const) {
    assertEquals(decideFileAction(workflow, reason), "skip", reason);
  }
});

// Both sides already agree the file is gone. Emitting a tree entry to delete a path that is
// not in the base tree asks GitHub to remove an object that does not exist, so the "noop"
// case has to win over ownership.
Deno.test("a workflow the student already deleted is a no-op, not a delete of nothing", () => {
  const removal: ChangedFileShape = {
    path: GRADE_WORKFLOW_PATH,
    status: "removed",
    isBinary: false,
    hasPatch: false,
    patchDeletesFile: false
  };
  assertEquals(decideFileAction(removal, "deleted_in_your_repo"), "noop");
});

// The list is exactly one path. A neighboring workflow is the student's like any other file.
Deno.test("ownership does not spread to the rest of .github", () => {
  const sibling: ChangedFileShape = {
    path: ".github/workflows/ci.yml",
    status: "modified",
    isBinary: false,
    hasPatch: true,
    patchDeletesFile: false
  };
  assertEquals(isHandoutOwnedPath(".github/workflows/ci.yml"), false);
  assertEquals(decideFileAction(sibling, "only_in_your_repo"), "skip");
});

// A submodule ancestor is a `commit` entry, not a blob. Writing vendor/config.ts through it
// replaces the gitlink and loses the student's pinned revision.
Deno.test("a submodule standing where a parent directory has to go blocks the path", () => {
  const student = new Map<string, TreeEntry>([["vendor", { sha: BLOB_A, type: "commit" }]]);
  assertEquals(findBlockingAncestor("vendor/config.ts", student), "vendor");
});

// The cached tree is the input to every decision in this module, so what survives the trip
// through Redis is what the guard actually reads. Sizes, blob shas and the truncation flag
// all have to come back.
Deno.test("a tree survives the trip through the cache unchanged", () => {
  const tree: RepoTree = {
    entries: new Map<string, RepoTreeEntry>([
      ["src/main.ts", { sha: BLOB_A, type: "blob", size: 1234 }],
      ["src/no-size.ts", { sha: BLOB_B, type: "blob" }],
      ["src", { sha: "", type: "tree" }],
      ["vendor/lib", { sha: "", type: "commit" }]
    ]),
    truncated: false
  };
  const decoded = decodeRepoTree(encodeRepoTree(tree));
  assertEquals(decoded?.truncated, false);
  assertEquals(decoded?.entries.get("src/main.ts"), { sha: BLOB_A, type: "blob", size: 1234 });
  assertEquals(decoded?.entries.get("src/no-size.ts"), { sha: BLOB_B, type: "blob", size: undefined });
  assertEquals(decoded?.entries.get("src")?.type, "tree");
  assertEquals(decoded?.entries.get("vendor/lib")?.type, "commit");
});

// Losing this flag is the dangerous case: a truncated tree that reads as complete stops the
// per-path lookups, and every path GitHub omitted then reads as absent, which is the answer
// that permits the overwrite.
Deno.test("the truncation flag survives the cache", () => {
  const tree: RepoTree = { entries: new Map([["a.ts", { sha: BLOB_A, type: "blob" }]]), truncated: true };
  assertEquals(decodeRepoTree(encodeRepoTree(tree))?.truncated, true);
});

// Repeating "sha" and "type" 20,000 times is how the cached value grew past what Upstash
// accepts in one request, at which point writing it fails on every sync and the cache is
// silently dead. Positional rows are what keep it under the limit.
Deno.test("the encoding names no keys per entry, and stops early for a non-blob", () => {
  const tree: RepoTree = {
    entries: new Map<string, RepoTreeEntry>([
      ["src/main.ts", { sha: BLOB_A, type: "blob", size: 10 }],
      ["src", { sha: "irrelevant", type: "tree" }]
    ]),
    truncated: false
  };
  const encoded = encodeRepoTree(tree);
  assertEquals(encoded.includes('"sha"'), false);
  assertEquals(encoded.includes('"type"'), false);
  // A directory is read for its type alone, so its sha is not worth the 40 characters.
  assertEquals(encoded.includes("irrelevant"), false);
});

// Anything we cannot read has to mean "fetch it again". Inventing an empty tree from a
// value that will not parse reports every path as absent, and absent is the answer that
// permits the overwrite.
Deno.test("an unreadable cache value is a miss, never an empty tree", () => {
  assertEquals(decodeRepoTree("not json at all"), undefined);
  assertEquals(decodeRepoTree(JSON.stringify({ v: 2, t: 0, e: [] })), undefined);
  assertEquals(decodeRepoTree(JSON.stringify({ v: 1, t: 0 })), undefined);
  assertEquals(decodeRepoTree(JSON.stringify({ v: 1, t: 0, e: [["a.ts", 9]] })), undefined);
  // A blob with no sha: two of those compare equal to each other, which reads as unmodified.
  assertEquals(decodeRepoTree(JSON.stringify({ v: 1, t: 0, e: [["a.ts", 0]] })), undefined);
  assertEquals(decodeRepoTree(undefined), undefined);
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

// A pull request body is capped at 65536 characters and createPullRequest does not truncate:
// an over-long body is a 422 thrown AFTER the branch and commit exist, which fails the whole
// sync and retries it into the dead-letter queue. A handout-wide reformat can leave hundreds
// of files to one student, so the list has to end somewhere and say so.
Deno.test("a very long unresolved list is capped, and says how many it did not name", () => {
  const many: UnresolvedFile[] = Array.from({ length: 250 }, (_, i) => ({
    path: `src/file${String(i).padStart(4, "0")}.ts`,
    reason: "content_differs" as const
  }));
  const section = renderUnresolvedSection(many);

  assertStringIncludes(section, "src/file0000.ts");
  assertStringIncludes(section, "...and 50 more");
  assertEquals(section.includes("src/file0249.ts"), false);
  // Well inside the 65536 limit even before the rest of the body is added.
  assertEquals(section.length < 30000, true);
});
