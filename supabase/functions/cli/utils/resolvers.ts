/**
 * Resolve class and assignment by ID, slug, or name.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { ClassRow, AssignmentRow, SurveyRow } from "../types.ts";
import { CLICommandError } from "../errors.ts";
import { dedupeSurveysToLatestVersion } from "./surveyCopy.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveClass(supabase: SupabaseClient<Database>, identifier: string | number): Promise<ClassRow> {
  // Try by ID first
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data, error } = await supabase.from("classes").select("*").eq("id", Number(identifier)).single();
    if (!error && data) return data as ClassRow;
  }

  // Try by slug
  const { data: bySlug } = await supabase.from("classes").select("*").eq("slug", String(identifier)).single();
  if (bySlug) return bySlug as ClassRow;

  // Try by exact name
  const { data: byExactName } = await supabase.from("classes").select("*").eq("name", String(identifier)).maybeSingle();
  if (byExactName) return byExactName as ClassRow;

  // Try by name (partial match); multiple hits are ambiguous
  const { data: byName } = await supabase
    .from("classes")
    .select("*")
    .ilike("name", `%${String(identifier)}%`)
    .limit(2);
  const nameMatches = (byName ?? []) as ClassRow[];
  if (nameMatches.length > 1) {
    throw new CLICommandError(
      `Ambiguous class "${String(identifier)}": multiple classes match that name pattern; use a class id, slug, or a more specific name.`,
      400
    );
  }
  if (nameMatches.length === 1) return nameMatches[0]!;

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

export async function resolveSurvey(
  supabase: SupabaseClient<Database>,
  classId: number,
  identifier: string
): Promise<SurveyRow> {
  const trimmed = String(identifier).trim();

  if (UUID_RE.test(trimmed)) {
    const { data: byPk } = await supabase
      .from("surveys")
      .select("*")
      .eq("class_id", classId)
      .eq("id", trimmed)
      .is("deleted_at", null)
      .maybeSingle();
    if (byPk) return byPk as SurveyRow;

    const { data: byLogical } = await supabase
      .from("surveys")
      .select("*")
      .eq("class_id", classId)
      .eq("survey_id", trimmed)
      .is("deleted_at", null)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byLogical) return byLogical as SurveyRow;
  } else {
    const { data: rows, error } = await supabase
      .from("surveys")
      .select("*")
      .eq("class_id", classId)
      .eq("title", trimmed)
      .is("deleted_at", null);

    if (error) {
      throw new CLICommandError(`Failed to resolve survey: ${error.message}`);
    }
    const latest = dedupeSurveysToLatestVersion((rows ?? []) as SurveyRow[]);
    if (latest.length === 0) {
      throw new CLICommandError(`Survey not found: ${identifier}`, 404);
    }
    if (latest.length > 1) {
      throw new CLICommandError(`Multiple surveys with title "${trimmed}" — use survey UUID (id or survey_id)`, 400);
    }
    return latest[0]!;
  }

  throw new CLICommandError(`Survey not found: ${identifier}`, 404);
}
