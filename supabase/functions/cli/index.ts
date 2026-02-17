/**
 * CLI Edge Function
 *
 * Single edge function that handles all CLI commands.
 * Each CLI command maps to one POST request with a `command` field.
 *
 * Authentication: Requires valid API token with cli:read or cli:write scopes.
 *
 * Commands:
 *   READ (cli:read):
 *     - classes.list
 *     - classes.show
 *     - assignments.list
 *     - assignments.show
 *     - rubrics.list
 *     - rubrics.export
 *     - flashcards.list
 *
 *   WRITE (cli:write):
 *     - assignments.copy
 *     - assignments.delete
 *     - rubrics.import
 *     - flashcards.copy
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  authenticateMCPRequest,
  MCPAuthContext,
  MCPAuthError,
  requireScope,
  updateTokenLastUsed
} from "../_shared/MCPAuth.ts";
import { getOctoKit } from "../_shared/GitHubWrapper.ts";

// Initialize Sentry if configured
if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA")
  });
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// ─── Admin Supabase client ───────────────────────────────────────────────────

function getAdminClient(): SupabaseClient<Database> {
  return createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface CLIRequest {
  command: string;
  params: Record<string, unknown>;
}

interface CLIResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Helper: Resolve class by ID, slug, or name ─────────────────────────────

async function resolveClass(
  supabase: SupabaseClient<Database>,
  identifier: string | number
) {
  // Try by ID first
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data, error } = await supabase
      .from("classes")
      .select("*")
      .eq("id", Number(identifier))
      .single();
    if (!error && data) return data;
  }

  // Try by slug
  const { data: bySlug } = await supabase
    .from("classes")
    .select("*")
    .eq("slug", String(identifier))
    .single();
  if (bySlug) return bySlug;

  // Try by name (partial match)
  const { data: byName } = await supabase
    .from("classes")
    .select("*")
    .ilike("name", `%${String(identifier)}%`)
    .limit(1)
    .single();
  if (byName) return byName;

  throw new CLICommandError(`Class not found: ${identifier}`, 404);
}

// ─── Helper: Resolve assignment by ID or slug within a class ─────────────────

async function resolveAssignment(
  supabase: SupabaseClient<Database>,
  classId: number,
  identifier: string | number
) {
  // Try by ID first
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data } = await supabase
      .from("assignments")
      .select("*")
      .eq("id", Number(identifier))
      .eq("class_id", classId)
      .single();
    if (data) return data;
  }

  // Try by slug
  const { data: bySlug } = await supabase
    .from("assignments")
    .select("*")
    .eq("slug", String(identifier))
    .eq("class_id", classId)
    .single();
  if (bySlug) return bySlug;

  throw new CLICommandError(`Assignment not found: ${identifier} in class ${classId}`, 404);
}

// ─── Helper: Fetch rubric with full hierarchy ────────────────────────────────

async function fetchRubricWithHierarchy(
  supabase: SupabaseClient<Database>,
  rubricId: number
) {
  const { data, error } = await supabase
    .from("rubrics")
    .select(`
      *,
      rubric_parts (
        *,
        rubric_criteria (
          *,
          rubric_checks (*)
        )
      )
    `)
    .eq("id", rubricId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new CLICommandError(`Failed to fetch rubric: ${error.message}`);
  }
  return data;
}

// ─── Custom Error ────────────────────────────────────────────────────────────

class CLICommandError extends Error {
  status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "CLICommandError";
    this.status = status;
  }
}

// ─── Command Handlers ────────────────────────────────────────────────────────

// READ commands require cli:read scope
// WRITE commands require cli:write scope

async function handleClassesList(
  ctx: MCPAuthContext,
  _params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:read");
  const supabase = getAdminClient();

  const { data: classes, error } = await supabase
    .from("classes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new CLICommandError(`Failed to list classes: ${error.message}`);

  return {
    success: true,
    data: {
      classes: (classes || []).map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        semester: c.semester,
        github_org: c.github_org,
        time_zone: c.time_zone,
        canvas_id: c.canvas_id,
        is_demo: c.is_demo
      }))
    }
  };
}

async function handleClassesShow(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:read");
  const supabase = getAdminClient();

  const identifier = params.identifier as string;
  if (!identifier) throw new CLICommandError("identifier is required");

  const classData = await resolveClass(supabase, identifier);

  return {
    success: true,
    data: {
      class: {
        id: classData.id,
        slug: classData.slug,
        name: classData.name,
        semester: classData.semester,
        github_org: classData.github_org,
        time_zone: classData.time_zone,
        canvas_id: classData.canvas_id,
        is_demo: classData.is_demo
      }
    }
  };
}

async function handleAssignmentsList(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:read");
  const supabase = getAdminClient();

  const classIdentifier = params.class as string;
  if (!classIdentifier) throw new CLICommandError("class is required");

  const classData = await resolveClass(supabase, classIdentifier);

  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("class_id", classData.id)
    .order("release_date", { ascending: true });

  if (error) throw new CLICommandError(`Failed to fetch assignments: ${error.message}`);

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignments: (assignments || []).map((a) => ({
        id: a.id,
        slug: a.slug,
        title: a.title,
        description: a.description,
        release_date: a.release_date,
        due_date: a.due_date,
        latest_due_date: a.latest_due_date,
        total_points: a.total_points,
        has_autograder: a.has_autograder,
        has_handgrader: a.has_handgrader,
        template_repo: a.template_repo,
        grading_rubric_id: a.grading_rubric_id,
        self_review_rubric_id: a.self_review_rubric_id,
        meta_grading_rubric_id: a.meta_grading_rubric_id
      }))
    }
  };
}

async function handleAssignmentsShow(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:read");
  const supabase = getAdminClient();

  const classIdentifier = params.class as string;
  const assignmentIdentifier = params.identifier as string;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("identifier is required");

  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignment: {
        id: assignment.id,
        slug: assignment.slug,
        title: assignment.title,
        class_id: assignment.class_id,
        description: assignment.description,
        release_date: assignment.release_date,
        due_date: assignment.due_date,
        latest_due_date: assignment.latest_due_date,
        total_points: assignment.total_points,
        max_late_tokens: assignment.max_late_tokens,
        group_config: assignment.group_config,
        has_autograder: assignment.has_autograder,
        has_handgrader: assignment.has_handgrader,
        template_repo: assignment.template_repo,
        grading_rubric_id: assignment.grading_rubric_id,
        self_review_rubric_id: assignment.self_review_rubric_id,
        meta_grading_rubric_id: assignment.meta_grading_rubric_id
      }
    }
  };
}

async function handleAssignmentsDelete(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:write");
  const supabase = getAdminClient();

  const classIdentifier = params.class as string;
  const assignmentIdentifier = params.identifier as string;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("identifier is required");

  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  // Use the existing assignment-delete edge function logic internally
  // by calling the Supabase function
  const { data, error } = await supabase.functions.invoke("assignment-delete", {
    body: { assignment_id: assignment.id, class_id: classData.id }
  });

  if (error) throw new CLICommandError(`Failed to delete assignment: ${error.message}`);
  if (data?.error) {
    throw new CLICommandError(
      `Failed to delete assignment: ${data.error.details || data.error.message || "Unknown error"}`
    );
  }

  return {
    success: true,
    data: {
      message: `Assignment "${assignment.title}" has been deleted`,
      assignment_id: assignment.id,
      details: data?.message
    }
  };
}

async function handleRubricsList(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:read");
  const supabase = getAdminClient();

  const classIdentifier = params.class as string;
  const assignmentIdentifier = params.assignment as string;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");

  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  const rubricTypes = [
    { type: "grading", id: assignment.grading_rubric_id },
    { type: "self_review", id: assignment.self_review_rubric_id },
    { type: "meta", id: assignment.meta_grading_rubric_id }
  ];

  const rubrics = [];
  for (const rubric of rubricTypes) {
    if (rubric.id) {
      const { data } = await supabase
        .from("rubrics")
        .select("id, name, description")
        .eq("id", rubric.id)
        .single();

      rubrics.push({
        type: rubric.type,
        id: rubric.id,
        name: data?.name || null,
        description: data?.description || null
      });
    } else {
      rubrics.push({ type: rubric.type, id: null, name: null, description: null });
    }
  }

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignment: { id: assignment.id, slug: assignment.slug, title: assignment.title },
      rubrics
    }
  };
}

async function handleRubricsExport(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:read");
  const supabase = getAdminClient();

  const classIdentifier = params.class as string;
  const assignmentIdentifier = params.assignment as string;
  const rubricType = (params.type as string) || "grading";
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");

  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  let rubricId: number | null = null;
  if (rubricType === "grading") {
    rubricId = assignment.grading_rubric_id;
  } else if (rubricType === "self_review") {
    rubricId = assignment.self_review_rubric_id;
  } else if (rubricType === "meta") {
    rubricId = assignment.meta_grading_rubric_id;
  } else {
    throw new CLICommandError(`Invalid rubric type: ${rubricType}. Must be grading, self_review, or meta`);
  }

  if (!rubricId) {
    throw new CLICommandError(`No ${rubricType} rubric found for this assignment`);
  }

  const rubric = await fetchRubricWithHierarchy(supabase, rubricId);
  if (!rubric) throw new CLICommandError(`Rubric not found: ${rubricId}`);

  // Build export data (same structure as YML export)
  const exportData = {
    name: rubric.name,
    description: rubric.description,
    cap_score_to_assignment_points: rubric.cap_score_to_assignment_points,
    is_private: rubric.is_private,
    review_round: rubric.review_round,
    parts: ((rubric as any).rubric_parts || []).map((part: any) => ({
      name: part.name,
      description: part.description,
      ordinal: part.ordinal,
      criteria: (part.rubric_criteria || []).map((criteria: any) => ({
        name: criteria.name,
        description: criteria.description,
        ordinal: criteria.ordinal,
        total_points: criteria.total_points,
        is_additive: criteria.is_additive,
        is_deduction_only: criteria.is_deduction_only,
        min_checks_per_submission: criteria.min_checks_per_submission,
        max_checks_per_submission: criteria.max_checks_per_submission,
        checks: (criteria.rubric_checks || []).map((check: any) => ({
          name: check.name,
          description: check.description,
          ordinal: check.ordinal,
          points: check.points,
          is_annotation: check.is_annotation,
          is_comment_required: check.is_comment_required,
          is_required: check.is_required,
          annotation_target: check.annotation_target,
          artifact: check.artifact,
          file: check.file,
          group: check.group,
          max_annotations: check.max_annotations,
          student_visibility: check.student_visibility
        }))
      }))
    }))
  };

  return {
    success: true,
    data: {
      rubric_type: rubricType,
      rubric_id: rubricId,
      rubric: exportData
    }
  };
}

async function handleRubricsImport(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:write");
  const supabase = getAdminClient();

  const classIdentifier = params.class as string;
  const assignmentIdentifier = params.assignment as string;
  const rubricType = (params.type as string) || "grading";
  const rubricData = params.rubric as any;
  const dryRun = params.dry_run === true;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");
  if (!rubricData) throw new CLICommandError("rubric data is required");
  if (!rubricData.name) throw new CLICommandError("rubric.name is required");
  if (!Array.isArray(rubricData.parts)) throw new CLICommandError("rubric.parts must be an array");

  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  let targetRubricId: number | null = null;
  if (rubricType === "grading") {
    targetRubricId = assignment.grading_rubric_id;
  } else if (rubricType === "self_review") {
    targetRubricId = assignment.self_review_rubric_id;
  } else if (rubricType === "meta") {
    targetRubricId = assignment.meta_grading_rubric_id;
  } else {
    throw new CLICommandError(`Invalid rubric type: ${rubricType}`);
  }

  if (!targetRubricId) {
    throw new CLICommandError(`No ${rubricType} rubric exists for this assignment. Create the rubric first.`);
  }

  // Count items for summary
  let partCount = rubricData.parts.length;
  let criteriaCount = 0;
  let checkCount = 0;
  for (const part of rubricData.parts) {
    if (!Array.isArray(part.criteria)) {
      throw new CLICommandError(`Part '${part.name}' must have 'criteria' array`);
    }
    criteriaCount += part.criteria.length;
    for (const criteria of part.criteria) {
      if (!Array.isArray(criteria.checks)) {
        throw new CLICommandError(`Criteria '${criteria.name}' must have 'checks' array`);
      }
      checkCount += criteria.checks.length;
    }
  }

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        rubric_type: rubricType,
        target_rubric_id: targetRubricId,
        summary: { parts: partCount, criteria: criteriaCount, checks: checkCount },
        rubric: rubricData
      }
    };
  }

  // Clear existing rubric content
  await supabase.from("rubric_check_references").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_checks").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_criteria").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_parts").delete().eq("rubric_id", targetRubricId);

  // Update rubric metadata
  const { error: updateError } = await supabase
    .from("rubrics")
    .update({
      name: rubricData.name,
      description: rubricData.description ?? null,
      cap_score_to_assignment_points: rubricData.cap_score_to_assignment_points ?? true,
      is_private: rubricData.is_private ?? false,
      review_round: rubricData.review_round ?? null
    })
    .eq("id", targetRubricId);

  if (updateError) throw new CLICommandError(`Failed to update rubric: ${updateError.message}`);

  // Import parts, criteria, checks
  for (const part of rubricData.parts) {
    const { data: newPart, error: partError } = await supabase
      .from("rubric_parts")
      .insert({
        assignment_id: assignment.id,
        class_id: classData.id,
        rubric_id: targetRubricId,
        name: part.name,
        description: part.description ?? null,
        ordinal: part.ordinal
      })
      .select("id")
      .single();

    if (partError || !newPart) {
      throw new CLICommandError(`Failed to create part '${part.name}': ${partError?.message || "Unknown"}`);
    }

    for (const criteria of part.criteria) {
      const { data: newCriteria, error: criteriaError } = await supabase
        .from("rubric_criteria")
        .insert({
          assignment_id: assignment.id,
          class_id: classData.id,
          rubric_id: targetRubricId,
          rubric_part_id: newPart.id,
          name: criteria.name,
          description: criteria.description ?? null,
          ordinal: criteria.ordinal,
          total_points: criteria.total_points,
          is_additive: criteria.is_additive ?? false,
          is_deduction_only: criteria.is_deduction_only ?? false,
          min_checks_per_submission: criteria.min_checks_per_submission ?? null,
          max_checks_per_submission: criteria.max_checks_per_submission ?? null
        })
        .select("id")
        .single();

      if (criteriaError || !newCriteria) {
        throw new CLICommandError(`Failed to create criteria '${criteria.name}': ${criteriaError?.message || "Unknown"}`);
      }

      for (const check of criteria.checks) {
        const { error: checkError } = await supabase.from("rubric_checks").insert({
          assignment_id: assignment.id,
          class_id: classData.id,
          rubric_id: targetRubricId,
          rubric_criteria_id: newCriteria.id,
          name: check.name,
          description: check.description ?? null,
          ordinal: check.ordinal,
          points: check.points,
          is_annotation: check.is_annotation ?? false,
          is_comment_required: check.is_comment_required ?? false,
          is_required: check.is_required ?? false,
          annotation_target: check.annotation_target ?? null,
          artifact: check.artifact ?? null,
          file: check.file ?? null,
          group: check.group ?? null,
          max_annotations: check.max_annotations ?? null,
          student_visibility: check.student_visibility ?? "visible"
        });

        if (checkError) {
          throw new CLICommandError(`Failed to create check '${check.name}': ${checkError.message}`);
        }
      }
    }
  }

  return {
    success: true,
    data: {
      rubric_type: rubricType,
      rubric_id: targetRubricId,
      summary: { parts: partCount, criteria: criteriaCount, checks: checkCount },
      message: "Rubric imported successfully"
    }
  };
}

async function handleFlashcardsList(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:read");
  const supabase = getAdminClient();

  const classIdentifier = params.class as string;
  if (!classIdentifier) throw new CLICommandError("class is required");

  const classData = await resolveClass(supabase, classIdentifier);

  const { data: decks, error } = await supabase
    .from("flashcard_decks")
    .select("id, name, description, created_at")
    .eq("class_id", classData.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new CLICommandError(`Failed to fetch flashcard decks: ${error.message}`);

  // Get card counts
  const { data: cardCounts } = await supabase
    .from("flashcards")
    .select("deck_id")
    .eq("class_id", classData.id)
    .is("deleted_at", null);

  const countMap = new Map<number, number>();
  if (cardCounts) {
    for (const card of cardCounts) {
      countMap.set(card.deck_id, (countMap.get(card.deck_id) || 0) + 1);
    }
  }

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      decks: (decks || []).map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        card_count: countMap.get(d.id) || 0,
        created_at: d.created_at
      }))
    }
  };
}

async function handleFlashcardsCopy(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:write");
  const supabase = getAdminClient();

  const sourceClassId = params.source_class as string;
  const targetClassId = params.target_class as string;
  const deckIdentifier = params.deck as string | undefined;
  const copyAll = params.all === true;
  const dryRun = params.dry_run === true;

  if (!sourceClassId) throw new CLICommandError("source_class is required");
  if (!targetClassId) throw new CLICommandError("target_class is required");
  if (!deckIdentifier && !copyAll) throw new CLICommandError("Must specify deck or all");

  const sourceClass = await resolveClass(supabase, sourceClassId);
  const targetClass = await resolveClass(supabase, targetClassId);

  if (sourceClass.id === targetClass.id) {
    throw new CLICommandError("Source and target classes must be different");
  }

  // Fetch decks to copy
  let decksQuery = supabase
    .from("flashcard_decks")
    .select("*")
    .eq("class_id", sourceClass.id)
    .is("deleted_at", null);

  if (deckIdentifier) {
    const deckId = parseInt(deckIdentifier, 10);
    if (!isNaN(deckId)) {
      decksQuery = decksQuery.eq("id", deckId);
    } else {
      decksQuery = decksQuery.eq("name", deckIdentifier);
    }
  }

  const { data: sourceDecks, error: decksError } = await decksQuery;
  if (decksError) throw new CLICommandError(`Failed to fetch source decks: ${decksError.message}`);
  if (!sourceDecks || sourceDecks.length === 0) {
    throw new CLICommandError("No flashcard decks found to copy");
  }

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
        target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
        decks_to_copy: sourceDecks.map((d) => ({ id: d.id, name: d.name, description: d.description }))
      }
    };
  }

  const creatorId = sourceDecks[0].creator_id;
  const results = [];

  for (const sourceDeck of sourceDecks) {
    try {
      const { data: newDeck, error: createError } = await supabase
        .from("flashcard_decks")
        .insert({
          class_id: targetClass.id,
          creator_id: creatorId,
          name: sourceDeck.name,
          description: sourceDeck.description
        })
        .select("id")
        .single();

      if (createError || !newDeck) {
        results.push({ deck: sourceDeck.name, success: false, error: createError?.message || "Unknown" });
        continue;
      }

      // Fetch and copy cards
      const { data: sourceCards } = await supabase
        .from("flashcards")
        .select("*")
        .eq("deck_id", sourceDeck.id)
        .is("deleted_at", null)
        .order("order", { ascending: true, nullsFirst: false });

      let cardCount = 0;
      if (sourceCards && sourceCards.length > 0) {
        const newCards = sourceCards.map((card) => ({
          deck_id: newDeck.id,
          class_id: targetClass.id,
          title: card.title,
          prompt: card.prompt,
          answer: card.answer,
          order: card.order
        }));

        const { error: insertError } = await supabase.from("flashcards").insert(newCards);
        if (insertError) {
          results.push({ deck: sourceDeck.name, success: false, error: `Cards failed: ${insertError.message}` });
          continue;
        }
        cardCount = sourceCards.length;
      }

      results.push({ deck: sourceDeck.name, success: true, new_deck_id: newDeck.id, cards_copied: cardCount });
    } catch (err) {
      results.push({ deck: sourceDeck.name, success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    success: true,
    data: {
      source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
      target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
      results,
      summary: {
        total: sourceDecks.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length
      }
    }
  };
}

// ─── Assignment Copy ─────────────────────────────────────────────────────────

async function handleAssignmentsCopy(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  requireScope(ctx, "cli:write");
  const supabase = getAdminClient();

  const sourceClassId = params.source_class as string;
  const targetClassId = params.target_class as string;
  const assignmentIdentifier = params.assignment as string | undefined;
  const copyAll = params.all === true;
  const dryRun = params.dry_run === true;
  const skipRepos = params.skip_repos === true;
  const skipRubrics = params.skip_rubrics === true;

  // Schedule overrides: array of { assignment_slug, release_date, due_date, latest_due_date }
  const schedule = params.schedule as any[] | undefined;

  if (!sourceClassId) throw new CLICommandError("source_class is required");
  if (!targetClassId) throw new CLICommandError("target_class is required");

  const specifiedCount = [assignmentIdentifier, schedule, copyAll].filter(Boolean).length;
  if (specifiedCount !== 1) {
    throw new CLICommandError("Must specify exactly one of: assignment, schedule, or all");
  }

  const sourceClass = await resolveClass(supabase, sourceClassId);
  const targetClass = await resolveClass(supabase, targetClassId);

  if (sourceClass.id === targetClass.id) {
    throw new CLICommandError("Source and target classes must be different");
  }

  if (!skipRepos && !targetClass.github_org) {
    throw new CLICommandError("Target class must have a GitHub org configured (use skip_repos to skip)");
  }

  // Determine assignments to copy
  interface CopySpec {
    assignment: any;
    releaseDateOverride?: string;
    dueDateOverride?: string;
    latestDueDateOverride?: string;
  }

  const assignmentsToCopy: CopySpec[] = [];

  if (assignmentIdentifier) {
    const assignment = await resolveAssignment(supabase, sourceClass.id, assignmentIdentifier);
    assignmentsToCopy.push({ assignment });
  } else if (copyAll) {
    const { data: allAssignments } = await supabase
      .from("assignments")
      .select("*")
      .eq("class_id", sourceClass.id)
      .order("release_date", { ascending: true });
    for (const a of allAssignments || []) {
      assignmentsToCopy.push({ assignment: a });
    }
  } else if (schedule) {
    // Schedule is an array of objects with assignment_slug/assignment_title and date overrides
    const { data: allAssignments } = await supabase
      .from("assignments")
      .select("*")
      .eq("class_id", sourceClass.id);

    const bySlug = new Map<string, any>();
    const byTitle = new Map<string, any>();
    for (const a of allAssignments || []) {
      bySlug.set(a.slug, a);
      byTitle.set(a.title, a);
    }

    for (const row of schedule) {
      let assignment;
      if (row.assignment_slug) {
        assignment = bySlug.get(row.assignment_slug);
        if (!assignment) throw new CLICommandError(`No assignment found with slug "${row.assignment_slug}"`);
      } else if (row.assignment_title) {
        assignment = byTitle.get(row.assignment_title);
        if (!assignment) throw new CLICommandError(`No assignment found with title "${row.assignment_title}"`);
      } else {
        throw new CLICommandError("Each schedule item must have assignment_slug or assignment_title");
      }
      assignmentsToCopy.push({
        assignment,
        releaseDateOverride: row.release_date,
        dueDateOverride: row.due_date,
        latestDueDateOverride: row.latest_due_date
      });
    }
  }

  if (assignmentsToCopy.length === 0) {
    throw new CLICommandError("No assignments to copy");
  }

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
        target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
        assignments_to_copy: assignmentsToCopy.map((s) => ({
          slug: s.assignment.slug,
          title: s.assignment.title,
          release_date: s.releaseDateOverride || s.assignment.release_date,
          due_date: s.dueDateOverride || s.assignment.due_date
        }))
      }
    };
  }

  // Copy each assignment
  const results = [];
  for (const spec of assignmentsToCopy) {
    try {
      const result = await copySingleAssignment(
        supabase,
        spec.assignment,
        sourceClass,
        targetClass,
        {
          skipRepos,
          skipRubrics,
          releaseDateOverride: spec.releaseDateOverride,
          dueDateOverride: spec.dueDateOverride,
          latestDueDateOverride: spec.latestDueDateOverride
        }
      );
      results.push({
        source_slug: spec.assignment.slug,
        source_title: spec.assignment.title,
        success: true,
        new_assignment_id: result.newAssignmentId
      });
    } catch (err) {
      results.push({
        source_slug: spec.assignment.slug,
        source_title: spec.assignment.title,
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
        total: assignmentsToCopy.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length
      }
    }
  };
}

/**
 * Copy a single assignment with all related data
 */
