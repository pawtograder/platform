import { useRubricCheck } from "@/hooks/useAssignment";
import { useSubmissionArtifactComment, useSubmissionComment, useSubmissionFileComment } from "@/hooks/useSubmission";
import type { RegradeRequest } from "@/utils/supabase/DatabaseTypes";

/** Returns the backing grading comment for a regrade request, including soft-deleted rows. */
export function useRegradeRequestBackingComment(request: RegradeRequest) {
  const fileComment = useSubmissionFileComment(request.submission_file_comment_id);
  const submissionComment = useSubmissionComment(request.submission_comment_id);
  const artifactComment = useSubmissionArtifactComment(request.submission_artifact_comment_id);
  return fileComment ?? submissionComment ?? artifactComment;
}

/**
 * True when the request no longer has a live rubric-sidebar anchor (the backing
 * comment was soft-deleted or is otherwise unavailable). These requests must render
 * their full thread in SubmissionRegradeRequestsPanel instead.
 */
export function useIsOrphanedRegradeRequest(request: RegradeRequest): boolean {
  const backingComment = useRegradeRequestBackingComment(request);

  if (request.resolution_reason === "comment_deleted") {
    return true;
  }

  const hasCommentRef =
    request.submission_file_comment_id != null ||
    request.submission_comment_id != null ||
    request.submission_artifact_comment_id != null;

  if (!hasCommentRef) {
    return false;
  }

  return !backingComment || backingComment.deleted_at != null;
}

export function useRegradeRequestCheckName(request: RegradeRequest): string {
  const backingComment = useRegradeRequestBackingComment(request);
  const checkId = request.rubric_check_id ?? backingComment?.rubric_check_id ?? null;
  const rubricCheck = useRubricCheck(checkId);
  return rubricCheck?.name ?? "General";
}
