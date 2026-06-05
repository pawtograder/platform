import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { triggerWorkflow } from "./edgeFunctions";

// NOTE: The deadline-regrade tables and RPCs are introduced in migration
// 20260604120000_regrade-late-commits-after-extension.sql. Until `npm run
// client-local` regenerates utils/supabase/SupabaseTypes.d.ts, these names are
// not in the generated `Database` type, so the rpc()/from() calls below are
// cast. Once types are regenerated the `as never` / local interfaces can be
// dropped in favor of generated types.

export type RegradeBatchStatus = "open" | "applied" | "dismissed" | "superseded";
export type RegradeStagedStatus = "none" | "grading" | "graded" | "error";
export type RegradeDecision = "pending" | "applied" | "skipped";

export interface DeadlineRegradeBatch {
  id: number;
  created_at: string;
  updated_at: string;
  class_id: number;
  assignment_id: number;
  created_by: string | null;
  old_due_date: string;
  new_due_date: string;
  status: RegradeBatchStatus;
}

export interface DeadlineRegradeCandidate {
  id: number;
  created_at: string;
  updated_at: string;
  batch_id: number;
  class_id: number;
  assignment_id: number;
  profile_id: string | null;
  assignment_group_id: number | null;
  repository_id: number;
  repository: string;
  sha: string;
  commit_message: string | null;
  commit_date: string | null;
  current_submission_id: number | null;
  current_score: number | null;
  staged_submission_id: number | null;
  staged_score: number | null;
  staged_status: RegradeStagedStatus;
  staged_triggered_at: string | null;
  decision: RegradeDecision;
}

type AnyClient = SupabaseClient<Database>;
// Helper to access the not-yet-typed rpc/from surface for the new tables/RPCs.
// Once `npm run client-local` regenerates the Database type these casts can go away.
type UntypedQuery = {
  select: (cols: string) => UntypedQuery;
  eq: (col: string, val: unknown) => UntypedQuery;
  order: (col: string, opts: { ascending: boolean }) => UntypedQuery;
  limit: (n: number) => UntypedQuery;
  maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
  then: Promise<{ data: unknown; error: { message: string } | null }>["then"];
};
type UntypedClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  from: (table: string) => UntypedQuery;
};

function untyped(supabase: AnyClient): UntypedClient {
  return supabase as unknown as UntypedClient;
}

/**
 * Enumerate the students/groups whose latest push fell in the window between the
 * old and new (effective) deadlines. Creates a batch and its candidate rows and
 * returns the new batch id.
 */
export async function enumerateDeadlineRegradeCandidates(
  supabase: AnyClient,
  params: { assignment_id: number; old_due_date: string }
): Promise<number> {
  const { data, error } = await untyped(supabase).rpc("enumerate_deadline_regrade_candidates", {
    p_assignment_id: params.assignment_id,
    p_old_due_date: params.old_due_date
  });
  if (error) {
    throw new Error(error.message);
  }
  return data as number;
}

/** Mark a candidate as "grading" right after its staged grading workflow is triggered. */
export async function regradeSetCandidateGrading(supabase: AnyClient, candidateId: number): Promise<void> {
  const { error } = await untyped(supabase).rpc("regrade_set_candidate_grading", {
    p_candidate_id: candidateId
  });
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Trigger staged grading for a candidate commit: dispatch the grading workflow
 * with stage_only=true (so the resulting submission is graded but not active),
 * then mark the candidate as grading.
 */
export async function stageCandidate(
  supabase: AnyClient,
  candidate: Pick<DeadlineRegradeCandidate, "id" | "repository" | "sha" | "class_id">
): Promise<void> {
  await triggerWorkflow(
    {
      repository: candidate.repository,
      sha: candidate.sha,
      class_id: candidate.class_id,
      stage_only: true
    },
    supabase
  );
  await regradeSetCandidateGrading(supabase, candidate.id);
}

/** Promote a candidate's staged submission to active and notify the student(s). */
export async function applyDeadlineRegrade(
  supabase: AnyClient,
  candidateId: number
): Promise<{
  status: string;
  old_submission_id?: number;
  new_submission_id?: number;
  old_score?: number;
  new_score?: number;
}> {
  const { data, error } = await untyped(supabase).rpc("apply_deadline_regrade", {
    p_candidate_id: candidateId
  });
  if (error) {
    throw new Error(error.message);
  }
  return data as { status: string };
}

/** Mark a candidate as skipped (instructor chose not to promote it). */
export async function skipDeadlineRegrade(supabase: AnyClient, candidateId: number): Promise<void> {
  const { error } = await untyped(supabase).rpc("skip_deadline_regrade", {
    p_candidate_id: candidateId
  });
  if (error) {
    throw new Error(error.message);
  }
}

/** Close a batch (dismissed by default, or "applied" when the instructor finishes). */
export async function dismissDeadlineRegradeBatch(
  supabase: AnyClient,
  batchId: number,
  status: "dismissed" | "applied" = "dismissed"
): Promise<void> {
  const { error } = await untyped(supabase).rpc("dismiss_deadline_regrade_batch", {
    p_batch_id: batchId,
    p_status: status
  });
  if (error) {
    throw new Error(error.message);
  }
}

/** Fetch the candidate rows for a batch, ordered by student name-ish (commit date desc). */
export async function fetchRegradeCandidates(
  supabase: AnyClient,
  batchId: number
): Promise<DeadlineRegradeCandidate[]> {
  const { data, error } = await untyped(supabase)
    .from("deadline_regrade_candidates")
    .select("*")
    .eq("batch_id", batchId)
    .order("id", { ascending: true });
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as unknown as DeadlineRegradeCandidate[];
}

/** Fetch a single batch by id. */
export async function fetchRegradeBatchById(
  supabase: AnyClient,
  batchId: number
): Promise<DeadlineRegradeBatch | null> {
  const { data, error } = await untyped(supabase)
    .from("deadline_regrade_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? null) as unknown as DeadlineRegradeBatch | null;
}

/** Fetch the most recent open batch for an assignment, if any (for the dashboard banner). */
export async function fetchOpenRegradeBatch(
  supabase: AnyClient,
  assignmentId: number
): Promise<DeadlineRegradeBatch | null> {
  const { data, error } = await untyped(supabase)
    .from("deadline_regrade_batches")
    .select("*")
    .eq("assignment_id", assignmentId)
    .eq("status", "open")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? null) as unknown as DeadlineRegradeBatch | null;
}
