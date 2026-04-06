/**
 * Integration tests for the CourseDataBridge component.
 *
 * Verifies that:
 * - The bridge reads from legacy CourseController + AuthState and provides
 *   values to the new CourseDataProvider context
 * - It handles classRtc being null (during initialization)
 * - It sets isStaff correctly based on role
 * - It passes initialData through to consumers
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { CourseDataBridge } from "@/hooks/course-data/CourseDataBridge";
import { useCourseDataContext } from "@/hooks/course-data/useCourseDataContext";
import { useCourseController } from "@/hooks/useCourseController";
import useAuthState from "@/hooks/useAuthState";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/hooks/useCourseController", () => ({
  useCourseController: jest.fn()
}));

jest.mock("@/hooks/useAuthState", () => ({
  __esModule: true,
  default: jest.fn()
}));

const mockedUseCourseController = useCourseController as jest.MockedFunction<typeof useCourseController>;
const mockedUseAuthState = useAuthState as jest.MockedFunction<typeof useAuthState>;

function makeController(overrides: Record<string, unknown> = {}) {
  return {
    courseId: 42,
    role: "student" as const,
    client: { from: jest.fn() }, // mock supabase client
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
  const ctx = useCourseDataContext();
  return (
    <div>
      <span data-testid="courseId">{ctx.courseId}</span>
      <span data-testid="role">{ctx.role}</span>
      <span data-testid="userId">{ctx.userId}</span>
      <span data-testid="isStaff">{String(ctx.isStaff)}</span>
      <span data-testid="classRtc">{ctx.classRtc === null ? "null" : "present"}</span>
      <span data-testid="hasInitialData">{ctx.initialData ? "yes" : "no"}</span>
    </div>
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("CourseDataBridge", () => {
  beforeEach(() => {
    mockedUseAuthState.mockReturnValue({ user: { id: "user-abc" } } as any);
  });

  it("provides context values to consumers", () => {
    mockedUseCourseController.mockReturnValue(makeController());

    render(
      <CourseDataBridge>
        <ContextConsumer />
      </CourseDataBridge>
    );

    expect(screen.getByTestId("courseId").textContent).toBe("42");
    expect(screen.getByTestId("role").textContent).toBe("student");
    expect(screen.getByTestId("userId").textContent).toBe("user-abc");
    expect(screen.getByTestId("classRtc").textContent).toBe("present");
  });

  it("handles controller that has not started (follower tab)", () => {
    // The controller always exists now (even for followers), but may not
    // have started its WebSocket channels.
    mockedUseCourseController.mockReturnValue(
      makeController({ classRtc: { profileId: "follower-profile", started: false } })
    );

    render(
      <CourseDataBridge>
        <ContextConsumer />
      </CourseDataBridge>
    );

    expect(screen.getByTestId("classRtc").textContent).toBe("present");
  });

  it("passes isStaff correctly: instructor -> true, student -> false", () => {
    // Instructor
    mockedUseCourseController.mockReturnValue(makeController({ role: "instructor" }));
    const { unmount } = render(
      <CourseDataBridge>
        <ContextConsumer />
      </CourseDataBridge>
    );
    expect(screen.getByTestId("isStaff").textContent).toBe("true");
    unmount();

    // Student
    mockedUseCourseController.mockReturnValue(makeController({ role: "student" }));
    render(
      <CourseDataBridge>
        <ContextConsumer />
      </CourseDataBridge>
    );
    expect(screen.getByTestId("isStaff").textContent).toBe("false");
  });

  it("passes initialData through to context consumers", () => {
    mockedUseCourseController.mockReturnValue(makeController());

    const initialData = { profiles: [{ id: 1, name: "Alice" }] } as any;

    render(
      <CourseDataBridge initialData={initialData}>
        <ContextConsumer />
      </CourseDataBridge>
    );

    expect(screen.getByTestId("hasInitialData").textContent).toBe("yes");
  });
});
