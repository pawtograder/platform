/**
 * Editing a file comment that RLS refuses shows why (#983).
 *
 * LineCheckAnnotation (components/ui/code-file-shared.tsx) saves an edited file comment through the
 * TableController. A refused update rejects with a refused-write error. The component maps it with
 * getUserFacingErrorMessage, using the same context as the rubric sidebar's edit, and rethrows so
 * MessageInput shows the message and keeps the editor open.
 *
 * The edit is only offered while the page thinks it is allowed, so these are stale-page refusals:
 * the review was released, or the self-review deadline passed, after the page loaded.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LineCheckAnnotation } from "@/components/ui/code-file-shared";
import { refusedWriteError } from "@/lib/refusedWriteError";
import { GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE } from "@/lib/studentFacingErrorMessages";

// What the mocked hooks return; each test sets the viewer and the review.
let role: "student" | "grader" | "instructor";
let reviewRubricRound: string | null;
let reviewReleased: boolean;
const updateFileComment = jest.fn();

const comment = {
  id: 42,
  author: "author-private-profile",
  comment: "Missing a null check",
  line: 12,
  points: 0,
  rubric_check_id: 7,
  submission_review_id: 3,
  regrade_request_id: null,
  eventually_visible: true,
  released: false,
  target_student_profile_id: null
};

// These components don't matter here, and some have ESM dependencies (unified/remark) that don't
// load under Jest.
jest.mock("@/components/ui/markdown", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/person-avatar", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/request-regrade-dialog", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/line-comments-form", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/group-member-select-option", () => ({ GroupMemberLabelText: () => null }));
jest.mock("@/components/ui/regrade-request-wrapper", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children
}));
jest.mock("@/components/bugReport/ReportBlock", () => ({
  ReportBlock: ({ children }: { children: React.ReactNode }) => children
}));
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children
}));
jest.mock("@/components/ui/toaster", () => ({ toaster: { error: jest.fn(), success: jest.fn(), create: jest.fn() } }));
jest.mock("@refinedev/core", () => ({ useUpdate: () => ({ mutateAsync: jest.fn() }) }));

// The menu's Edit item just opens the editor.
jest.mock("@/components/ui/rubric-sidebar", () => ({
  CommentActions: ({ setIsEditing }: { setIsEditing: (editing: boolean) => void }) => (
    <button onClick={() => setIsEditing(true)}>Edit comment</button>
  ),
  ReviewRoundTag: () => null
}));

// Stands in for MessageInput: Save calls sendMessage and shows what it rejects with, which is what the
// real MessageInput toasts.
jest.mock("@/components/ui/message-input", () => {
  const { useState } = jest.requireActual<typeof import("react")>("react");
  function MessageInputStub({ sendMessage }: { sendMessage: (message: string) => Promise<void> }) {
    const [error, setError] = useState<string | null>(null);
    return (
      <div data-testid="comment-editor">
        <button onClick={() => sendMessage("Edited comment").catch((e: Error) => setError(e.message))}>Save</button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }
  return { __esModule: true, default: MessageInputStub };
});

jest.mock("@/hooks/useSubmission", () => ({
  useSubmissionController: () => ({ submission_file_comments: { update: updateFileComment } }),
  useSubmissionFileComment: () => comment,
  useSubmissionReviewOrGradingReview: () => ({ id: 3, rubric_id: 5, completed_at: null, released: reviewReleased })
}));
jest.mock("@/hooks/useAssignment", () => ({
  useRubricCheck: () => ({
    id: 7,
    name: "Null safety",
    description: "Checks for null",
    points: 0,
    rubric_criteria_id: 9,
    student_visibility: "always",
    data: null
  }),
  useRubricCriteria: () => ({ id: 9, name: "Correctness", is_additive: false, rubric_id: 5 }),
  useRubricById: () => ({ id: 5, review_round: reviewRubricRound }),
  // No other annotation checks, so the check selector renders nothing.
  useRubricChecksByRubric: () => [],
  useRubricCriteriaByRubric: () => []
}));
jest.mock("@/hooks/useClassProfiles", () => ({
  useIsGraderOrInstructor: () => role !== "student",
  useIsInstructor: () => role === "instructor",
  useIsStudent: () => role === "student"
}));
jest.mock("@/hooks/useStaffErrorRole", () => ({ useViewerErrorRole: () => role }));
jest.mock("@/hooks/useUserProfiles", () => ({ useUserProfile: () => ({ name: "Pat Grader" }) }));

async function editAndSave() {
  render(
    <ChakraProvider value={defaultSystem}>
      <LineCheckAnnotation comment_id={42} />
    </ChakraProvider>
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit comment" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
}

beforeEach(() => {
  updateFileComment.mockReset();
  reviewRubricRound = "grading-review";
  reviewReleased = false;
});

describe("LineCheckAnnotation comment edit", () => {
  it("saves the edit and closes the editor when the update succeeds", async () => {
    role = "grader";
    updateFileComment.mockResolvedValue(undefined);

    await editAndSave();

    await waitFor(() => expect(screen.queryByTestId("comment-editor")).not.toBeInTheDocument());
    expect(updateFileComment).toHaveBeenCalledWith(42, { comment: "Edited comment" });
  });

  it("tells a grader the review was released and keeps the editor open", async () => {
    role = "grader";
    reviewReleased = true;
    updateFileComment.mockRejectedValue(refusedWriteError("update"));

    await editAndSave();

    expect(await screen.findByRole("alert")).toHaveTextContent(GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE);
    expect(screen.getByTestId("comment-editor")).toBeInTheDocument();
  });

  it("tells a student the self-review deadline has passed", async () => {
    role = "student";
    reviewRubricRound = "self-review";
    updateFileComment.mockRejectedValue(refusedWriteError("update"));

    await editAndSave();

    expect(await screen.findByRole("alert")).toHaveTextContent("self-review due date has passed");
    expect(screen.getByTestId("comment-editor")).toBeInTheDocument();
  });

  it("shows the plain refusal to a grader on an unreleased review", async () => {
    role = "grader";
    updateFileComment.mockRejectedValue(refusedWriteError("update"));

    await editAndSave();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to change this, or it no longer exists. Nothing was changed."
    );
  });
});
