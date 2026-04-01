/**
 * Surveys commands — copy between classes.
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveSurvey, resolveAssignment } from "../utils/resolvers.ts";
import {
  copySurveyToClass,
  fetchLatestSurveysForClass,
  planSurveyDatesForCopy,
  resolveSourceAssignmentForSurvey,
  resolveTargetAssignmentBySourceSlug
} from "../utils/surveyCopy.ts";
import { CLICommandError } from "../errors.ts";
import type { CLIResponse, SurveysCopyParams, AssignmentRow, SurveyRow } from "../types.ts";

async function handleSurveysCopy(_ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as SurveysCopyParams;
  const sourceClassId = p.source_class;
  const targetClassId = p.target_class;
  const surveyIdent = p.survey;
  const copyAll = p.all === true;
  const dryRun = p.dry_run === true;
  const targetAssignmentIdent = p.target_assignment;

  if (!sourceClassId) throw new CLICommandError("source_class is required");
  if (!targetClassId) throw new CLICommandError("target_class is required");

  const specified = [surveyIdent, copyAll].filter(Boolean).length;
  if (specified !== 1) {
    throw new CLICommandError("Must specify exactly one of: survey, all");
  }

  const supabase = getAdminClient();
  const sourceClass = await resolveClass(supabase, sourceClassId);
  const targetClass = await resolveClass(supabase, targetClassId);

  if (sourceClass.id === targetClass.id) {
    throw new CLICommandError("Source and target classes must be different");
  }

  let toCopy: SurveyRow[] = [];
  if (surveyIdent) {
    toCopy = [await resolveSurvey(supabase, sourceClass.id, surveyIdent)];
  } else {
    toCopy = await fetchLatestSurveysForClass(supabase, sourceClass.id);
  }

  if (toCopy.length === 0) {
    throw new CLICommandError("No surveys to copy");
  }

  let explicitTargetAssignment: AssignmentRow | null = null;
  if (targetAssignmentIdent) {
    explicitTargetAssignment = await resolveAssignment(supabase, targetClass.id, targetAssignmentIdent);
  }

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
        target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
        surveys_to_copy: toCopy.map((s) => ({
          id: s.id,
          survey_id: s.survey_id,
          title: s.title,
          assignment_id: s.assignment_id,
          has_analytics_config: s.analytics_config != null
        })),
        target_assignment: explicitTargetAssignment
          ? { id: explicitTargetAssignment.id, slug: explicitTargetAssignment.slug }
          : null
      }
    };
  }

  const results: Array<{
    source_title: string;
    source_survey_id: string;
    success: boolean;
    new_survey_id?: string;
    new_survey_logical_id?: string;
    error?: string;
    warnings?: string[];
  }> = [];

  for (const src of toCopy) {
    try {
      let sourceAssignmentForOffsets: AssignmentRow | null = null;
      if (src.assignment_id != null) {
        sourceAssignmentForOffsets = await resolveSourceAssignmentForSurvey(
          supabase,
          sourceClass.id,
          src.assignment_id
        );
      }

      let targetAssignmentForAnchors: AssignmentRow | null = explicitTargetAssignment;
      if (!targetAssignmentForAnchors && sourceAssignmentForOffsets) {
        targetAssignmentForAnchors = await resolveTargetAssignmentBySourceSlug(
          supabase,
          sourceAssignmentForOffsets,
          targetClass.id
        );
      }

      let targetAssignmentId: number | null = targetAssignmentForAnchors?.id ?? null;
      const warnings: string[] = [];

      if (explicitTargetAssignment) {
        targetAssignmentId = explicitTargetAssignment.id;
        if (!src.assignment_id) {
          targetAssignmentForAnchors = explicitTargetAssignment;
        }
      }

      if (src.assignment_id != null && targetAssignmentId === null) {
        warnings.push("No matching assignment in target class — copied survey is unlinked; dates kept as in source");
      }

      const plan = planSurveyDatesForCopy(
        src,
        sourceAssignmentForOffsets,
        targetAssignmentForAnchors,
        targetAssignmentForAnchors?.release_date ?? undefined,
        targetAssignmentForAnchors?.due_date ?? undefined
      );
      warnings.push(...plan.warnings);

      const { id: newId, survey_id: newLogical } = await copySurveyToClass(supabase, src, targetClass.id, {
        targetAssignmentId: targetAssignmentId,
        available_at: plan.available_at,
        due_date: plan.due_date
      });

      results.push({
        source_title: src.title,
        source_survey_id: src.survey_id,
        success: true,
        new_survey_id: newId,
        new_survey_logical_id: newLogical,
        warnings: warnings.length > 0 ? warnings : undefined
      });
    } catch (err) {
      results.push({
        source_title: src.title,
        source_survey_id: src.survey_id,
        success: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    success: true,
    data: {
      source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
      target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
      results,
      summary: {
        total: toCopy.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length
      }
    }
  };
}

registerCommand({
  name: "surveys.copy",
  requiredScope: "cli:write",
  handler: handleSurveysCopy
});
