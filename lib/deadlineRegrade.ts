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

/** Mark a candidate as "grading" right after its staged grading workflow is triggered. */
export async function regradeSetCandidateGrading(supabase: AnyClient, candidateId: number): Promise<void> {
  const { error } = await supabase.rpc("regrade_set_candidate_grading", {
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
  // The workflow is already dispatched, so leaving the row at staged_status
  // 'none' would offer "Grade" again and dispatch a duplicate. Retry once
  // before surfacing the failure.
  try {
    await regradeSetCandidateGrading(supabase, candidate.id);
  } catch {
    await regradeSetCandidateGrading(supabase, candidate.id);
  }
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
  const { data, error } = await supabase.rpc("apply_deadline_regrade", {
    p_candidate_id: candidateId
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
