/**
 * Draining PostgREST queries that have no natural bound.
 */

import { CLICommandError } from "../errors.ts";
import { PAGE_SIZE } from "./pagingLimits.ts";

export { PAGE_SIZE, UUID_IN_BATCH_SIZE } from "./pagingLimits.ts";

/**
 * Drains a query that has no natural bound.
 *
 * PostgREST caps every response at `max_rows` (1000, see supabase/config.toml),
 * and it does so silently — an unpaged `select` over a large course returns a
 * truncated page that looks like the whole answer. For allocation inputs that is
 * not a display glitch: a missing submission goes unassigned, and a missing
 * conflict or group member lets someone be handed their own work.
 *
 * `makeQuery` must build a fresh builder each call, since `.range()` cannot be
 * re-applied to a spent one.
 */
export async function pageAll<T>(
  makeQuery: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }> & {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
  label: string
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new CLICommandError(`${label}: ${error.message}`, 500);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}
