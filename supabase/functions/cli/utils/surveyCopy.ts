/**
 * Survey copy helpers for CLI — date shifting for assignment-linked surveys and insert of new rows.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { AssignmentRow, CopyStatus, SurveyRow } from "../types.ts";
import { CLICommandError } from "../errors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toMillis(iso: string | null | undefined): number | null {
  if (iso == null || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Shift survey availability / due dates when linked to an assignment (see CLI plan §1).
 */
export function computeShiftedSurveyDates(
  sourceSurvey: SurveyRow,
  sourceAssignment: AssignmentRow,
  targetEffectiveRelease: string | null | undefined,
  targetEffectiveDue: string | null | undefined
): { available_at: string | null; due_date: string | null; warnings: string[] } {
  const warnings: string[] = [];
  let available_at: string | null = null;
  let due_date: string | null = null;

  const srcRel = toMillis(sourceAssignment.release_date);
  const srcDue = toMillis(sourceAssignment.due_date);
  const tgtRel = toMillis(targetEffectiveRelease ?? null);
  const tgtDue = toMillis(targetEffectiveDue ?? null);

  const srcAvail = toMillis(sourceSurvey.available_at);
  if (srcAvail !== null && srcRel !== null && tgtRel !== null) {
    available_at = new Date(tgtRel + (srcAvail - srcRel)).toISOString();
  } else {
    if (sourceSurvey.available_at) {
      warnings.push(
        "Could not shift available_at (missing source assignment release_date, target release, or survey available_at)"
      );
    }
  }

  const srcSurveyDue = toMillis(sourceSurvey.due_date);
  if (srcSurveyDue !== null) {
    if (srcDue !== null && tgtDue !== null) {
      due_date = new Date(tgtDue + (srcSurveyDue - srcDue)).toISOString();
    } else if (srcRel !== null && tgtRel !== null) {
      due_date = new Date(tgtRel + (srcSurveyDue - srcRel)).toISOString();
    } else {
      warnings.push("Could not shift due_date (missing anchors)");
    }
  }

  return { available_at, due_date, warnings };
}

