import {
  getBareCheckMaterializationKind,
  isBareCheckResolveLocationValid,
  isBareCheckRegradeRequest
} from "@/lib/regrade/bareCheckMaterialization";
import type { RubricCheck, SubmissionRegradeRequest } from "@/utils/supabase/DatabaseTypes";

function makeRequest(overrides: Partial<SubmissionRegradeRequest> = {}): SubmissionRegradeRequest {
  return {
    id: 1,
    assignee: "a",
    assignment_id: 1,
    class_id: 1,
    created_at: "",
    created_by: "b",
    last_updated_at: "",
    status: "opened",
    submission_id: 1,
    updated_at: "",
    rubric_check_id: 10,
    submission_review_id: 20,
    submission_comment_id: null,
    submission_file_comment_id: null,
    submission_artifact_comment_id: null,
    ...overrides
  } as SubmissionRegradeRequest;
}

function makeCheck(overrides: Partial<RubricCheck> = {}): RubricCheck {
  return {
    id: 10,
    is_annotation: false,
    annotation_target: null,
    ...overrides
  } as RubricCheck;
}

describe("bareCheckMaterialization", () => {
  it("detects bare-check regrade requests", () => {
    expect(isBareCheckRegradeRequest(makeRequest())).toBe(true);
    expect(isBareCheckRegradeRequest(makeRequest({ submission_comment_id: 5 }))).toBe(false);
  });

  it("maps rubric check config to materialization kind", () => {
    expect(getBareCheckMaterializationKind(makeCheck())).toBe("submission");
    expect(getBareCheckMaterializationKind(makeCheck({ is_annotation: true }))).toBe("file");
    expect(getBareCheckMaterializationKind(makeCheck({ is_annotation: true, annotation_target: "artifact" }))).toBe(
      "artifact"
    );
  });

  it("validates resolve locations", () => {
    expect(isBareCheckResolveLocationValid("submission", {})).toBe(true);
    expect(isBareCheckResolveLocationValid("file", { submissionFileId: 1, line: 3 })).toBe(true);
    expect(isBareCheckResolveLocationValid("file", { submissionFileId: 1 })).toBe(false);
    expect(isBareCheckResolveLocationValid("artifact", { submissionArtifactId: 2 })).toBe(true);
  });
});
