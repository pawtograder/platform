import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManageAssignmentsToolbar } from "@/app/course/[course_id]/manage/assignments/ManageAssignmentsToolbar";
import SyncStaffTeamButton from "@/app/course/[course_id]/manage/assignments/syncStaffTeamButton";
import SubmissionRepoAnalyticsPage from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/repo-analytics/page";

let mockCourse: { github_org: string | null } = { github_org: null };
let mockAssignment: { git_provider: string } = { git_provider: "github" };
const mockAutograderSyncStaffTeam = jest.fn();
const mockToasterCreate = jest.fn();
const mockToasterError = jest.fn();
const mockToasterSuccess = jest.fn();
const mockToasterInfo = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ course_id: "1", assignment_id: "10", submissions_id: "100" }),
  usePathname: () => "/course/1/assignments/10/submissions/100/repo-analytics",
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

jest.mock("@/hooks/useClassProfiles", () => ({
  useCapability: () => true,
  useIsGraderOrInstructor: () => true
}));

jest.mock("@/hooks/useCourseController", () => ({
  useCourse: () => mockCourse,
  useUserRolesWithProfiles: () => []
}));

jest.mock("@/hooks/useAssignment", () => ({
  useAssignmentController: () => ({ assignment: mockAssignment })
}));

jest.mock("@/hooks/useSubmission", () => ({
  useSubmission: () => ({
    id: 100,
    assignment_id: 10,
    repository_id: 50,
    repository: "course/hw1-student"
  })
}));

jest.mock("@/components/ui/toaster", () => ({
  toaster: {
    create: (...args: unknown[]) => mockToasterCreate(...args),
    error: (...args: unknown[]) => mockToasterError(...args),
    success: (...args: unknown[]) => mockToasterSuccess(...args),
    info: (...args: unknown[]) => mockToasterInfo(...args)
  }
}));

jest.mock("@/lib/edgeFunctions", () => ({
  autograderSyncStaffTeam: (...args: unknown[]) => mockAutograderSyncStaffTeam(...args)
}));

jest.mock("@/components/ui/repo-analytics-chart", () => ({
  AnalyticsChart: () => null
}));

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const result = Promise.resolve({ data: [], error: null });
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => result,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: result.then.bind(result)
      };
      return chain;
    },
    rpc: jest.fn()
  })
}));

function renderWithChakra(ui: React.ReactElement) {
  return render(<ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>);
}

describe("GitHub UI guards without a GitHub organization or on Forgejo", () => {
  beforeEach(() => {
    mockCourse = { github_org: null };
    mockAssignment = { git_provider: "github" };
    mockAutograderSyncStaffTeam.mockReset();
    mockToasterCreate.mockReset();
    mockToasterError.mockReset();
    mockToasterSuccess.mockReset();
    mockToasterInfo.mockReset();
  });

  it("hides Sync Staff Team when the course has no GitHub organization", () => {
    mockCourse = { github_org: null };
    const { rerender } = renderWithChakra(<ManageAssignmentsToolbar courseId={1} />);
    expect(screen.queryByRole("button", { name: "Sync Staff Team" })).not.toBeInTheDocument();

    mockCourse = { github_org: "   " };
    rerender(
      <ChakraProvider value={defaultSystem}>
        <ManageAssignmentsToolbar courseId={1} />
      </ChakraProvider>
    );
    expect(screen.queryByRole("button", { name: "Sync Staff Team" })).not.toBeInTheDocument();
  });

  it("shows Sync Staff Team when the course has a GitHub organization", () => {
    mockCourse = { github_org: "cs-org" };
    renderWithChakra(<ManageAssignmentsToolbar courseId={1} />);
    expect(screen.getByRole("button", { name: "Sync Staff Team" })).toBeInTheDocument();
  });

  it("shows an error toast when Sync Staff Team fails", async () => {
    mockAutograderSyncStaffTeam.mockRejectedValueOnce(new Error("Class does not have a GitHub organization"));
    renderWithChakra(<SyncStaffTeamButton course_id={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync Staff Team" }));
    await waitFor(() => {
      expect(mockToasterError).toHaveBeenCalledWith({
        title: "Failed to sync staff team",
        description: "Class does not have a GitHub organization"
      });
    });
  });

  it("hides the repo analytics Refresh button for a Forgejo assignment", async () => {
    mockCourse = { github_org: "cs-org" };
    mockAssignment = { git_provider: "forgejo" };
    renderWithChakra(<SubmissionRepoAnalyticsPage />);
    expect(await screen.findByText("Repository analytics are only collected from GitHub.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh/i })).not.toBeInTheDocument();
  });

  it("shows the repo analytics Refresh button for a GitHub assignment", async () => {
    mockCourse = { github_org: "cs-org" };
    mockAssignment = { git_provider: "github" };
    renderWithChakra(<SubmissionRepoAnalyticsPage />);
    expect(await screen.findByRole("button", { name: /Refresh/i })).toBeInTheDocument();
  });
});