export function dedupeSurveysToLatestVersion(rows: SurveyRow[]): SurveyRow[] {
  const best = new Map<string, SurveyRow>();
  for (const row of rows) {
    const key = row.survey_id;
    const prev = best.get(key);
    if (!prev || row.version > prev.version) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

export async function fetchLatestLinkedSurveysForAssignment(
  supabase: SupabaseClient<Database>,
  classId: number,
  assignmentId: number
): Promise<SurveyRow[]> {
  const { data, error } = await supabase
    .from("surveys")
    .select("*")
    .eq("class_id", classId)
    .eq("assignment_id", assignmentId)
    .is("deleted_at", null);

  if (error) {
    throw new CLICommandError(`Failed to fetch linked surveys: ${error.message}`);
  }
  return dedupeSurveysToLatestVersion((data ?? []) as SurveyRow[]);
}

export async function fetchLatestSurveysForClass(
  supabase: SupabaseClient<Database>,
  classId: number
): Promise<SurveyRow[]> {
  const { data, error } = await supabase.from("surveys").select("*").eq("class_id", classId).is("deleted_at", null);

  if (error) {
    throw new CLICommandError(`Failed to fetch surveys: ${error.message}`);
  }
  return dedupeSurveysToLatestVersion((data ?? []) as SurveyRow[]);
}

export async function resolveSourceAssignmentForSurvey(
  supabase: SupabaseClient<Database>,
  classId: number,
  assignmentId: number
): Promise<AssignmentRow> {
  const { data, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("class_id", classId)
    .eq("id", assignmentId)
    .single();

  if (error || !data) {
    throw new CLICommandError(`Source assignment not found for survey link: ${assignmentId}`);
  }
  return data as AssignmentRow;
}

/** Target assignment with same slug as source, if any. */
export async function resolveTargetAssignmentBySourceSlug(
  supabase: SupabaseClient<Database>,
  sourceAssignment: AssignmentRow,
  targetClassId: number
): Promise<AssignmentRow | null> {
  if (!sourceAssignment.slug) {
    return null;
  }
  const { data } = await supabase
    .from("assignments")
    .select("*")
    .eq("class_id", targetClassId)
    .eq("slug", sourceAssignment.slug)
    .maybeSingle();
  return data ? (data as AssignmentRow) : null;
}

export interface CopySurveyDatesPlan {
  available_at: string | null;
  due_date: string | null;
  warnings: string[];
}

export function planSurveyDatesForCopy(
  sourceSurvey: SurveyRow,
  sourceAssignmentForOffsets: AssignmentRow | null,
  targetAssignmentForAnchors: AssignmentRow | null,
  targetReleaseOverride: string | null | undefined,
  targetDueOverride: string | null | undefined
): CopySurveyDatesPlan {
  const warnings: string[] = [];

  if (sourceSurvey.assignment_id != null && sourceAssignmentForOffsets && targetAssignmentForAnchors) {
    const effRel = targetReleaseOverride ?? targetAssignmentForAnchors.release_date ?? null;
    const effDue = targetDueOverride ?? targetAssignmentForAnchors.due_date ?? null;
    const shifted = computeShiftedSurveyDates(sourceSurvey, sourceAssignmentForOffsets, effRel, effDue);
    warnings.push(...shifted.warnings);
    return {
      available_at: shifted.available_at,
      due_date: shifted.due_date,
      warnings
    };
  }

  return {
    available_at: sourceSurvey.available_at ?? null,
    due_date: sourceSurvey.due_date ?? null,
    warnings
  };
}

export interface CopySurveyToClassResult {
  id: string;
  survey_id: string;
}

/** Insert a new survey row in the target class (new PK and logical survey_id). */
export async function copySurveyToClass(
  supabase: SupabaseClient<Database>,
  sourceSurvey: SurveyRow,
  targetClassId: number,
  options: {
    targetAssignmentId: number | null;
    available_at: string | null;
    due_date: string | null;
  }
): Promise<CopySurveyToClassResult> {
  const newId = crypto.randomUUID();
  const newLogicalId = crypto.randomUUID();
  const now = new Date().toISOString();

  const insertPayload: Database["public"]["Tables"]["surveys"]["Insert"] = {
    id: newId,
    survey_id: newLogicalId,
    version: 1,
    class_id: targetClassId,
    created_by: sourceSurvey.created_by,
    title: sourceSurvey.title,
    description: sourceSurvey.description,
    json: sourceSurvey.json,
    status: sourceSurvey.status,
    allow_response_editing: sourceSurvey.allow_response_editing,
    type: sourceSurvey.type,
    assigned_to_all: sourceSurvey.assigned_to_all,
    validation_errors: sourceSurvey.validation_errors,
    analytics_config: sourceSurvey.analytics_config,
    series_id: sourceSurvey.series_id,
    series_ordinal: sourceSurvey.series_ordinal,
    assignment_id: options.targetAssignmentId,
    available_at: options.available_at,
    due_date: options.due_date,
    deleted_at: null,
    created_at: now,
    updated_at: now
  };

  const { data, error } = await supabase.from("surveys").insert(insertPayload).select("id, survey_id").single();

  if (error || !data) {
    throw new CLICommandError(`Failed to insert copied survey: ${error?.message ?? "unknown"}`);
  }

  return { id: data.id, survey_id: data.survey_id };
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Copy surveys linked to a source assignment onto a target assignment (non-fatal errors on status). */
export async function copyLinkedSurveysForAssignment(
  supabase: SupabaseClient<Database>,
  sourceClassId: number,
  sourceAssignment: AssignmentRow,
  targetClassId: number,
  targetAssignment: AssignmentRow,
  targetReleaseOverride: string | undefined,
  targetDueOverride: string | undefined,
  status: CopyStatus
): Promise<void> {
  let copied = 0;
  try {
    const linked = await fetchLatestLinkedSurveysForAssignment(supabase, sourceClassId, sourceAssignment.id);
    for (const s of linked) {
      try {
        const plan = planSurveyDatesForCopy(
          s,
          sourceAssignment,
          targetAssignment,
          targetReleaseOverride,
          targetDueOverride
        );
        await copySurveyToClass(supabase, s, targetClassId, {
          targetAssignmentId: targetAssignment.id,
          available_at: plan.available_at,
          due_date: plan.due_date
        });
        copied += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.errors.push({ step: "survey_copy", error: msg });
      }
    }
    if (copied > 0) {
      status.surveysCopied = true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    status.errors.push({ step: "survey_copy", error: msg });
  }
}
