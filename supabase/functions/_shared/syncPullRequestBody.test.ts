/**
 * The sync pull request body, before and after it moved into `renderSyncPullRequestBody`.
 *
 * `legacyPrTitleAndBody` below is the inline code `syncRepositoryToHandout` held before WP3,
 * copied verbatim from staging (GitHubSyncHelpers.ts, the "Create PR" block), wrapped in a function
 * with the variables it read as parameters. The refactor is only safe if the two agree for every
 * input shape, and the git path then inherits the same text by calling the shared function.
 *
 * Run from supabase/functions:
 *   deno test --no-check --allow-all _shared/syncPullRequestBody.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { renderUnresolvedSection, type UnresolvedFile } from "./syncConflictGuard.ts";

Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { renderSyncPullRequestBody, syncPullRequestTitle } = await import("./GitHubSyncHelpers.ts");

type LegacyFile = { path: string; isBinary?: boolean; status?: string };

function legacyPrTitleAndBody(
  toSha: string,
  fromSha: string | null,
  baselineSha: string,
  syncedRepoSha: string | null,
  changedFiles: LegacyFile[],
  unresolved: UnresolvedFile[],
  effectiveAutoMerge: boolean
): { prTitle: string; prBody: string } {
  const prTitle = `[Instructor Update] Sync handout to ${toSha.substring(0, 7)}`;

  // Categorize files for better PR description. Anything left to the student is
  // reported in its own section instead, so these lists describe what this PR
  // actually carries rather than everything the instructor changed.
  const unresolvedPaths = new Set(unresolved.map((f) => f.path));
  const syncedFiles = changedFiles.filter((f) => !unresolvedPaths.has(f.path));
  const textFiles = syncedFiles.filter((f) => !f.isBinary && f.status !== "removed");
  const binaryFiles = syncedFiles.filter((f) => f.isBinary && f.status !== "removed");
  const removedFiles = syncedFiles.filter((f) => f.status === "removed");

  const prBody = `## Handout Update

This pull request syncs the latest changes from the assignment template repository.

**Triggered by:** Instructor
**Template commit:** ${toSha}
**Previous sync:** ${fromSha || "Initial sync"}
**Base commit:** ${baselineSha.substring(0, 7)}

### How This Works

This PR uses a **3-way merge strategy** to preserve your work:
- **Base**: ${
    syncedRepoSha
      ? `The state of your repo at the last sync (${baselineSha.substring(0, 7)})`
      : `Your repo as it stands now (${baselineSha.substring(0, 7)}), because no earlier sync was recorded for it`
  }
- **Changes**: Updates from the handout template
- **Your Work**: Any commits you've made since the last sync

GitHub will automatically merge these together. If you modified the same parts of files that the instructor updated, you'll see merge conflicts that need to be resolved.

${renderUnresolvedSection(unresolved)}### Changed Files

${textFiles.length > 0 ? `**Text files** (will be merged with your changes):\n${textFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}${binaryFiles.length > 0 ? `**Binary files** (replaced with the handout's version):\n${binaryFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}${removedFiles.length > 0 ? `**Removed files**:\n${removedFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}
---
*This PR was automatically generated. ${
    effectiveAutoMerge
      ? "It will be auto-merged if there are no conflicts."
      : unresolved.length > 0
        ? "It will NOT be merged automatically, because some of the files the instructor changed are files you have edited. Review the list above, then merge when you are ready."
        : "It will NOT be merged automatically. Review it, then merge when you are ready."
  } If there are merge conflicts, they will be shown in the GitHub UI - you can resolve them directly on GitHub or locally. If you need help, ask your course staff.*`;
  return { prTitle, prBody };
}

const H = "1234567890abcdef1234567890abcdef12345678";
const F = "fedcba0987654321fedcba0987654321fedcba09";
const S = "aaaaaaabbbbbbbccccccccdddddddeeeeeeeffff";

const files: LegacyFile[] = [
  { path: "src/Main.java", status: "modified", isBinary: false },
  { path: "img/logo.png", status: "added", isBinary: true },
  { path: "old.txt", status: "removed", isBinary: false },
  { path: "old.bin", status: "removed", isBinary: true },
  { path: "notes.md", status: "added" },
  { path: "renamed.txt", status: "renamed" }
];
const many: UnresolvedFile[] = Array.from({ length: 230 }, (_, i) => ({
  path: `gen/file-${String(i).padStart(3, "0")}.txt`,
  reason: "content_differs" as const
}));

const cases: Array<[string, Parameters<typeof legacyPrTitleAndBody>]> = [
  ["clean, auto-merge", [H, F, S, S, files, [], true]],
  ["initial sync, no recorded baseline", [H, null, S, null, files, [], true]],
  ["held open, nothing unresolved", [H, F, S, S, files, [], false]],
  [
    "held open with unresolved files",
    [
      H,
      F,
      S,
      S,
      files,
      [
        { path: "src/Main.java", reason: "content_differs" },
        { path: "img/logo.png", reason: "only_in_your_repo" }
      ],
      false
    ]
  ],
  ["only binaries", [H, F, S, S, [{ path: "a.png", isBinary: true, status: "modified" }], [], true]],
  ["no files at all", [H, F, S, S, [], [], true]],
  [
    "unresolved past the row cap",
    [H, F, S, null, [...files, ...many.map((m) => ({ path: m.path, status: "modified" }))], many, false]
  ]
];

for (const [name, args] of cases) {
  Deno.test(`PR title and body match the pre-refactor inline code: ${name}`, () => {
    const [toSha, fromSha, baselineSha, syncedRepoSha, changedFiles, unresolved, effectiveAutoMerge] = args;
    const legacy = legacyPrTitleAndBody(...args);
    assertEquals(syncPullRequestTitle(toSha), legacy.prTitle);
    assertEquals(
      renderSyncPullRequestBody({
        toSha,
        fromSha,
        baselineSha,
        baselineWasRecorded: !!syncedRepoSha,
        changedFiles,
        unresolved,
        effectiveAutoMerge
      }),
      legacy.prBody
    );
  });
}
