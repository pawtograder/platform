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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import CourseFeatureFlagsPage from "@/app/course/[course_id]/manage/course/feature-flags/page";
import { COURSE_FEATURES } from "@/lib/courseFeatures";

type Feature = { name: string; enabled: boolean };

const mockUseCourse = jest.fn();
const mockRoleClasses = jest.fn();
const mockUpdateSelect = jest.fn();
const mockUpdate = jest.fn(() => ({
  eq: () => ({
    select: mockUpdateSelect
  })
}));

jest.mock("@/hooks/useCourseController", () => ({
  useCourse: () => mockUseCourse()
}));

jest.mock("@/hooks/useClassProfiles", () => ({
  useClassProfiles: () => ({ role: { role: "instructor", classes: mockRoleClasses() } }),
  // The page picks its error wording from useIsInstructor and useOptionalCourseRole (useStaffErrorRole).
  useIsInstructor: () => true,
  useOptionalCourseRole: () => "instructor"
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ course_id: "1" }),
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() })
}));

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    rpc: jest.fn().mockResolvedValue({ error: null }),
    from: () => ({ update: mockUpdate })
  })
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

function setCourse(
  features: Feature[],
  extra: { default_git_provider?: string | null; github_org?: string | null } = {}
) {
  mockUseCourse.mockReturnValue({
    id: 1,
    features,
    gradebook_id: 7,
    github_org: "neu-cs",
    default_git_provider: null,
    ...extra
  });
}

function setRoleSnapshot(features: Feature[]) {
  mockRoleClasses.mockReturnValue({ id: 1, features, gradebook_id: 7 });
}

describe("issue #1062: feature flags update live", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateSelect.mockResolvedValue({ data: [{ id: 1 }], error: null });
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

  it("saves the course default repository host and reflects live updates", async () => {
    setCourse([{ name: COURSE_FEATURES.CLOUD_WORKSPACES, enabled: true }], {
      github_org: null,
      default_git_provider: null
    });
    setRoleSnapshot([]);
    const { rerender } = renderPage();
    const select = screen.getByLabelText("Default repository host for new assignments") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "Automatic (Forgejo)" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "forgejo" } });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ default_git_provider: "forgejo" }));
    expect(select.value).toBe("forgejo");

    // Simulate the saved value arriving on the live course row, then another instructor resetting it to Automatic.
    setCourse([{ name: COURSE_FEATURES.CLOUD_WORKSPACES, enabled: true }], {
      github_org: null,
      default_git_provider: "forgejo"
    });
    rerender(
      <ChakraProvider value={defaultSystem}>
        <CourseFeatureFlagsPage />
      </ChakraProvider>
    );
    expect(select.value).toBe("forgejo");

    setCourse([{ name: COURSE_FEATURES.CLOUD_WORKSPACES, enabled: true }], {
      github_org: "neu-cs",
      default_git_provider: null
    });
    rerender(
      <ChakraProvider value={defaultSystem}>
        <CourseFeatureFlagsPage />
      </ChakraProvider>
    );
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "Automatic (GitHub)" })).toBeInTheDocument();

    // Error rolls back the optimistic selection.
    mockUpdateSelect.mockResolvedValueOnce({ data: null, error: { message: "denied" } });
    fireEvent.change(select, { target: { value: "github" } });
    await waitFor(() => expect(select.value).toBe(""));
  });
});
