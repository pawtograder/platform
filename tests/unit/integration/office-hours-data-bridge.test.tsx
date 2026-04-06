/**
 * Integration tests for the OfficeHoursDataBridge component.
 *
 * Verifies that:
 * - The bridge reads from CourseController + OfficeHoursController and provides
 *   values to the new OfficeHoursDataProvider context
 * - It handles classRtc and officeHoursRtc being null (during initialization)
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { OfficeHoursDataBridge } from "@/hooks/office-hours-data/OfficeHoursDataBridge";
import { useOfficeHoursDataContext } from "@/hooks/office-hours-data/useOfficeHoursDataContext";
import { useCourseController } from "@/hooks/useCourseController";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/hooks/useCourseController", () => ({
  useCourseController: jest.fn()
}));

jest.mock("@/hooks/useOfficeHoursRealtime", () => ({
  useOfficeHoursController: jest.fn()
}));

const mockedUseCourseController = useCourseController as jest.MockedFunction<typeof useCourseController>;
const mockedUseOfficeHoursController = useOfficeHoursController as jest.MockedFunction<typeof useOfficeHoursController>;

function makeCourseController(overrides: Record<string, unknown> = {}) {
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

function makeOhController(overrides: Record<string, unknown> = {}) {
  return {
    classId: 99,
    get officeHoursRealTimeController() {
      if (overrides.ohRtcThrows) {
        throw new Error("Not initialized");
      }
      return overrides.officeHoursRtc ?? { subscribeToTable: jest.fn() };
    },
    ...overrides
  } as unknown as ReturnType<typeof useOfficeHoursController>;
}

/** Consumer component that reads context and renders data-testid spans. */
function ContextConsumer() {
  const ctx = useOfficeHoursDataContext();
  return (
    <div>
      <span data-testid="classId">{ctx.classId}</span>
      <span data-testid="classRtc">{ctx.classRtc === null ? "null" : "present"}</span>
      <span data-testid="officeHoursRtc">{ctx.officeHoursRtc === null ? "null" : "present"}</span>
      <span data-testid="hasSupa">{ctx.supabase ? "yes" : "no"}</span>
    </div>
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("OfficeHoursDataBridge", () => {
  it("provides context values to consumers", () => {
    mockedUseCourseController.mockReturnValue(makeCourseController());
    mockedUseOfficeHoursController.mockReturnValue(makeOhController());

    render(
      <OfficeHoursDataBridge>
        <ContextConsumer />
      </OfficeHoursDataBridge>
    );

    expect(screen.getByTestId("classId").textContent).toBe("99");
    expect(screen.getByTestId("classRtc").textContent).toBe("present");
    expect(screen.getByTestId("officeHoursRtc").textContent).toBe("present");
    expect(screen.getByTestId("hasSupa").textContent).toBe("yes");
  });

  it("survives classRtc and officeHoursRtc being null", () => {
    mockedUseCourseController.mockReturnValue(makeCourseController({ classRtcThrows: true }));
    mockedUseOfficeHoursController.mockReturnValue(makeOhController({ ohRtcThrows: true }));

    render(
      <OfficeHoursDataBridge>
        <ContextConsumer />
      </OfficeHoursDataBridge>
    );

    expect(screen.getByTestId("classRtc").textContent).toBe("null");
    expect(screen.getByTestId("officeHoursRtc").textContent).toBe("null");
  });
});
