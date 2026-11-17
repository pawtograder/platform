/** Whether a file name has a markdown extension. */
export function isMarkdownFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ["md", "markdown", "mdown", "mkdn", "mkd"].includes(ext);
}

type DefaultViewFile = { id: number; name: string; is_binary: boolean };
type DefaultViewArtifact = { id: number; data: unknown };

/**
 * What the Files tab shows when the URL names neither a file nor an artifact.
 *
 * A paper exam opens on its exam_v1 artifact, the per-answer crops graders grade from (#1267). Its
 * scanned page is also a submission file, so without this it opened on the raw page image, and since
 * "Next" carries no selection, it did that again for every student.
 *
 * Otherwise, a source-code file rather than whatever happens to be first: the embedded submission_files
 * arrive in an unspecified order, and opening a markdown file shows its rendered preview (no code lines),
 * while graders want to land on code. Picked by name so the default is stable across loads, falling back
 * to the name-first file when there is no code file, and to the first artifact when there are no files.
 */
export function pickDefaultView(
  files: DefaultViewFile[],
  artifacts: DefaultViewArtifact[]
): { fileId: number | null; artifactId: number | null } {
  const exam = artifacts.find((a) => (a.data as { format?: string } | null)?.format === "exam_v1");
  if (exam) return { fileId: null, artifactId: exam.id };

  const byName = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const file = byName.find((f) => !f.is_binary && !isMarkdownFile(f.name)) ?? byName[0];
  if (file) return { fileId: file.id, artifactId: null };
  return { fileId: null, artifactId: artifacts[0]?.id ?? null };
}
