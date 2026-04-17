/** Mirrors Edge `assignments.copy` repo payload (keep in sync with supabase/functions/cli/types.ts). */

export interface RepoCopyPair {
  kind: "handout" | "solution";
  source_repo: string;
  target_repo: string;
  assignment_id: number;
  assignment_slug: string | null;
}
