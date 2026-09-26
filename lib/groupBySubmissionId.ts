/**
 * Bucket rows by submission id, skipping rows with no submission.
 *
 * Replaces an inverted idiom in the grade export:
 *
 *     if (!map.has(id)) { map.set(id, []) } else { map.get(id)!.push(row) }
 *
 * which creates the bucket but never pushes the row that created it, so every submission silently
 * lost exactly one autograder test result — and a submission with a single result got an empty
 * array.
 *
 * For CSV that is worse than one missing cell: Papa.unparse derives the header from the first
 * row's keys, and the export builds columns per row, so the test dropped for the first exported
 * student is missing from the header and therefore absent for every student in the file.
 */
export function groupBySubmissionId<T extends { submission_id: number | null }>(rows: readonly T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    if (row.submission_id === null) {
      continue;
    }
    const bucket = map.get(row.submission_id) ?? [];
    bucket.push(row);
    map.set(row.submission_id, bucket);
  }
  return map;
}
