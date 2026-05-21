import { render, screen } from "@testing-library/react";
import { CourseFeatureGate } from "@/components/course/course-feature-gate";
import { COURSE_FEATURES } from "@/lib/courseFeatures";

const mockUseCourse = jest.fn();

jest.mock("@/hooks/useCourseController", () => ({
  useCourse: () => mockUseCourse()
}));

function mockFeatures(features: { name: string; enabled: boolean }[] | null) {
  mockUseCourse.mockReturnValue({
    features
  });
}

describe("CourseFeatureGate", () => {
  beforeEach(() => {
    mockUseCourse.mockReset();
  });

  it("renders dashboard content when a course feature is enabled", () => {
    mockFeatures([{ name: COURSE_FEATURES.SURVEYS, enabled: true }]);

    render(
      <CourseFeatureGate feature={COURSE_FEATURES.SURVEYS}>
        <div>Survey dashboard widget</div>
      </CourseFeatureGate>
    );

    expect(screen.getByText("Survey dashboard widget")).toBeInTheDocument();
  });

  it("hides dashboard content when a course feature is disabled", () => {
    mockFeatures([{ name: COURSE_FEATURES.SURVEYS, enabled: false }]);

    render(
      <CourseFeatureGate feature={COURSE_FEATURES.SURVEYS}>
        <div>Survey dashboard widget</div>
      </CourseFeatureGate>
    );

    expect(screen.queryByText("Survey dashboard widget")).not.toBeInTheDocument();
  });

  it("uses the feature default when the course has no explicit flag", () => {
    mockFeatures(null);

    render(
      <CourseFeatureGate feature={COURSE_FEATURES.GRADEBOOK_WHAT_IF}>
        <div>What-If dashboard widget</div>
      </CourseFeatureGate>
    );

    expect(screen.queryByText("What-If dashboard widget")).not.toBeInTheDocument();
  });
});
