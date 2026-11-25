import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { type ForgejoConfig, getCommit } from "./ForgejoWrapper.ts";
import { ilikeLiteral, isDefaultBranchPush, type RepoPush } from "./RepoPush.ts";
import { Database } from "./SupabaseTypes.d.ts";

type HandoutAssignment = { id: number; class_id: number };
type HandoutCommit = { sha: string; message: string; author: string };

/**
 * Writes rows to assignment_handout_commits, which the Repository Status page lists as the handout's commit
 * history. The rows and the error handling are the ones github-repo-webhook's handlePushToTemplateRepo uses: a
 * constraint violation fails the same way on every redelivery, so it is reported and skipped, and anything
 * else throws so the delivery can be retried.
 */
export async function recordHandoutCommits(
  adminSupabase: SupabaseClient<Database>,
  assignments: HandoutAssignment[],
  commits: HandoutCommit[],
  scope: Sentry.Scope
): Promise<void> {
  if (commits.length === 0) return;
  for (const assignment of assignments) {
    const { error } = await adminSupabase.from("assignment_handout_commits").upsert(
      commits.map((commit) => ({
        assignment_id: assignment.id,
        message: commit.message,
        sha: commit.sha,
        author: commit.author,
        class_id: assignment.class_id
      })),
      { onConflict: "assignment_id,sha" }
    );
    if (error) {
      scope.setTag("error_source", "assignment_handout_commits_insert_failed");
      scope.setTag("error_context", "Failed to store assignment handout commit");
      console.error(`Failed to store handout commits for assignment ${assignment.id}`, error);
      Sentry.captureException(error, scope);
      if (!error.code?.startsWith("23")) throw error;
    }
  }
}

/**
 * Records a push to a Forgejo handout in the history of every Forgejo assignment that uses it. Returns false
 * when the repository is no Forgejo assignment's handout, so the caller can tell a handout push from an
 * unknown repository. Unlike the GitHub path, it doesn't move latest_template_sha: on Forgejo that pointer
 * is only written at handout creation.
 */
export async function recordForgejoHandoutPush(
  adminSupabase: SupabaseClient<Database>,
  push: RepoPush,
  scope: Sentry.Scope
): Promise<boolean> {
  // Matched ignoring case, like student repositories: a push carries the name's current casing.
  const { data: assignments, error } = await adminSupabase
    .from("assignments")
    .select("id, class_id")
    .eq("git_provider", "forgejo")
    .ilike("template_repo", ilikeLiteral(push.repository));
  if (error) {
    scope.setTag("error_source", "template_repo_lookup_failed");
    scope.setTag("error_context", "Error getting template repo");
    Sentry.captureException(error, scope);
    throw error;
  }
  if (assignments.length === 0) return false;
  scope.setTag("repo_type", "handout");
  scope.setTag("assignments_count", assignments.length.toString());
  if (!isDefaultBranchPush(push, scope)) return true;
  // As for student repos, head_commit stands in when Forgejo's payload lists no commits.
  const commits = push.commits.length > 0 ? push.commits : push.headCommit ? [push.headCommit] : [];
  await recordHandoutCommits(
    adminSupabase,
    assignments,
    commits.map((commit) => ({ sha: commit.id, message: commit.message, author: commit.author.name })),
    scope
  );
  return true;
}

/**
 * Records the handout's head commit when assignment-create-handout-repo sets it up. Its commits are made
 * before template_repo is saved, so their push deliveries find no assignment and record nothing. Best-effort:
 * the history is not worth failing creation over, and the next push to the handout records again.
 */
export async function recordInitialHandoutCommit(
  adminSupabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  assignment: HandoutAssignment,
  repository: string,
  sha: string,
  scope: Sentry.Scope
): Promise<void> {
  try {
    const { sha: fullSha, commit } = await getCommit(config, repository, sha);
    await recordHandoutCommits(
      adminSupabase,
      [assignment],
      // Forgejo keeps the newline git ends a message with; GitHub's payload doesn't have it.
      [{ sha: fullSha, message: commit.message.replace(/\n+$/, ""), author: commit.author?.name ?? "" }],
      scope
    );
  } catch (err) {
    scope.setTag("handout_commit_record_failed", "true");
    console.error(`Failed to record the initial handout commit of ${repository}`, err);
    Sentry.captureException(err, scope);
  }
}
