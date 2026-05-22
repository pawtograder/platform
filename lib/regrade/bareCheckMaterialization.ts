import type { RubricCheck, SubmissionRegradeRequest } from "@/utils/supabase/DatabaseTypes";

export type BareCheckMaterializationKind = "submission" | "file" | "artifact";

export function isBareCheckRegradeRequest(request: SubmissionRegradeRequest): boolean {
  return (
    request.rubric_check_id != null &&
    request.submission_file_comment_id == null &&
    request.submission_comment_id == null &&
    request.submission_artifact_comment_id == null
  );
}

/** Determines which comment table a bare-check regrade resolution should write to. */
export function getBareCheckMaterializationKind(check: RubricCheck | null | undefined): BareCheckMaterializationKind {
  if (!check?.is_annotation) {
    return "submission";
  }
  const target = check.annotation_target ?? "file";
  if (target === "artifact") {
    return "artifact";
  }
  return "file";
}

export type BareCheckResolveLocation = {
  submissionFileId?: number;
  line?: number;
  submissionArtifactId?: number;
};

export function isBareCheckResolveLocationValid(
  kind: BareCheckMaterializationKind,
  location: BareCheckResolveLocation
): boolean {
  if (kind === "file") {
    return location.submissionFileId != null && location.line != null && location.line >= 1;
  }
  if (kind === "artifact") {
    return location.submissionArtifactId != null;
  }
  return true;
}

export function buildBareCheckRpcLocationArgs(
  kind: BareCheckMaterializationKind,
  location: BareCheckResolveLocation
): {
  p_submission_file_id?: number;
  p_line?: number;
  p_submission_artifact_id?: number;
} {
  if (kind === "file") {
    return {
      p_submission_file_id: location.submissionFileId,
      p_line: location.line
    };
  }
  if (kind === "artifact") {
    return {
      p_submission_artifact_id: location.submissionArtifactId
    };
  }
  return {};
}
