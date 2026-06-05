/**
 * Confirms which candidate pull request is "the" submission PR for a pr-mode
 * assignment, then ingests that PR's current state as a submission.
 *
 * Used when pr_identification is `manual`, or when `base_branch`/
 * `branch_convention` matched several candidate PRs and the student must pick
 * one. The webhook records candidates as unconfirmed `submission_pr_links`; this
 * function flips the chosen one to confirmed (a DB trigger unconfirms the
 * siblings), reads the PR head/base straight from GitHub, and calls
 * `ingest_pr_submission` so the confirmed PR immediately produces a submission.
 *
 * Request:  { link_id: number }
 * Response: { submission_id: number | null }
 *
 * Authorization: caller must be the link's owner (the student, or a member of
 * the owning group) or an instructor/grader in the link's class.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getPullRequest } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInCourse, SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

type RequestBody = { link_id: number };

export type PrLinkConfirmResponse = { submission_id: number | null };

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<PrLinkConfirmResponse> {
  const { link_id }: RequestBody = await req.json();
  scope?.setTag("function", "pr-link-confirm");
  if (!link_id) {
    throw new UserVisibleError("link_id is required");
  }
  scope?.setTag("link_id", String(link_id));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: link } = await adminSupabase
    .from("submission_pr_links")
    .select("id, class_id, assignment_id, profile_id, assignment_group_id, pr_repo, pr_number")
    .eq("id", link_id)
    .maybeSingle();
  if (!link) {
    throw new UserVisibleError("Pull request link not found");
  }

  // Authorize: staff in the class, or the owning student/group member.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  const { enrollment } = await assertUserIsInCourse(link.class_id, authHeader);
  const isStaff = enrollment.role === "instructor" || enrollment.role === "grader";
  let isOwner = false;
  if (!isStaff) {
    if (link.profile_id) {
      isOwner = enrollment.private_profile_id === link.profile_id;
    } else if (link.assignment_group_id) {
      const { data: membership } = await adminSupabase
        .from("assignment_groups_members")
        .select("id")
        .eq("assignment_group_id", link.assignment_group_id)
        .eq("profile_id", enrollment.private_profile_id)
        .maybeSingle();
      isOwner = !!membership;
    }
    if (!isOwner) {
      throw new SecurityError("You can only confirm your own pull request");
    }
  }

  // Mark this link confirmed; the single-confirmed trigger unconfirms siblings.
  const { error: confirmError } = await adminSupabase
    .from("submission_pr_links")
    .update({ confirmed: true })
    .eq("id", link.id);
  if (confirmError) {
    throw new UserVisibleError(`Could not confirm pull request: ${confirmError.message}`);
  }

  // Read the PR's current head/base straight from GitHub (the webhook payload
  // that created the candidate may be stale by now).
  const pr = await getPullRequest(link.pr_repo, link.pr_number, scope);
  const prState = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";

  const { data: submissionId, error: ingestError } = await adminSupabase.rpc("ingest_pr_submission", {
    p_assignment_id: link.assignment_id,
    p_profile_id: link.profile_id ?? undefined,
    p_assignment_group_id: link.assignment_group_id ?? undefined,
    p_pr_repo: link.pr_repo,
    p_pr_number: link.pr_number,
    p_base_sha: pr.base.sha,
    p_head_sha: pr.head.sha,
    p_pr_state: prState,
    // Already confirmed above; don't let auto-confirm logic second-guess it.
    p_auto_confirm: false
  });
  if (ingestError) {
    throw new UserVisibleError(`Could not ingest pull request submission: ${ingestError.message}`);
  }

  return { submission_id: (submissionId as number | null) ?? null };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
