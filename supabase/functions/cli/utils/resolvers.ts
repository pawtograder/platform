/**
 * Resolve class and assignment by ID, slug, or name.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { ClassRow, AssignmentRow } from "../types.ts";
import { CLICommandError } from "../errors.ts";

export async function resolveClass(
  supabase: SupabaseClient<Database>,
  identifier: string | number
): Promise<ClassRow> {
  // Try by ID first
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data, error } = await supabase
      .from("classes")
      .select("*")
      .eq("id", Number(identifier))
      .single();
    if (!error && data) return data as ClassRow;
  }

  // Try by slug
  const { data: bySlug } = await supabase
    .from("classes")
    .select("*")
    .eq("slug", String(identifier))
    .single();
  if (bySlug) return bySlug as ClassRow;

  // Try by name (partial match)
  const { data: byName } = await supabase
    .from("classes")
    .select("*")
    .ilike("name", `%${String(identifier)}%`)
    .limit(1)
    .single();
  if (byName) return byName as ClassRow;

  throw new CLICommandError(`Class not found: ${identifier}`, 404);
}

export async function resolveAssignment(
  supabase: SupabaseClient<Database>,
  classId: number,
  identifier: string | number
): Promise<AssignmentRow> {
  // Try by ID first
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data } = await supabase
      .from("assignments")
      .select("*")
      .eq("id", Number(identifier))
      .eq("class_id", classId)
      .single();
    if (data) return data as AssignmentRow;
  }

  // Try by slug
  const { data: bySlug } = await supabase
    .from("assignments")
    .select("*")
    .eq("slug", String(identifier))
    .eq("class_id", classId)
    .single();
  if (bySlug) return bySlug as AssignmentRow;

  throw new CLICommandError(`Assignment not found: ${identifier} in class ${classId}`, 404);
}
