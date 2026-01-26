/**
 * Database utilities for the Pawtograder CLI
 *
 * Provides a singleton Supabase client and helper functions for resolving
 * classes and assignments by ID, slug, or name.
 */

import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Class, Assignment, RubricWithHierarchy, SelfReviewSettings, Autograder } from "../types";
import { CLIError } from "./logger";

// Singleton client
let _client: ReturnType<typeof createAdminClient<Database>> | null = null;

/**
 * Get the Supabase admin client (singleton)
 */
export function getSupabaseClient() {
  if (!_client) {
    _client = createAdminClient<Database>();
  }
  return _client;
}

/**
 * Resolve a class by ID, slug, or name
 */
export async function resolveClass(identifier: string | number): Promise<Class> {
  const supabase = getSupabaseClient();

  // Try by ID first if it's a number
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data, error } = await supabase.from("classes").select("*").eq("id", Number(identifier)).single();

    if (error && error.code !== "PGRST116") {
      throw new CLIError(`Database error: ${error.message}`);
    }
    if (data) return data;
  }

  // Try by slug
  const { data: bySlug, error: slugError } = await supabase
    .from("classes")
    .select("*")
    .eq("slug", String(identifier))
    .single();

  if (slugError && slugError.code !== "PGRST116") {
    throw new CLIError(`Database error: ${slugError.message}`);
  }
  if (bySlug) return bySlug;

  // Try by name (partial match)
  const { data: byName, error: nameError } = await supabase
    .from("classes")
    .select("*")
    .ilike("name", `%${String(identifier)}%`)
    .limit(1)
    .single();

  if (nameError && nameError.code !== "PGRST116") {
    throw new CLIError(`Database error: ${nameError.message}`);
  }
  if (byName) return byName;

  throw new CLIError(`Class not found: ${identifier}`);
}

/**
 * Resolve an assignment by ID or slug within a class
 */
export async function resolveAssignment(classId: number, identifier: string | number): Promise<Assignment> {
  const supabase = getSupabaseClient();

  // Try by ID first if it's a number
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    const { data, error } = await supabase
      .from("assignments")
      .select("*")
      .eq("id", Number(identifier))
      .eq("class_id", classId)
      .single();

    if (error && error.code !== "PGRST116") {
      throw new CLIError(`Database error: ${error.message}`);
    }
    if (data) return data;
  }

  // Try by slug
  const { data: bySlug, error: slugError } = await supabase
    .from("assignments")
    .select("*")
    .eq("slug", String(identifier))
    .eq("class_id", classId)
    .single();

  if (slugError && slugError.code !== "PGRST116") {
    throw new CLIError(`Database error: ${slugError.message}`);
  }
  if (bySlug) return bySlug;

  throw new CLIError(`Assignment not found: ${identifier} in class ${classId}`);
}

/**
 * Fetch all assignments for a class
 */
export async function fetchAssignmentsForClass(classId: number): Promise<Assignment[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("class_id", classId)
    .order("release_date", { ascending: true });

  if (error) {
    throw new CLIError(`Failed to fetch assignments: ${error.message}`);
  }

  return data || [];
}

/**
 * Fetch a rubric with its full hierarchy (parts, criteria, checks)
 */
export async function fetchRubricWithHierarchy(rubricId: number): Promise<RubricWithHierarchy | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("rubrics")
    .select(
      `
      *,
      rubric_parts (
        *,
        rubric_criteria (
          *,
          rubric_checks (*)
        )
      )
    `
    )
    .eq("id", rubricId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new CLIError(`Failed to fetch rubric: ${error.message}`);
  }

  return data as RubricWithHierarchy;
}

/**
 * Fetch self-review settings for an assignment
 */
export async function fetchSelfReviewSettings(settingsId: number): Promise<SelfReviewSettings | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("assignment_self_review_settings")
    .select("*")
    .eq("id", settingsId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new CLIError(`Failed to fetch self-review settings: ${error.message}`);
  }

  return data;
}

/**
 * Fetch autograder config for an assignment
 */
export async function fetchAutograderConfig(assignmentId: number): Promise<Autograder | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from("autograder").select("*").eq("id", assignmentId).single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new CLIError(`Failed to fetch autograder config: ${error.message}`);
  }

  return data;
}

/**
 * List all classes
 */
export async function listClasses(): Promise<Class[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from("classes").select("*").order("created_at", { ascending: false });

  if (error) {
    throw new CLIError(`Failed to list classes: ${error.message}`);
  }

  return data || [];
}
