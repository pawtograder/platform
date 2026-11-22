/**
 * @jest-environment jsdom
 *
 * #1062: the Feature flags page showed stale values when another instructor changed a flag.
 *
 * The page read `features` from `useClassProfiles().role.classes`, which is the class row as it
 * stood when the role was loaded and never changes afterwards. The Enrollments page in the same
 * settings area updates live because it reads `useCourse()`, which CourseProvider keeps current
 * from the `classes_update` broadcast. These tests pin that difference: the switches must follow
 * the live course row, and a change arriving on it must reach the page while the role snapshot
 * stays stale.
 *
 * Named tests/unit/issue* so deploy.yml's `--testPathPatterns "tests/unit/issue"` lane runs it;
 * lint.yml's jest job takes an explicit file list and does not glob. Needs no database.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import CourseFeatureFlagsPage from "@/app/course/[course_id]/manage/course/feature-flags/page";
import { COURSE_FEATURES } from "@/lib/courseFeatures";

type Feature = { name: string; enabled: boolean };

const mockUseCourse = jest.fn();
const mockRoleClasses = jest.fn();

jest.mock("@/hooks/useCourseController", () => ({
  useCourse: () => mockUseCourse()
}));

jest.mock("@/hooks/useClassProfiles", () => ({
  useClassProfiles: () => ({ role: { role: "instructor", classes: mockRoleClasses() } }),
  // The page picks its error wording from useIsInstructor (useStaffErrorRole).
  useIsInstructor: () => true
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ course_id: "1" }),
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() })
}));

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ rpc: jest.fn().mockResolvedValue({ error: null }) })
}));

jest.mock("@/components/ui/toaster", () => ({
  toaster: { success: jest.fn(), error: jest.fn() }
}));

// Pulls the gradebook stack in; this page only renders it behind a dialog that stays closed.
jest.mock("@/components/gradebook/AutoGroupPreviewDialog", () => ({
  AutoGroupPreviewDialog: () => null
}));

const OFFICE_HOURS_SWITCH = "Enable Office hours for this course";

function renderPage() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <CourseFeatureFlagsPage />
    </ChakraProvider>
  );
}

function setCourse(features: Feature[]) {
  mockUseCourse.mockReturnValue({ id: 1, features, gradebook_id: 7 });
}

function setRoleSnapshot(features: Feature[]) {
  mockRoleClasses.mockReturnValue({ id: 1, features, gradebook_id: 7 });
}

describe("issue #1062: feature flags update live", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("follows the live course row, not the role snapshot", () => {
    // The two disagree, which is exactly the state the bug left the page in: the role snapshot
    // still says on, the class row says off. The switch has to show the class row.
    setCourse([{ name: COURSE_FEATURES.OFFICE_HOURS, enabled: false }]);
    setRoleSnapshot([{ name: COURSE_FEATURES.OFFICE_HOURS, enabled: true }]);
    renderPage();
    expect((screen.getByLabelText(OFFICE_HOURS_SWITCH) as HTMLInputElement).checked).toBe(false);
  });

  it("picks up a flag another instructor changed, with no refresh", () => {
    setCourse([{ name: COURSE_FEATURES.OFFICE_HOURS, enabled: false }]);
    setRoleSnapshot([{ name: COURSE_FEATURES.OFFICE_HOURS, enabled: false }]);
    const { rerender } = renderPage();
    expect((screen.getByLabelText(OFFICE_HOURS_SWITCH) as HTMLInputElement).checked).toBe(false);

    // What the classes_update broadcast does: the course row changes under the page. The role
    // snapshot is deliberately left alone, because nothing refreshes it.
    setCourse([{ name: COURSE_FEATURES.OFFICE_HOURS, enabled: true }]);
    rerender(
      <ChakraProvider value={defaultSystem}>
        <CourseFeatureFlagsPage />
      </ChakraProvider>
    );
    expect((screen.getByLabelText(OFFICE_HOURS_SWITCH) as HTMLInputElement).checked).toBe(true);
  });

  it("a course with no features column still renders its defaults", () => {
    setCourse([]);
    setRoleSnapshot([]);
    renderPage();
    // Office hours defaults on when missing, so an empty column must not read as off.
    expect((screen.getByLabelText(OFFICE_HOURS_SWITCH) as HTMLInputElement).checked).toBe(true);
  });
});