async function copySingleAssignment(
  supabase: SupabaseClient<Database>,
  sourceAssignment: any,
  sourceClass: any,
  targetClass: any,
  options: {
    skipRepos: boolean;
    skipRubrics: boolean;
    releaseDateOverride?: string;
    dueDateOverride?: string;
    latestDueDateOverride?: string;
  }
): Promise<{ newAssignmentId: number }> {
  // Step 1: Copy self-review settings if they exist
  let newSelfReviewSettingId: number | null = null;
  if (sourceAssignment.self_review_setting_id) {
    const { data: sourceSettings } = await supabase
      .from("assignment_self_review_settings")
      .select("*")
      .eq("id", sourceAssignment.self_review_setting_id)
      .single();

    if (sourceSettings) {
      const { data: newSettings } = await supabase
        .from("assignment_self_review_settings")
        .insert({
          class_id: targetClass.id,
          enabled: sourceSettings.enabled,
          allow_early: sourceSettings.allow_early,
          deadline_offset: sourceSettings.deadline_offset
        })
        .select("id")
        .single();

      newSelfReviewSettingId = newSettings?.id || null;
    }
  }

  // Step 2: Create assignment record
  const newAssignmentData = {
    class_id: targetClass.id,
    title: sourceAssignment.title,
    slug: sourceAssignment.slug,
    description: sourceAssignment.description,
    release_date: options.releaseDateOverride || sourceAssignment.release_date,
    due_date: options.dueDateOverride || sourceAssignment.due_date,
    latest_due_date: options.latestDueDateOverride || sourceAssignment.latest_due_date,
    total_points: sourceAssignment.total_points,
    max_late_tokens: sourceAssignment.max_late_tokens,
    group_config: sourceAssignment.group_config,
    min_group_size: sourceAssignment.min_group_size,
    max_group_size: sourceAssignment.max_group_size,
    allow_student_formed_groups: sourceAssignment.allow_student_formed_groups,
    group_formation_deadline: sourceAssignment.group_formation_deadline,
    has_autograder: sourceAssignment.has_autograder,
    has_handgrader: sourceAssignment.has_handgrader,
    grader_pseudonymous_mode: sourceAssignment.grader_pseudonymous_mode,
    show_leaderboard: sourceAssignment.show_leaderboard,
    allow_not_graded_submissions: sourceAssignment.allow_not_graded_submissions,
    minutes_due_after_lab: sourceAssignment.minutes_due_after_lab,
    self_review_setting_id: newSelfReviewSettingId,
    grading_rubric_id: null,
    self_review_rubric_id: null,
    meta_grading_rubric_id: null,
    template_repo: null,
    student_repo_prefix: null
  };

  const { data: newAssignmentInitial, error: assignmentError } = await supabase
    .from("assignments")
    .insert(newAssignmentData)
    .select("*")
    .single();

  if (assignmentError || !newAssignmentInitial) {
    throw new CLICommandError(`Failed to create assignment: ${assignmentError?.message || "Unknown"}`);
  }

  // Re-fetch to get auto-created rubric IDs
  const { data: newAssignment } = await supabase
    .from("assignments")
    .select("*")
    .eq("id", newAssignmentInitial.id)
    .single();

  if (!newAssignment) {
    throw new CLICommandError("Failed to re-fetch assignment after creation");
  }

  // Step 3: Copy rubrics
  if (!options.skipRubrics) {
    if (sourceAssignment.grading_rubric_id) {
      await copyRubricTree(supabase, sourceAssignment.grading_rubric_id, newAssignment.id, targetClass.id, newAssignment.grading_rubric_id || undefined);
    }
    if (sourceAssignment.self_review_rubric_id) {
      await copyRubricTree(supabase, sourceAssignment.self_review_rubric_id, newAssignment.id, targetClass.id, newAssignment.self_review_rubric_id || undefined);
    }
    if (sourceAssignment.meta_grading_rubric_id) {
      const newMetaRubricId = await copyRubricTree(supabase, sourceAssignment.meta_grading_rubric_id, newAssignment.id, targetClass.id, newAssignment.meta_grading_rubric_id || undefined);
      if (!newAssignment.meta_grading_rubric_id && newMetaRubricId) {
        await supabase
          .from("assignments")
          .update({ meta_grading_rubric_id: newMetaRubricId })
          .eq("id", newAssignment.id);
      }
    }
  }

  // Step 4: Copy autograder config
  if (sourceAssignment.has_autograder) {
    const { data: sourceConfig } = await supabase
      .from("autograder")
      .select("*")
      .eq("id", sourceAssignment.id)
      .single();

    if (sourceConfig) {
      const { data: existing } = await supabase
        .from("autograder")
        .select("id")
        .eq("id", newAssignment.id)
        .single();

      if (existing) {
        await supabase
          .from("autograder")
          .update({
            config: sourceConfig.config,
            max_submissions_count: sourceConfig.max_submissions_count,
            max_submissions_period_secs: sourceConfig.max_submissions_period_secs
          })
          .eq("id", newAssignment.id);
      } else {
        await supabase.from("autograder").insert({
          id: newAssignment.id,
          class_id: targetClass.id,
          config: sourceConfig.config,
          max_submissions_count: sourceConfig.max_submissions_count,
          max_submissions_period_secs: sourceConfig.max_submissions_period_secs,
          grader_repo: null,
          grader_commit_sha: null,
          workflow_sha: null,
          latest_autograder_sha: null
        });
      }
    }
  }

  // Step 5: Copy git repositories via GitHub API
  if (!options.skipRepos && targetClass.github_org) {
    // Copy handout repo
    if (sourceAssignment.template_repo) {
      try {
        // Create handout repo via edge function
        const { data: handoutData } = await supabase.functions.invoke("assignment-create-handout-repo", {
          body: { assignment_id: newAssignment.id, class_id: targetClass.id }
        });

        if (handoutData && !handoutData.error) {
          const targetRepoFullName = `${handoutData.org_name}/${handoutData.repo_name}`;

          // Copy repo contents via GitHub API
          await copyRepoContentsViaGitHub(sourceAssignment.template_repo, targetRepoFullName);
        }
      } catch (err) {
        console.error("Failed to copy handout repo:", err);
        // Don't fail the entire copy for repo issues
      }
    }

    // Copy solution repo
    if (sourceAssignment.has_autograder) {
      const { data: sourceAutograder } = await supabase
        .from("autograder")
        .select("grader_repo")
        .eq("id", sourceAssignment.id)
        .single();

      if (sourceAutograder?.grader_repo) {
        try {
          const { data: solutionData } = await supabase.functions.invoke("assignment-create-solution-repo", {
            body: { assignment_id: newAssignment.id, class_id: targetClass.id }
          });

          if (solutionData && !solutionData.error) {
            const targetRepoFullName = `${solutionData.org_name}/${solutionData.repo_name}`;
            await copyRepoContentsViaGitHub(sourceAutograder.grader_repo, targetRepoFullName);
          }
        } catch (err) {
          console.error("Failed to copy solution repo:", err);
        }
      }
    }
  }

  return { newAssignmentId: newAssignment.id };
}

