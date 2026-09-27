import { diffLines } from "diff";

/**
 * Per-file line diff for the inline base→head and version→version submission
 * views. Produces a compact list of `+`/`-` lines followed by a `+N/-N` summary,
 * truncated at 100 diff lines.
 *
 * Uses jsdiff's LCS-based `diffLines` rather than a positional `base[i]` vs
 * `head[i]` comparison: a positional diff renders every line after an insertion
 * or deletion as BOTH removed and added and massively overcounts the `+N/-N`
 * summary, making any non-trivial diff (e.g. inserting a line at the top of a
 * file) unreadable. This is the single source of truth shared by the submission
 * layout's version diff and the Files page's PR base→head inline diff, so both
 * read identically.
 */
export function generateSimpleDiff(oldContent: string | null, newContent: string | null): string {
  // Use == null to check for null/undefined only (not empty strings)
  if (oldContent == null && newContent == null) return "(both empty)";
  if (oldContent == null) return "(new file)";
  if (newContent == null) return "(file deleted)";

  const parts = diffLines(oldContent, newContent);
  const diffLineList: string[] = [];
  let addedCount = 0;
  let removedCount = 0;

  for (const part of parts) {
    if (!part.added && !part.removed) continue; // unchanged run — omit to keep the diff compact
    const prefix = part.added ? "+" : "-";
    // jsdiff keeps the trailing newline on each chunk; split and drop the empty
    // final element so we don't emit a spurious blank `+`/`-` line.
    const lines = part.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      diffLineList.push(`${prefix} ${line}`);
      if (part.added) addedCount++;
      else removedCount++;
    }
  }

  if (diffLineList.length === 0) return "(no changes)";

  const maxDiffLines = 100;
  if (diffLineList.length > maxDiffLines) {
    return (
      diffLineList.slice(0, maxDiffLines).join("\n") +
      `\n... (${diffLineList.length - maxDiffLines} more lines, +${addedCount}/-${removedCount} total)`
    );
  }
  return diffLineList.join("\n") + `\n(+${addedCount}/-${removedCount} lines)`;
}
