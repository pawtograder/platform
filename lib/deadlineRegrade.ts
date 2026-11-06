import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { triggerWorkflow } from "./edgeFunctions";

export type RegradeBatchStatus = "open" | "applied" | "dismissed" | "superseded";
export type RegradeStagedStatus = "none" | "grading" | "graded" | "error";
export type RegradeDecision = "pending" | "applied" | "skipped";

// The status columns are `text` with CHECK constraints in the migration, so the
// generated types widen them to `string`; narrow them back to the allowed values.
export type DeadlineRegradeBatch = Omit<Database["public"]["Tables"]["deadline_regrade_batches"]["Row"], "status"> & {
  status: RegradeBatchStatus;
};

export type DeadlineRegradeCandidate = Omit<
  Database["public"]["Tables"]["deadline_regrade_candidates"]["Row"],
  "staged_status" | "decision"
> & {
  staged_status: RegradeStagedStatus;
  decision: RegradeDecision;
};

type AnyClient = SupabaseClient<Database>;

/**
 * Enumerate the students/groups whose latest push fell in the window between the
 * old and new (effective) deadlines. Creates a batch and its candidate rows and
 * returns the new batch id.
 */
export async function enumerateDeadlineRegradeCandidates(
  supabase: AnyClient,
  params: {
    assignment_id: number;
    old_due_date: string;
    /** minutes_due_after_lab before the save; null when it was not lab-scheduled. */
    old_minutes_due_after_lab: number | null;
  }
): Promise<number> {
  const { data, error } = await supabase.rpc("enumerate_deadline_regrade_candidates", {
    p_assignment_id: params.assignment_id,
    p_old_due_date: params.old_due_date,
    // The generated Args type marks every parameter non-null; SQL NULL means "not lab-scheduled".
    p_old_minutes_due_after_lab: params.old_minutes_due_after_lab as number
  });
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

/**
 * Trigger staged grading for a candidate commit: dispatch the grading workflow
 * with stage_only=true. The edge function reserves a preview slot on the
 * candidate (marking it grading) before dispatching, so the resulting
 * submission is graded but not active.
 */
export async function stageCandidate(
  supabase: AnyClient,
  candidate: Pick<DeadlineRegradeCandidate, "repository" | "sha" | "class_id">
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
}

/**
 * Promote a candidate's staged submission to active and notify the student(s).
 * Compare-and-swap: the candidate's current/staged values are what the page
 * showed; if either submission changed since, nothing is promoted and the
 * result is `active_changed` with the fresh numbers.
 */
export async function applyDeadlineRegrade(
  supabase: AnyClient,
  candidate: Pick<DeadlineRegradeCandidate, "id" | "current_submission_id" | "current_score" | "staged_score">
): Promise<{
  status: string;
  old_submission_id?: number;
  new_submission_id?: number;
  old_score?: number;
  new_score?: number;
}> {
  const { data, error } = await supabase.rpc("apply_deadline_regrade", {
    p_candidate_id: candidate.id,
    // The generated Args type marks every parameter non-null; SQL NULL is a valid expectation here.
    p_expected_current_submission_id: candidate.current_submission_id as number,
    p_expected_current_score: candidate.current_score as number,
    p_expected_staged_score: candidate.staged_score as number
  });
  if (error) {
    throw new Error(error.message);
  }
  return data as unknown as {
    status: string;
    old_submission_id?: number;
    new_submission_id?: number;
    old_score?: number;
    new_score?: number;
  };
}

/** Mark a candidate as skipped (instructor chose not to promote it). */
export async function skipDeadlineRegrade(supabase: AnyClient, candidateId: number): Promise<void> {
  const { error } = await supabase.rpc("skip_deadline_regrade", {
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
  const { error } = await supabase.rpc("dismiss_deadline_regrade_batch", {
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
  const { data, error } = await supabase
    .from("deadline_regrade_candidates")
    .select("*")
    .eq("batch_id", batchId)
    .order("id", { ascending: true });
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as DeadlineRegradeCandidate[];
}

/** Fetch a single batch by id. */
export async function fetchRegradeBatchById(
  supabase: AnyClient,
  batchId: number
): Promise<DeadlineRegradeBatch | null> {
  const { data, error } = await supabase.from("deadline_regrade_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? null) as DeadlineRegradeBatch | null;
}

/** Fetch the most recent open batch for an assignment, if any (for the dashboard banner). */
export async function fetchOpenRegradeBatch(
  supabase: AnyClient,
  assignmentId: number
): Promise<DeadlineRegradeBatch | null> {
  const { data, error } = await supabase
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
  return (data ?? null) as DeadlineRegradeBatch | null;
}