/**
 * Copy repo contents from source to target using GitHub API
 */
async function copyRepoContentsViaGitHub(
  sourceRepoFullName: string,
  targetRepoFullName: string
): Promise<void> {
  const [sourceOrg, sourceRepo] = sourceRepoFullName.split("/");
  const [targetOrg, targetRepo] = targetRepoFullName.split("/");

  const sourceOctokit = await getOctoKit(sourceOrg);
  const targetOctokit = await getOctoKit(targetOrg);

  if (!sourceOctokit || !targetOctokit) {
    throw new Error(`GitHub access not available for ${sourceOrg} or ${targetOrg}`);
  }

  // Wait for target repo to be ready
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Get the source repo default branch tree
  let sourceRef;
  try {
    sourceRef = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
      owner: sourceOrg,
      repo: sourceRepo
    });
  } catch {
    // Try 'master' if 'main' doesn't exist
    sourceRef = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/master", {
      owner: sourceOrg,
      repo: sourceRepo
    });
  }

  const sourceCommitSha = sourceRef.data.object.sha;

  // Get the source commit to find the tree
  const sourceCommit = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner: sourceOrg,
    repo: sourceRepo,
    commit_sha: sourceCommitSha
  });

  const sourceTreeSha = sourceCommit.data.tree.sha;

  // Get the full source tree (recursive)
  const sourceTree = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner: sourceOrg,
    repo: sourceRepo,
    tree_sha: sourceTreeSha,
    recursive: "true"
  });

  // Copy each blob from source to target
  const newTreeEntries: any[] = [];

  for (const item of sourceTree.data.tree) {
    if (item.type === "blob" && item.sha) {
      // Get the blob content from source
      const blob = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner: sourceOrg,
        repo: sourceRepo,
        file_sha: item.sha
      });

      // Create the blob in target
      const newBlob = await targetOctokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner: targetOrg,
        repo: targetRepo,
        content: blob.data.content,
        encoding: blob.data.encoding
      });

      newTreeEntries.push({
        path: item.path,
        mode: item.mode,
        type: "blob",
        sha: newBlob.data.sha
      });
    }
  }

  if (newTreeEntries.length === 0) return;

  // Create a new tree in target
  const newTree = await targetOctokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: targetOrg,
    repo: targetRepo,
    tree: newTreeEntries
  });

  // Get the current HEAD of target
  let targetRef;
  try {
    targetRef = await targetOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
      owner: targetOrg,
      repo: targetRepo
    });
  } catch {
    targetRef = await targetOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/master", {
      owner: targetOrg,
      repo: targetRepo
    });
  }

  // Create a new commit
  const newCommit = await targetOctokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: targetOrg,
    repo: targetRepo,
    message: `Copy content from ${sourceRepoFullName}`,
    tree: newTree.data.sha,
    parents: [targetRef.data.object.sha]
  });

  // Update the ref
  const refName = targetRef.url.includes("heads/main") ? "heads/main" : "heads/master";
  await targetOctokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: targetOrg,
    repo: targetRepo,
    ref: refName,
    sha: newCommit.data.sha
  });
}

