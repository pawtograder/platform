// Group a flat list of scanned pages into per-student exams of `pagesPerExam` pages.

/** Split `items` into consecutive groups of `pagesPerExam`. The last group may be short. */
export function groupByExam<T>(items: T[], pagesPerExam: number): T[][] {
  const per = Math.max(1, Math.floor(pagesPerExam));
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += per) {
    groups.push(items.slice(i, i + per));
  }
  return groups;
}

/** Number of complete exams a scan of `totalPages` pages contains. */
export function examCount(totalPages: number, pagesPerExam: number): number {
  const per = Math.max(1, Math.floor(pagesPerExam));
  return Math.ceil(Math.max(0, totalPages) / per);
}
