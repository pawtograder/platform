/**
 * Regression test for #1076.
 *
 * `ArtifactView` used to sign a `submission-artifacts` key for every artifact before it
 * rendered anything. Four of the five formats are backed by a stored file, so that was
 * fine for them. `exam_v1` is not: `finalize` in the exam worker inserts the
 * submission_artifacts row and nothing anywhere uploads a file for it. Everything the
 * grader sees comes from `artifact.data` plus the page images, which
 * ExamSubmissionRenderer signs itself out of the separate `submission-files` bucket.
 *
 * So the sign call 404'd, `downloadError` was set, and the early return at the top of
 * ArtifactView replaced the whole view with "Error downloading artifact: Object not
 * found". Every finalized exam rendered that instead of the answer crops.
 *
 * These tests drive the component with a storage client whose createSignedUrl always
 * fails, which is what the real bucket does for an exam key. The first test fails
 * without the fix. The last one is the counterweight: file-backed artifacts must still
 * report a signing failure, so the fix can't be "stop reporting errors".
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { ArtifactView } from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/files/page";
import type { SubmissionArtifact } from "@/utils/supabase/DatabaseTypes";

const createSignedUrl = jest.fn();
const download = jest.fn();

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({ createSignedUrl, download })
    }
  })
}));

// The renderer has its own tests and signs out of a different bucket. Here it only needs
// to be identifiable, so that "did we get past the download gate" is what we assert.
jest.mock("@/components/ui/exam-submission-renderer", () => ({
  __esModule: true,
  default: () => <div data-testid="exam-renderer">exam crops</div>
}));

// The page pulls in the code viewer and the markdown pipeline at module scope, and those
// reach ESM-only remark packages that jest does not transform. ArtifactView touches none
// of them, so they are stubbed to keep the import graph of this test small.
jest.mock("@/components/ui/code-file", () => ({
  __esModule: true,
  default: () => null,
  formatPoints: () => "",
  RubricCheckSelectOption: () => null,
  RubricCheckSubOptions: () => null,
  RubricCriteriaSelectGroupOption: () => null
}));
jest.mock("@/components/ui/markdown", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/markdown-file-preview", () => ({
  __esModule: true,
  default: () => null,
  isMarkdownFile: () => false
}));
jest.mock("@/components/ui/message-input", () => ({ __esModule: true, default: () => null }));

jest.mock("@/hooks/useSubmission", () => ({
  useSubmissionArtifactComments: () => [],
  useSubmissionController: () => ({ submission: null })
}));

function artifact(format: string): SubmissionArtifact {
  return {
    id: 7,
    class_id: 1,
    profile_id: "profile-1",
    assignment_group_id: null,
    submission_id: 42,
    name: "Exam",
    data: { format, questions: [], pages: [] }
  } as unknown as SubmissionArtifact;
}

function renderArtifact(a: SubmissionArtifact) {
  return render(
    <ChakraProvider value={defaultSystem}>
      <ArtifactView artifact={a} />
    </ChakraProvider>
  );
}

describe("ArtifactView download gate (#1076)", () => {
  beforeEach(() => {
    createSignedUrl.mockReset();
    download.mockReset();
    // What the real bucket returns for an exam key: the object was never uploaded.
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "Object not found" } });
    download.mockResolvedValue({ data: null, error: { message: "Object not found" } });
  });

  it("renders an exam_v1 artifact instead of a download error", async () => {
    renderArtifact(artifact("exam_v1"));

    expect(await screen.findByTestId("exam-renderer")).toBeInTheDocument();
    expect(screen.queryByText(/Error downloading artifact/)).not.toBeInTheDocument();
  });

  it("never asks storage to sign a key for an exam_v1 artifact", async () => {
    renderArtifact(artifact("exam_v1"));

    await screen.findByTestId("exam-renderer");
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("still surfaces a signing failure for a file-backed artifact", async () => {
    renderArtifact(artifact("plaintext"));

    expect(await screen.findByText(/Error downloading artifact: Object not found/)).toBeInTheDocument();
    expect(createSignedUrl).toHaveBeenCalled();
  });
});