/**
 * Deep copy a rubric tree
 */
async function copyRubricTree(
  supabase: SupabaseClient<Database>,
  sourceRubricId: number,
  newAssignmentId: number,
  targetClassId: number,
  existingRubricId?: number
): Promise<number> {
  const sourceRubric = await fetchRubricWithHierarchy(supabase, sourceRubricId);
  if (!sourceRubric) throw new CLICommandError(`Rubric not found: ${sourceRubricId}`);

  const checkIdMap = new Map<number, number>();
  let targetRubricId: number;

  if (existingRubricId) {
    // Clear existing rubric content
    await supabase.from("rubric_check_references").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_checks").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_criteria").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_parts").delete().eq("rubric_id", existingRubricId);

    await supabase
      .from("rubrics")
      .update({
        name: sourceRubric.name,
        description: sourceRubric.description,
        cap_score_to_assignment_points: sourceRubric.cap_score_to_assignment_points,
        is_private: sourceRubric.is_private,
        review_round: sourceRubric.review_round
      })
      .eq("id", existingRubricId);

    targetRubricId = existingRubricId;
  } else {
    const { data: newRubric, error } = await supabase
      .from("rubrics")
      .insert({
        assignment_id: newAssignmentId,
        class_id: targetClassId,
        name: sourceRubric.name,
        description: sourceRubric.description,
        cap_score_to_assignment_points: sourceRubric.cap_score_to_assignment_points,
        is_private: sourceRubric.is_private,
        review_round: sourceRubric.review_round
      })
      .select("id")
      .single();

    if (error || !newRubric) throw new CLICommandError(`Failed to create rubric: ${error?.message || "Unknown"}`);
    targetRubricId = newRubric.id;
  }

  // Copy parts, criteria, checks
  for (const part of (sourceRubric as any).rubric_parts || []) {
    const { data: newPart } = await supabase
      .from("rubric_parts")
      .insert({
        assignment_id: newAssignmentId,
        class_id: targetClassId,
        rubric_id: targetRubricId,
        name: part.name,
        description: part.description,
        ordinal: part.ordinal,
        data: part.data
      })
      .select("id")
      .single();

    if (!newPart) continue;

    for (const criteria of part.rubric_criteria || []) {
      const { data: newCriteria } = await supabase
        .from("rubric_criteria")
        .insert({
          assignment_id: newAssignmentId,
          class_id: targetClassId,
          rubric_id: targetRubricId,
          rubric_part_id: newPart.id,
          name: criteria.name,
          description: criteria.description,
          ordinal: criteria.ordinal,
          total_points: criteria.total_points,
          is_additive: criteria.is_additive,
          is_deduction_only: criteria.is_deduction_only,
          min_checks_per_submission: criteria.min_checks_per_submission,
          max_checks_per_submission: criteria.max_checks_per_submission,
          data: criteria.data
        })
        .select("id")
        .single();

      if (!newCriteria) continue;

      for (const check of criteria.rubric_checks || []) {
        const { data: newCheck } = await supabase
          .from("rubric_checks")
          .insert({
            assignment_id: newAssignmentId,
            class_id: targetClassId,
            rubric_id: targetRubricId,
            rubric_criteria_id: newCriteria.id,
            name: check.name,
            description: check.description,
            ordinal: check.ordinal,
            points: check.points,
            is_annotation: check.is_annotation,
            is_comment_required: check.is_comment_required,
            is_required: check.is_required,
            annotation_target: check.annotation_target,
            artifact: check.artifact,
            file: check.file,
            group: check.group,
            max_annotations: check.max_annotations,
            student_visibility: check.student_visibility,
            data: check.data
          })
          .select("id")
          .single();

        if (newCheck) {
          checkIdMap.set(check.id, newCheck.id);
        }
      }
    }
  }

  // Copy rubric_check_references
  const { data: checkReferences } = await supabase
    .from("rubric_check_references")
    .select("*")
    .eq("rubric_id", sourceRubricId);

  if (checkReferences && checkReferences.length > 0) {
    for (const ref of checkReferences) {
      const newReferencedId = checkIdMap.get(ref.referenced_rubric_check_id);
      const newReferencingId = checkIdMap.get(ref.referencing_rubric_check_id);

      if (newReferencedId && newReferencingId) {
        await supabase.from("rubric_check_references").insert({
          assignment_id: newAssignmentId,
          class_id: targetClassId,
          rubric_id: targetRubricId,
          referenced_rubric_check_id: newReferencedId,
          referencing_rubric_check_id: newReferencingId
        });
      }
    }
  }

  return targetRubricId;
}

