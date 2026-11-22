import type { getAdminClient } from "./supabase.ts";
import { UUID_IN_BATCH_SIZE } from "./pagingLimits.ts";
import { CLICommandError } from "../errors.ts";

/** Batched private-profile-id → display name lookup, optionally limited to one class. */
export async function fetchProfileNames(
  supabase: ReturnType<typeof getAdminClient>,
  ids: Array<string | null | undefined>,
  classId?: number
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids.filter((id): id is string => !!id))];

  // profiles.id is a UUID, so this is bounded by URL length, not max_rows.
  for (let i = 0; i < unique.length; i += UUID_IN_BATCH_SIZE) {
    let query = supabase
      .from("profiles")
      .select("id, name")
      .in("id", unique.slice(i, i + UUID_IN_BATCH_SIZE));
    if (classId != null) query = query.eq("class_id", classId);
    const { data, error } = await query;
    if (error) throw new CLICommandError(`Failed to resolve profile names: ${error.message}`, 500);
    for (const row of data ?? []) {
      if (row.name) names.set(row.id, row.name);
    }
  }
  return names;
}
