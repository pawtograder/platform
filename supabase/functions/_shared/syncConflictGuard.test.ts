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
  classifyStudentFile,
  isSyncBranchSafeToReset,
  pathsNeedingBlobLookup,
  renderUnresolvedSection,
  resolveAutoMerge,
  type UnresolvedFile
} from "./syncConflictGuard.ts";

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);

Deno.test("a file the student has not touched is safe to overwrite", () => {
  assertEquals(classifyStudentFile(BLOB_A, BLOB_A), "unmodified");
});

// The Shashankmore20 case: same path, different content, and the overwrite that followed.
Deno.test("a file whose content differs is the student's", () => {
  assertEquals(classifyStudentFile(BLOB_A, BLOB_B), "content_differs");
});

Deno.test("a file only the student has is theirs", () => {
  assertEquals(classifyStudentFile(BLOB_A, undefined), "only_in_your_repo");
});

Deno.test("a file the student deleted stays deleted", () => {
  assertEquals(classifyStudentFile(undefined, BLOB_A), "deleted_in_your_repo");
});

// A handout adding a path neither side has yet is the ordinary case, not a conflict.
Deno.test("a path absent on both sides is not a conflict", () => {
  assertEquals(classifyStudentFile(undefined, undefined), "unmodified");
});

// The failure this is written against: a truncated tree omits paths it does not disprove.
// Reading those as absent would classify the file "unmodified" and hand the overwrite back.
Deno.test("a truncated tree forces a per-file lookup for the paths it did not answer", () => {
  const shas = new Map([["kept.ts", BLOB_A]]);
  assertEquals(pathsNeedingBlobLookup(shas, true, ["kept.ts", "missing.ts"]), ["missing.ts"]);
});

Deno.test("a complete tree needs no lookups, because a missing path there is really absent", () => {
  const shas = new Map([["kept.ts", BLOB_A]]);
  assertEquals(pathsNeedingBlobLookup(shas, false, ["kept.ts", "missing.ts"]), []);
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
  const subjects = ["Sync handout updates to abc1234", "Sync handout updates to 9f8e7d6"];
  assertEquals(isSyncBranchSafeToReset(subjects), true);
});

// A student resolving the update by hand pushes to this branch. Force-updating it then
// deletes the resolution, which is the same class of loss as overwriting the file.
Deno.test("a sync branch with someone else's commit is not ours to reset", () => {
  const subjects = ["Sync handout updates to abc1234", "fix merge conflict in user.service"];
  assertEquals(isSyncBranchSafeToReset(subjects), false);
});

Deno.test("a branch with no commits ahead of the base is trivially resettable", () => {
  assertEquals(isSyncBranchSafeToReset([]), true);
});

// A commit subject that merely mentions the sync must not pass as ours.
Deno.test("a subject that only looks like ours does not pass", () => {
  assertEquals(isSyncBranchSafeToReset(['Revert "Sync handout updates to abc1234"']), false);
  assertEquals(isSyncBranchSafeToReset(["Sync handout updates to my own branch"]), false);
});

Deno.test("nothing unresolved renders no section, so the caller can concatenate it blind", () => {
  assertEquals(renderUnresolvedSection([]), "");
});

Deno.test("the section names every file, its reason, and that the PR will not self-merge", () => {
  const section = renderUnresolvedSection([
    { path: "server/src/services/user.service.ts", reason: "content_differs" },
    { path: "assets/logo.png", reason: "only_in_your_repo" },
    { path: "README.md", reason: "deleted_in_your_repo" }
  ]);

  assertStringIncludes(section, "server/src/services/user.service.ts");
  assertStringIncludes(section, "assets/logo.png");
  assertStringIncludes(section, "README.md");
  assertStringIncludes(section, "you changed this file");
  assertStringIncludes(section, "the handout added a file at the same path");
  assertStringIncludes(section, "you deleted this file");
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
