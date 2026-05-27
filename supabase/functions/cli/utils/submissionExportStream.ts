/**
 * Shared submission metadata streaming for assessment and submissions export.
 */

import { CLICommandError } from "../errors.ts";
import { getAdminClient } from "./supabase.ts";
import type { IdentityMode, Tokenizer } from "./tokenization.ts";

const FACT_PAGE_SIZE = 1000;

export interface StreamSubmissionsOptions {
  /** When true, include ordinal in each emitted submission record. */
  includeOrdinal?: boolean;
}

/**
 * Page through submissions for the assignment and emit one record per row.
 * By default only is_active submissions are exported (the final attempt per
 * student/group). Pass allSubmissions=true to include every attempt.
 */
export async function streamSubmissions(
  supabase: ReturnType<typeof getAdminClient>,
  assignmentId: number,
  allSubmissions: boolean,
  mode: IdentityMode,
  tokenizer: Tokenizer | null,
  writer: { write: (record: Record<string, unknown>) => Promise<void> },
  options: StreamSubmissionsOptions = {}
): Promise<{ submissionCount: number; submissionIds: number[]; activeSubmissionIds: number[] }> {
  const includeOrdinal = options.includeOrdinal === true;
  const selectFields = includeOrdinal
    ? "id, profile_id, assignment_group_id, sha, run_number, run_attempt, created_at, grading_review_id, repository, is_active, ordinal"
    : "id, profile_id, assignment_group_id, sha, run_number, run_attempt, created_at, grading_review_id, repository, is_active";

  let cursor = 0;
  let total = 0;
  const ids: number[] = [];
  const activeIds: number[] = [];

  while (true) {
    let query = supabase
      .from("submissions")
      .select(selectFields)
      .eq("assignment_id", assignmentId)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(FACT_PAGE_SIZE);
    if (!allSubmissions) query = query.eq("is_active", true);

    const { data: rows, error } = await query;
    if (error) throw new CLICommandError(`Failed to load submissions: ${error.message}`, 500);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const submissionRef =
        tokenizer === null ? { id: row.id } : { token: await tokenizer.token("submission", row.id) };

      const subjectRef =
        row.profile_id === null
          ? null
          : tokenizer === null
            ? { id: row.profile_id }
            : { token: await tokenizer.token("subject", row.profile_id) };

      const groupRef =
        row.assignment_group_id === null
          ? null
          : tokenizer === null
            ? { id: row.assignment_group_id }
            : { token: await tokenizer.token("group", row.assignment_group_id) };

      const record: Record<string, unknown> = {
        kind: "submission",
        ...submissionRef,
        subject: subjectRef,
        group: groupRef,
        sha: row.sha,
        run_number: row.run_number,
        run_attempt: row.run_attempt,
        created_at: row.created_at,
        is_active: row.is_active,
        has_final_review: row.grading_review_id !== null,
        // Repository url is course design metadata, not student PII — same
        // posture as autograder.grader_repo above.
        repository: row.repository
      };
      if (includeOrdinal) {
        record.ordinal = row.ordinal;
      }

      await writer.write(record);
      ids.push(row.id);
      if (row.is_active) activeIds.push(row.id);
      total += 1;
    }

    if (rows.length < FACT_PAGE_SIZE) break;
    cursor = rows[rows.length - 1]!.id;
  }
  return { submissionCount: total, submissionIds: ids, activeSubmissionIds: activeIds };
}
