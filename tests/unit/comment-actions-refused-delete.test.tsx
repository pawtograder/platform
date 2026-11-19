/**
 * Deleting a comment that RLS refuses shows why (#983).
 *
 * CommentActions (components/ui/rubric-sidebar.tsx) used to call the TableController delete without
 * awaiting it. A refused delete puts the comment back and rejects, so the user saw the comment
 * reappear with no message and the rejection went unhandled. The delete is now awaited, and a
 * rejection is shown through getUserFacingErrorMessage with the same context the edit path uses.
 *
 * The menu only offers Delete while the page thinks the delete is allowed, so these are stale-page
 * refusals: the review was released, or the self-review deadline passed, after the page loaded.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CommentActions } from "@/components/ui/rubric-sidebar";
import { toaster } from "@/components/ui/toaster";
import { refusedWriteError } from "@/lib/refusedWriteError";
import type { SubmissionComments } from "@/utils/supabase/DatabaseTypes";

const AUTHOR = "author-private-profile";

// What the mocked hooks return; each test sets the viewer and the review.
let role: "student" | "grader" | "instructor";
let reviewRubricRound: string | null;
const deleteComment = jest.fn();

// rubric-sidebar imports these for other components; CommentActions doesn't render them, and their
// ESM dependencies (unified/remark) don't load under Jest.
jest.mock("@/components/ui/markdown", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/message-input", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/toaster", () => ({ toaster: { error: jest.fn(), success: jest.fn(), create: jest.fn() } }));
jest.mock("@/hooks/useSubmission", () => ({
  useSubmissionController: () => ({
    submission_comments: { delete: deleteComment },
    submission_file_comments: { delete: jest.fn() },
    submission_artifact_comments: { delete: jest.fn() }
  }),
  // As the page saw it: not completed, not released.
  useSubmissionReviewOrGradingReview: () => ({ id: 3, rubric_id: 5, completed_at: null, released: false })
}));
jest.mock("@/hooks/useAssignment", () => ({
  useRubricById: () => ({ id: 5, review_round: reviewRubricRound })
}));
jest.mock("@/hooks/useClassProfiles", () => ({
  useClassProfiles: () => ({ private_profile_id: AUTHOR, public_profile_id: "author-public-profile" }),
  useIsGraderOrInstructor: () => role !== "student",
  useIsInstructor: () => role === "instructor",
  useIsStudent: () => role === "student"
}));
jest.mock("@/hooks/useStaffErrorRole", () => ({ useViewerErrorRole: () => role }));

const comment = {
  id: 42,
  author: AUTHOR,
  submission_review_id: 3,
  comment: "Looks good"
} as unknown as SubmissionComments;

async function chooseDelete() {
  render(
    <ChakraProvider value={defaultSystem}>
      <CommentActions comment={comment} setIsEditing={jest.fn()} />
    </ChakraProvider>
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Comment options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
}

beforeAll(() => {
  // jsdom has no ResizeObserver; Chakra's menu positioning uses it (same shim as the survey tests).
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  jest.mocked(toaster.error).mockClear();
  deleteComment.mockReset();
  reviewRubricRound = "grading-review";
});

describe("CommentActions delete", () => {
  it("awaits the delete and shows nothing when it succeeds", async () => {
    role = "grader";
    deleteComment.mockResolvedValue(undefined);

    await chooseDelete();

    await waitFor(() => expect(deleteComment).toHaveBeenCalledWith(42));
    expect(toaster.error).not.toHaveBeenCalled();
  });

  it("shows the refusal when RLS refuses a grader's delete", async () => {
    role = "grader";
    deleteComment.mockRejectedValue(refusedWriteError("delete"));

    await chooseDelete();

    await waitFor(() =>
      expect(toaster.error).toHaveBeenCalledWith({
        title: "Couldn't delete comment",
        description: "You don't have permission to delete this. Nothing was changed."
      })
    );
  });

  it("tells a student the self-review deadline has passed", async () => {
    role = "student";
    reviewRubricRound = "self-review";
    deleteComment.mockRejectedValue(refusedWriteError("delete"));

    await chooseDelete();

    await waitFor(() => expect(toaster.error).toHaveBeenCalledTimes(1));
    expect(jest.mocked(toaster.error).mock.calls[0][0]).toMatchObject({
      title: "Couldn't delete comment",
      description: expect.stringContaining("self-review due date has passed")
    });
  });
});
