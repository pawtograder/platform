/**
 * Integration tests for the AssignmentDataBridge component.
 *
 * Verifies that:
 * - The bridge reads from legacy CourseController + useParams and provides
 *   values to the new AssignmentDataProvider context
 * - It handles classRtc being null (during initialization)
 * - It sets isStaff correctly based on role
 * - It passes initialData through to consumers
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { AssignmentDataBridge } from "@/hooks/assignment-data/AssignmentDataBridge";
import { useAssignmentDataContext } from "@/hooks/assignment-data/useAssignmentDataContext";
import { useCourseController } from "@/hooks/useCourseController";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/hooks/useCourseController", () => ({
  useCourseController: jest.fn()
}));

jest.mock("next/navigation", () => ({
  useParams: jest.fn(() => ({ assignment_id: "10" }))
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
  const ctx = useAssignmentDataContext();
  return (
    <div>
      <span data-testid="assignmentId">{ctx.assignmentId}</span>
      <span data-testid="courseId">{ctx.courseId}</span>
      <span data-testid="profileId">{ctx.profileId ?? "null"}</span>
      <span data-testid="isStaff">{String(ctx.isStaff)}</span>
      <span data-testid="classRtc">{ctx.classRtc === null ? "null" : "present"}</span>
      <span data-testid="hasInitialData">{ctx.initialData ? "yes" : "no"}</span>
    </div>
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("AssignmentDataBridge", () => {
  it("provides context values to consumers", () => {
    mockedUseCourseController.mockReturnValue(makeController());

    render(
      <AssignmentDataBridge>
        <ContextConsumer />
      </AssignmentDataBridge>
    );

    expect(screen.getByTestId("assignmentId").textContent).toBe("10");
    expect(screen.getByTestId("courseId").textContent).toBe("42");
    expect(screen.getByTestId("profileId").textContent).toBe("profile-123");
    expect(screen.getByTestId("classRtc").textContent).toBe("present");
  });

  it("survives classRtc being null (not yet initialized)", () => {
    mockedUseCourseController.mockReturnValue(
      makeController({ classRtcThrows: true })
    );

    render(
      <AssignmentDataBridge>
        <ContextConsumer />
      </AssignmentDataBridge>
    );

    expect(screen.getByTestId("classRtc").textContent).toBe("null");
    expect(screen.getByTestId("profileId").textContent).toBe("null");
  });

  it("sets isStaff correctly: instructor -> true, student -> false", () => {
    mockedUseCourseController.mockReturnValue(makeController({ role: "instructor" }));
    const { unmount } = render(
      <AssignmentDataBridge>
        <ContextConsumer />
      </AssignmentDataBridge>
    );
    expect(screen.getByTestId("isStaff").textContent).toBe("true");
    unmount();

    mockedUseCourseController.mockReturnValue(makeController({ role: "student" }));
    render(
      <AssignmentDataBridge>
        <ContextConsumer />
      </AssignmentDataBridge>
    );
    expect(screen.getByTestId("isStaff").textContent).toBe("false");
  });

  it("passes initialData through to context consumers", () => {
    mockedUseCourseController.mockReturnValue(makeController());

    const initialData = { rubrics: [{ id: 1, name: "Review" }] } as any;

    render(
      <AssignmentDataBridge initialData={initialData}>
        <ContextConsumer />
      </AssignmentDataBridge>
    );

    expect(screen.getByTestId("hasInitialData").textContent).toBe("yes");
  });
});
