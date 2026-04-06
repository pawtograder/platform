/**
 * Integration tests for the SubmissionDataBridge component.
 *
 * Verifies that:
 * - The bridge reads from CourseController + useParams and provides
 *   values to the new SubmissionDataProvider context
 * - It handles classRtc being null (during initialization)
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { SubmissionDataBridge } from "@/hooks/submission-data/SubmissionDataBridge";
import { useSubmissionDataContext } from "@/hooks/submission-data/useSubmissionDataContext";
import { useCourseController } from "@/hooks/useCourseController";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/hooks/useCourseController", () => ({
  useCourseController: jest.fn()
}));

jest.mock("next/navigation", () => ({
  useParams: jest.fn(() => ({ submissions_id: "77", course_id: "42" }))
}));

const mockedUseCourseController = useCourseController as jest.MockedFunction<typeof useCourseController>;

function makeController(overrides: Record<string, unknown> = {}) {
  return {
    courseId: 42,
    role: "student" as const,
    client: { from: jest.fn() },
    get classRealTimeController() {
      if (overrides.classRtcThrows) {
        throw new Error("Not initialized");
      }
      return overrides.classRtc ?? { profileId: "profile-123" };
    },
    ...overrides
  } as unknown as ReturnType<typeof useCourseController>;
}

/** Consumer component that reads context and renders data-testid spans. */
function ContextConsumer() {
  const ctx = useSubmissionDataContext();
  return (
    <div>
      <span data-testid="submissionId">{ctx.submissionId}</span>
      <span data-testid="courseId">{ctx.courseId}</span>
      <span data-testid="classRtc">{ctx.classRtc === null ? "null" : "present"}</span>
      <span data-testid="hasSupa">{ctx.supabase ? "yes" : "no"}</span>
    </div>
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("SubmissionDataBridge", () => {
  it("provides context values to consumers", () => {
    mockedUseCourseController.mockReturnValue(makeController());

    render(
      <SubmissionDataBridge>
        <ContextConsumer />
      </SubmissionDataBridge>
    );

    expect(screen.getByTestId("submissionId").textContent).toBe("77");
    expect(screen.getByTestId("courseId").textContent).toBe("42");
    expect(screen.getByTestId("classRtc").textContent).toBe("present");
    expect(screen.getByTestId("hasSupa").textContent).toBe("yes");
  });

  it("survives classRtc being null (not yet initialized)", () => {
    mockedUseCourseController.mockReturnValue(
      makeController({ classRtcThrows: true })
    );

    render(
      <SubmissionDataBridge>
        <ContextConsumer />
      </SubmissionDataBridge>
    );

    expect(screen.getByTestId("classRtc").textContent).toBe("null");
  });
});
