/**
 * Shared concurrency helper for CLI export commands.
 */

/**
 * Run `tasks` with at most `concurrency` in flight at a time, preserving result
 * order. Workers pull from a shared index so a slow task doesn't stall others.
 */
export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]!();
    }
  });
  await Promise.all(workers);
  return results;
}
