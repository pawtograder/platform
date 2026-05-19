import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { AutograderTriggerGradingWorkflowRequest, CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import { GetCommitResponse, getCommit, repoHasFileAtRef, triggerWorkflow } from "../_shared/GitHubWrapper.ts";
import {
  assertUserIsInstructorOrGrader,
  SecurityError,
  UserVisibleError,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

type RepositoryCheckRunRow = Database["public"]["Tables"]["repository_check_runs"]["Row"];

const GRADE_WORKFLOW_PATH = ".github/workflows/grade.yml";

function statusObject(status: unknown): CheckRunStatus {
  return typeof status === "object" && status !== null && !Array.isArray(status) ? (status as CheckRunStatus) : {};
}

async function markCheckRunRequested({
  adminSupabase,
  checkRun,
  triggeredBy,
  requestedAt
}: {
  adminSupabase: SupabaseClient<Database>;
  checkRun: RepositoryCheckRunRow;
  triggeredBy: string;
  requestedAt: string;
}): Promise<RepositoryCheckRunRow> {
  const { data: updated, error: updateError } = await adminSupabase
    .from("repository_check_runs")
    .update({
      triggered_by: triggeredBy,
      status: {
        ...statusObject(checkRun.status),
        requested_at: requestedAt
      }
    })
    .eq("id", checkRun.id)
    .select("*")
    .single();
  if (updateError) {
    throw new SecurityError(`Failed to update repository check run: ${updateError.message}`);
  }
  return updated;
}

async function upsertManualCheckRun({
  adminSupabase,
  repoData,
  commit,
  triggeredBy
}: {
  adminSupabase: SupabaseClient<Database>;
  repoData: Database["public"]["Tables"]["repositories"]["Row"];
  commit: GetCommitResponse["data"];
  triggeredBy: string;
}): Promise<RepositoryCheckRunRow> {
  // `commit.sha` is the canonical full lowercase sha returned by the GitHub API.
  // Always key DB lookups off it so short / mixed-case input from callers does
  // not produce duplicate rows or break race-recovery against the
  // (repository_id, sha) unique constraint.
  const canonicalSha = commit.sha;
  const { data: existing, error: existingError } = await adminSupabase
    .from("repository_check_runs")
    .select("*")
    .eq("repository_id", repoData.id)
    .eq("sha", canonicalSha)
    .maybeSingle();
  if (existingError) {
    throw new SecurityError(`Failed to load repository check run: ${existingError.message}`);
  }
  const now = new Date().toISOString();
  if (existing) {
    return await markCheckRunRequested({ adminSupabase, checkRun: existing, triggeredBy, requestedAt: now });
  }

  const commitDate = commit.commit.author?.date ?? commit.commit.committer?.date ?? null;
  const commitAuthor = commit.commit.author?.name ?? commit.commit.committer?.name ?? null;
  const { data: inserted, error: insertError } = await adminSupabase
    .from("repository_check_runs")
    .insert({
      repository_id: repoData.id,
      check_run_id: null,
      class_id: repoData.class_id,
      assignment_group_id: repoData.assignment_group_id,
      commit_message: commit.commit.message || "No commit message",
      sha: canonicalSha,
      profile_id: repoData.profile_id,
      triggered_by: triggeredBy,
      status: {
        created_at: now,
        commit_author: commitAuthor,
        commit_date: commitDate,
        created_by: `manual trigger by ${triggeredBy}`,
        requested_at: now
      }
    })
    .select("*")
    .single();
  if (!insertError) {
    return inserted;
  }
  if (insertError.code !== "23505") {
    throw new SecurityError(`Failed to create repository check run: ${insertError.message}`);
  }

  const { data: raced, error: racedError } = await adminSupabase
    .from("repository_check_runs")
    .select("*")
    .eq("repository_id", repoData.id)
    .eq("sha", canonicalSha)
    .maybeSingle();
  if (racedError || !raced) {
    throw new SecurityError(
      `Failed to recover raced repository check run insert: ${racedError?.message ?? "not found"}`
    );
  }
  return await markCheckRunRequested({ adminSupabase, checkRun: raced, triggeredBy, requestedAt: now });
}

export async function handleRequest(
  req: Request,
  scope: Sentry.Scope
): Promise<{ message: string; repository_check_run_id: number }> {
  const { repository, sha, class_id } = (await req.json()) as AutograderTriggerGradingWorkflowRequest;
  if (!repository || typeof repository !== "string" || !repository.includes("/")) {
    throw new SecurityError("Invalid repository");
  }
  if (!sha || typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new SecurityError("Invalid sha");
  }
  if (!Number.isFinite(class_id) || class_id <= 0) {
    throw new SecurityError("Invalid class_id");
  }

  scope?.setTag("function", "autograder-trigger-grading-workflow");
  scope?.setTag("repository", repository);
  scope?.setTag("sha", sha);
  scope?.setTag("class_id", class_id.toString());
  const { supabase, enrollment } = await assertUserIsInstructorOrGrader(
    class_id,
    req.headers.get("Authorization") || ""
  );
  const { data: repoData, error: repoError } = await supabase
    .from("repositories")
    .select("*")
    .eq("repository", repository)
    .eq("class_id", class_id)
    .maybeSingle();
  if (repoError) {
    throw new SecurityError(`Failed to load repository ${repository}: ${repoError.message}`);
  }
  if (!repoData) {
    throw new SecurityError(`User does not have access to repository ${repository}`);
  }
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  // Resolve any abbreviated / mixed-case sha to the canonical full lowercase
  // sha before touching the DB so SELECT/INSERT/race-recovery all key off the
  // same value as the (repository_id, sha) unique constraint.
  const commit = await getCommit(repository, sha, scope);
  scope?.setTag("resolved_sha", commit.sha);

  // workflow_dispatch will 422 with an unhelpful "Workflow does not have
  // 'workflow_dispatch' trigger" message if the workflow file does not exist
  // at the target commit. Preflight so we can surface a user-friendly error
  // and avoid leaving the row half-updated.
  const workflowExists = await repoHasFileAtRef(repository, GRADE_WORKFLOW_PATH, commit.sha, scope);
  if (!workflowExists) {
    throw new UserVisibleError(
      `Commit ${commit.sha.slice(0, 7)} does not contain ${GRADE_WORKFLOW_PATH}; cannot trigger grading workflow.`
    );
  }

  const checkRun = await upsertManualCheckRun({
    adminSupabase,
    repoData,
    commit,
    triggeredBy: enrollment.private_profile_id
  });

  await triggerWorkflow(repository, commit.sha, "grade.yml", scope);

  const triggeredAt = new Date().toISOString();
  const { data: latestCheckRun, error: latestCheckRunError } = await adminSupabase
    .from("repository_check_runs")
    .select("status")
    .eq("id", checkRun.id)
    .single();
  if (latestCheckRunError) {
    throw new SecurityError(`Failed to load workflow trigger status: ${latestCheckRunError.message}`);
  }
  const latestStatus = statusObject(latestCheckRun.status);
  const { error: triggerStatusUpdateError } = await adminSupabase
    .from("repository_check_runs")
    .update({
      triggered_by: enrollment.private_profile_id,
      status: {
        ...latestStatus,
        requested_at: latestStatus.requested_at ?? triggeredAt,
        workflow_triggered_at: triggeredAt
      }
    })
    .eq("id", checkRun.id);
  if (triggerStatusUpdateError) {
    throw new SecurityError(`Failed to update workflow trigger status: ${triggerStatusUpdateError.message}`);
  }

  return { message: "Workflow triggered", repository_check_run_id: checkRun.id };
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
