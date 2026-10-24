/**
 * Resolve class and assignment by ID, slug, or name.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { ClassRow, AssignmentRow, SurveyRow } from "../types.ts";
import { CLICommandError } from "../errors.ts";
import { dedupeSurveysToLatestVersion } from "./surveyCopy.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Escapes LIKE metacharacters so an identifier is matched literally.
 *
 * Without this, `--class "%"` matches every class and `cs_500` matches `cs-500`,
 * so a command could silently run against a class the operator did not name.
 *
 * `*` is rejected rather than escaped. PostgREST accepts it as an alias for `%` in
 * `like`/`ilike` and performs that substitution on the raw value, so it is a wildcard
 * here too — and there is no escape for it: `\*` becomes `\%`, which matches a literal
 * percent sign, not a literal asterisk. Since a literal `*` cannot be expressed through
 * this operator at all, saying so beats searching for something else.
 */
export function escapeLikePattern(value: string): string {
  if (value.includes("*")) {
    throw new CLICommandError(
      `"${value}" cannot be used as a name search: PostgREST reads * as a wildcard and it cannot be escaped. ` +
        "Pass an id, or a slug or name without an asterisk.",
      400
    );
  }
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function resolveClass(supabase: SupabaseClient<Database>, identifier: string | number): Promise<ClassRow> {
  // Try by ID first
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data, error } = await supabase.from("classes").select("*").eq("id", Number(identifier)).maybeSingle();
    if (error) throw new CLICommandError(`Failed to resolve class: ${error.message}`, 500);
    if (data) return data as ClassRow;
  }

  // Try by slug. Not `.single()`: classes.slug carries no unique constraint, and
  // reusing a course code across terms is normal. `.single()` errored on the
  // second match and — with the error discarded — resolution fell through to the
  // name search and usually ended at "Class not found" for a class that plainly
  // exists, making every --class <slug> invocation unusable.
  const { data: bySlug, error: slugError } = await supabase
    .from("classes")
    .select("*")
    .eq("slug", String(identifier))
    .order("id", { ascending: false })
    .limit(2);
  if (slugError) throw new CLICommandError(`Failed to resolve class: ${slugError.message}`, 500);
  const slugMatches = (bySlug ?? []) as ClassRow[];
  if (slugMatches.length > 1) {
    throw new CLICommandError(
      `Ambiguous class slug "${String(identifier)}": ${slugMatches.map((c) => c.id).join(", ")}. Pass a class id.`,
      400
    );
  }
  if (slugMatches.length === 1) return slugMatches[0]!;

  // Try by exact name
  const { data: byExactName, error: exactNameError } = await supabase
    .from("classes")
    .select("*")
    .eq("name", String(identifier))
    .order("id", { ascending: false })
    .limit(2);
  if (exactNameError) throw new CLICommandError(`Failed to resolve class: ${exactNameError.message}`, 500);
  const exactMatches = (byExactName ?? []) as ClassRow[];
  if (exactMatches.length > 1) {
    throw new CLICommandError(
      `Ambiguous class name "${String(identifier)}": ${exactMatches.map((c) => c.id).join(", ")}. Pass a class id.`,
      400
    );
  }
  if (exactMatches.length === 1) return exactMatches[0]!;

  // Try by name (partial match); multiple hits are ambiguous
  const { data: byName, error: nameError } = await supabase
    .from("classes")
    .select("*")
    .ilike("name", `%${escapeLikePattern(String(identifier))}%`)
    .limit(2);
  if (nameError) throw new CLICommandError(`Failed to resolve class: ${nameError.message}`, 500);
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
    const { data, error } = await supabase
      .from("assignments")
      .select("*")
      .eq("id", Number(identifier))
      .eq("class_id", classId)
      .maybeSingle();
    if (error) throw new CLICommandError(`Failed to resolve assignment: ${error.message}`, 500);
    if (data) return data as AssignmentRow;
  }

  // Try by slug. As with classes, assignments.slug has no unique constraint, so
  // `.single()` broke on a duplicate instead of reporting the ambiguity.
  const { data: bySlug, error: slugError } = await supabase
    .from("assignments")
    .select("*")
    .eq("slug", String(identifier))
    .eq("class_id", classId)
    .order("id", { ascending: false })
    .limit(2);
  if (slugError) throw new CLICommandError(`Failed to resolve assignment: ${slugError.message}`, 500);
  const slugMatches = (bySlug ?? []) as AssignmentRow[];
  if (slugMatches.length > 1) {
    throw new CLICommandError(
      `Ambiguous assignment slug "${String(identifier)}" in class ${classId}: ` +
        `${slugMatches.map((a) => a.id).join(", ")}. Pass an assignment id.`,
      400
    );
  }
  if (slugMatches.length === 1) return slugMatches[0]!;

  throw new CLICommandError(`Assignment not found: ${identifier} in class ${classId}`, 404);
}

/** The three rubric slots an assignment can carry. */
export type RubricType = "grading" | "self_review" | "meta";

export const RUBRIC_TYPES: RubricType[] = ["grading", "self_review", "meta"];

/**
 * Maps a rubric type onto the matching column on the assignment. Returns null
 * when the assignment has no rubric in that slot, so callers can phrase their
 * own error (create-the-rubric-first vs nothing-to-assign).
 */
export function resolveRubricIdForType(assignment: AssignmentRow, rubricType: string): number | null {
  switch (rubricType) {
    case "grading":
      return assignment.grading_rubric_id;
    case "self_review":
      return assignment.self_review_rubric_id;
    case "meta":
      return assignment.meta_grading_rubric_id;
    default:
      throw new CLICommandError(`Invalid rubric type: ${rubricType}. Must be one of ${RUBRIC_TYPES.join(", ")}`, 400);
  }
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
      throw new CLICommandError(`Failed to resolve survey: ${error.message}`, 500);
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

/**
 * The class identity block every command echoes back. `time_zone` is included so the
 * CLI can render timestamps in the class's zone: dates were formatted in whatever zone
 * the operator's machine happened to be in, which silently moved deadlines across day
 * boundaries for anyone working away from campus.
 */
export function classSummary(classData: ClassRow): {
  id: number;
  slug: string | null;
  name: string | null;
  time_zone: string;
} {
  return {
    id: classData.id,
    slug: classData.slug,
    name: classData.name,
    time_zone: classData.time_zone
  };
}
