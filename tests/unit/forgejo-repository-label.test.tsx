/**
 * CW-20 (#1113): a Forgejo repo that isn't ready yet is plain text saying "waiting for access", not
 * a link that 404s. The Playwright spec `tests/e2e/forgejo-repo-access.spec.ts` covers the page.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { RepositoriesInfo } from "@/app/course/[course_id]/assignments/[assignment_id]/manageGroupWidget";
import type { Repository } from "@/utils/supabase/DatabaseTypes";

let mockInstanceUrl: string | undefined = "https://forgejo.example";
jest.mock("@/hooks/useForgejoInstanceUrl", () => ({ useForgejoInstanceUrl: () => mockInstanceUrl }));
jest.mock("@/hooks/useClassProfiles", () => ({ useClassProfiles: () => ({ role: { github_org_confirmed: true } }) }));
jest.mock("@/utils/supabase/client", () => ({ createClient: jest.fn() }));

function repo(overrides: Partial<Repository>): Repository {
  return {
    id: 1,
    repository: "course/hw1-student",
    git_provider: "forgejo",
    is_github_ready: false,
    assignment_group_id: null,
    ...overrides
  } as Repository;
}

function renderRepos(repositories: Repository[]) {
  return render(
    <ChakraProvider value={defaultSystem}>
      <RepositoriesInfo repositories={repositories} />
    </ChakraProvider>
  );
}

describe("Forgejo repository label", () => {
  beforeEach(() => {
    mockInstanceUrl = "https://forgejo.example";
  });

  it("says 'waiting for access' with no link while the repo isn't ready", () => {
    renderRepos([repo({ is_github_ready: false })]);
    expect(screen.getByText("course/hw1-student (waiting for access)")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links to the repo on the student's Forgejo instance once it's ready", () => {
    renderRepos([repo({ is_github_ready: true })]);
    const link = screen.getByRole("link", { name: "course/hw1-student (ready ✅)" });
    expect(link).toHaveAttribute("href", "https://forgejo.example/course/hw1-student");
  });

  it("shows a ready repo as text while the Forgejo host is still loading", () => {
    mockInstanceUrl = undefined;
    renderRepos([repo({ is_github_ready: true })]);
    expect(screen.getByText("course/hw1-student (ready ✅)")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("applies to both repos when a student has a group repo and an individual one", () => {
    renderRepos([
      repo({ id: 1, repository: "course/hw1-group", assignment_group_id: 5, is_github_ready: false }),
      repo({ id: 2, repository: "course/hw1-student", is_github_ready: true })
    ]);
    expect(screen.getByText("course/hw1-group (waiting for access)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "course/hw1-student (ready ✅)" })).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