// ─── Command Router ──────────────────────────────────────────────────────────

const COMMAND_HANDLERS: Record<
  string,
  (ctx: MCPAuthContext, params: Record<string, unknown>) => Promise<CLIResponse>
> = {
  "classes.list": handleClassesList,
  "classes.show": handleClassesShow,
  "assignments.list": handleAssignmentsList,
  "assignments.show": handleAssignmentsShow,
  "assignments.copy": handleAssignmentsCopy,
  "assignments.delete": handleAssignmentsDelete,
  "rubrics.list": handleRubricsList,
  "rubrics.export": handleRubricsExport,
  "rubrics.import": handleRubricsImport,
  "flashcards.list": handleFlashcardsList,
  "flashcards.copy": handleFlashcardsCopy
};

// ─── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    // Authenticate using API token
    const authHeader = req.headers.get("Authorization");
    const authContext = await authenticateMCPRequest(authHeader);

    // Update last used timestamp asynchronously
    updateTokenLastUsed(authContext.tokenId).catch(() => {});

    // Parse request body
    const body: CLIRequest = await req.json();

    if (!body.command || typeof body.command !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'command' field" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const handler = COMMAND_HANDLERS[body.command];
    if (!handler) {
      return new Response(
        JSON.stringify({
          error: `Unknown command: ${body.command}`,
          available_commands: Object.keys(COMMAND_HANDLERS)
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Execute command
    const result = await handler(authContext, body.params || {});

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "cli" }
    });

    if (error instanceof MCPAuthError) {
      const status =
        error.message === "Missing Authorization header" ||
        error.message === "Invalid Authorization header format"
          ? 401
          : error.message.includes("Missing required scope")
            ? 403
            : error.message.includes("revoked")
              ? 401
              : 403;

      return new Response(JSON.stringify({ error: error.message }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (error instanceof CLICommandError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
