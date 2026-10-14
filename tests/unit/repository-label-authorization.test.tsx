/**
 * Regression test for issue #981.
 *
 * The assignment page used to render a student's repo as a clickable GitHub
 * link (with a ready/not-ready status) regardless of whether the student had
 * confirmed membership in the class's GitHub org. Clicking through before
 * confirmation 404'd, since GitHub had never granted access. RepositoryLabel
 * now gates the link on role.github_org_confirmed and shows a plain,
 * non-clickable notice until then.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { RepositoriesInfo } from "@/app/course/[course_id]/assignments/[assignment_id]/manageGroupWidget";
import type { Repository } from "@/utils/supabase/DatabaseTypes";

let mockGithubOrgConfirmed = false;

jest.mock("@/hooks/useClassProfiles", () => ({
  useClassProfiles: () => ({
    role: { github_org_confirmed: mockGithubOrgConfirmed }
  })
}));

function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 1,
    assignment_id: 1,
    assignment_group_id: null,
    class_id: 1,
    created_at: new Date().toISOString(),
    creation_attempts: 0,
    creation_error: null,
    desired_handout_sha: null,
    is_github_ready: true,
    last_creation_attempt_at: null,
    profile_id: "priv-1",
    repository: "org/assignment1-student",
    rerun_queued_at: null,
    sync_data: null,
    synced_handout_sha: null,
    synced_repo_sha: null,
    updated_at: new Date().toISOString(),
    ...overrides
  } as Repository;
}

function renderRepositoriesInfo(repositories: Repository[]) {
  return render(
    <ChakraProvider value={defaultSystem}>
      <RepositoriesInfo repositories={repositories} />
    </ChakraProvider>
  );
}

describe("RepositoryLabel authorization state", () => {
  beforeEach(() => {
    mockGithubOrgConfirmed = false;
  });

  it("shows a plain, non-clickable notice when the student has not confirmed org membership", () => {
    mockGithubOrgConfirmed = false;
    renderRepositoriesInfo([repo()]);

    expect(screen.getByText(/requires GitHub authorization to access/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a clickable GitHub link once org membership is confirmed", () => {
    mockGithubOrgConfirmed = true;
    renderRepositoriesInfo([repo()]);

    const link = screen.getByRole("link", { name: /org\/assignment1-student/ });
    expect(link).toHaveAttribute("href", "https://github.com/org/assignment1-student");
    expect(screen.queryByText(/requires GitHub authorization/)).not.toBeInTheDocument();
  });
});
