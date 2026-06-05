/**
 * PR-mode submission file ingestion.
 *
 * For pr-mode assignments there is no autograder workflow that packages the
 * student's code, so ptg fetches it itself: given a PR head fork repo + head
 * sha, download the zipball (via cloneRepository, which resolves the ptg GitHub
 * App installation for the *fork's own org* — the cross-org case), and write the
 * files into `submission_files` exactly like autograder-create-submission does
 * (text inline, binary→storage at the submission-scoped key that
 * can_access_submission_storage_path authorizes). Without this a pr-mode
 * submission has no files and there is nothing for a grader to view or diff.
 *
 * Unlike the autograder path this does NOT gate on a pawtograder.yml
 * `submissionFiles` pattern set (pr-mode assignments have no autograder config):
 * the whole head tree is ingested (no fileFilter). The diff base is the
 * snapshotted base_sha on the submission row.
 *
 * The mechanical file writing/clone/guards live in the shared
 * `SubmissionIngestion.ts` core (one writer for autograder + pr + push-direct);
 * this module keeps only the pr-mode-specific bits: the idempotency guard and
 * the E2E_MOCK_GITHUB canned-file fast path.
 *
 * Idempotent: if the submission already has files (webhook re-delivery, or
 * ingest_pr_submission returned an existing version), this is a no-op.
 */
import * as Sentry from "npm:@sentry/deno";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { END_TO_END_REPO_PREFIX } from "./GitHubWrapper.ts";
import { ingestSubmissionFilesFromRepo } from "./SubmissionIngestion.ts";
import type { Database } from "./SupabaseTypes.d.ts";

export type IngestPrFilesParams = {
  adminSupabase: SupabaseClient<Database>;
  submissionId: number;
  classId: number;
  profileId: string | null;
  groupId: number | null;
  headRepo: string; // the PR head fork, "owner/name"
  headSha: string;
  scope?: Sentry.Scope;
};

/**
 * Download the PR head fork at headSha and write its files to submission_files
 * for `submissionId`. No-op if the submission already has files.
 */
export async function ingestPrSubmissionFiles(params: IngestPrFilesParams): Promise<void> {
  const { adminSupabase, submissionId, classId, profileId, groupId, headRepo, headSha, scope } = params;

  // Idempotency: a submission version maps to a single head sha; if its files
  // are already present (re-delivery, or an existing version was returned),
  // don't fetch or write again.
  const { count: existingFiles } = await adminSupabase
    .from("submission_files")
    .select("id", { count: "exact", head: true })
    .eq("submission_id", submissionId);
  if ((existingFiles ?? 0) > 0) {
    return;
  }

  // E2E fast path: under E2E_MOCK_GITHUB the head repo isn't a real GitHub repo,
  // so bypass the fetch and write a single canned file (parallels the
  // autograder-create-submission E2E mock) so the flow is end-to-end testable.
  const e2eMock = Deno.env.get("E2E_MOCK_GITHUB") === "true" && headRepo.startsWith(END_TO_END_REPO_PREFIX);
  if (e2eMock) {
    const mockContents = `// PR submission mock for ${headRepo}@${headSha}\n`;
    const { error } = await adminSupabase.from("submission_files").insert({
      submission_id: submissionId,
      name: "Main.java",
      profile_id: profileId,
      assignment_group_id: groupId,
      contents: mockContents,
      class_id: classId,
      is_binary: false,
      file_size: mockContents.length
    });
    if (error) {
      Sentry.captureException(error, scope);
      throw error;
    }
    return;
  }

  // Ingest the whole head tree (no fileFilter; pr-mode has no submissionFiles
  // glob set). No empty-submission detection for pr-mode.
  await ingestSubmissionFilesFromRepo({
    adminSupabase,
    submissionId,
    classId,
    profileId,
    groupId,
    repo: headRepo,
    sha: headSha,
    scope
  });
}
