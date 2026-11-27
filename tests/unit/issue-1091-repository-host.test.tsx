/**
 * #1091 part 2: the Repository host picker on Create/Edit Assignment, the options Forgejo can't
 * use yet (#1119), and the GitHub prompt gating.
 *
 * Named tests/unit/issue* so the e2e-local lane runs it. It needs no database.
 */
import { ChakraProvider, defaultSystem, Fieldset } from "@chakra-ui/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm } from "react-hook-form";
import type { UseFormReturnType } from "@refinedev/react-hook-form";
import RepositoryHostPicker, {
  useSyncCourseDefaultGitProvider
} from "@/app/course/[course_id]/manage/assignments/new/repositoryHostPicker";
import {
  cloudWorkspacesEnabled,
  defaultGitProviderForCourse,
  FORGEJO_DETACH_REASON,
  FORGEJO_UNSUPPORTED_SETTINGS,
  forgejoChoiceUnavailableReason,
  forgejoConflicts,
  forgejoAutograderLockedOn,
  forgejoSettingState,
  hostLockReason,
  needsGitHubPrompts,
  repoModeUnavailableReason,
  showRepositoryHostPicker,
  submissionModeUnavailableReason
} from "@/lib/gitProviderOptions";
import { COURSE_FEATURES, courseFeatureEnabled, MANAGEABLE_COURSE_FEATURES } from "@/lib/courseFeatures";
import type { Assignment } from "@/utils/supabase/DatabaseTypes";

const FLAG_ON = [{ name: "cloud-workspaces", enabled: true }];
const FLAG_OFF = [{ name: "cloud-workspaces", enabled: false }];

describe("cloud-workspaces flag", () => {
  it("is off unless the first entry is boolean true, like the SQL trigger", () => {
    expect(cloudWorkspacesEnabled(null)).toBe(false);
    expect(cloudWorkspacesEnabled([])).toBe(false);
    expect(cloudWorkspacesEnabled(FLAG_OFF)).toBe(false);
    expect(cloudWorkspacesEnabled([{ name: "cloud-workspaces", enabled: "true" as unknown as boolean }])).toBe(false);
    expect(cloudWorkspacesEnabled([...FLAG_OFF, ...FLAG_ON])).toBe(false);
    expect(cloudWorkspacesEnabled(FLAG_ON)).toBe(true);
  });

  // Turning it on creates a Forgejo account for everyone enrolled, so a course that never opted in
  // must read as off everywhere, including through the generic courseFeatureEnabled.
  it("is listed on the Feature flags page and is off by default", () => {
    const entry = MANAGEABLE_COURSE_FEATURES.find((f) => f.name === COURSE_FEATURES.CLOUD_WORKSPACES);
    expect(entry).toBeDefined();
    expect(entry?.defaultWhenMissing).toBe(false);
    expect(courseFeatureEnabled(null, COURSE_FEATURES.CLOUD_WORKSPACES)).toBe(false);
    expect(courseFeatureEnabled([], COURSE_FEATURES.CLOUD_WORKSPACES)).toBe(false);
    expect(courseFeatureEnabled(FLAG_ON, COURSE_FEATURES.CLOUD_WORKSPACES)).toBe(true);
  });
});

describe("picker visibility", () => {
  it("shows only for code assignments in a flag-on course", () => {
    expect(showRepositoryHostPicker({ flagEnabled: true, assignmentType: "code", savedProvider: undefined })).toBe(
      true
    );
    expect(showRepositoryHostPicker({ flagEnabled: true, assignmentType: undefined, savedProvider: undefined })).toBe(
      true
    );
    expect(showRepositoryHostPicker({ flagEnabled: false, assignmentType: "code", savedProvider: "github" })).toBe(
      false
    );
    expect(showRepositoryHostPicker({ flagEnabled: true, assignmentType: "quiz", savedProvider: undefined })).toBe(
      false
    );
  });

  it("keeps showing a saved Forgejo assignment after the flag is turned off", () => {
    expect(showRepositoryHostPicker({ flagEnabled: false, assignmentType: "code", savedProvider: "forgejo" })).toBe(
      true
    );
    // It can still go back to GitHub, but Forgejo can't be chosen again while the flag is off.
    expect(forgejoChoiceUnavailableReason({ flagEnabled: false, savedProvider: "forgejo" })).toBeNull();
    expect(forgejoChoiceUnavailableReason({ flagEnabled: false, savedProvider: "github" })).toMatch(
      /Cloud workspaces is off/
    );
    expect(forgejoChoiceUnavailableReason({ flagEnabled: true, savedProvider: "github" })).toBeNull();
  });
});

describe("host lock", () => {
  const none = { templateRepo: null, graderRepo: null, repositoryCount: 0, forkTargetCount: 0 };

  it("is open on the create form and on an assignment with no repositories", () => {
    expect(hostLockReason({ status: "new" })).toBeNull();
    expect(hostLockReason({ status: "loaded", facts: none })).toBeNull();
  });

  it.each([
    ["a handout repository", { templateRepo: "org/handout" }],
    ["a grader repository", { graderRepo: "org/grader" }],
    ["student repositories", { repositoryCount: 3 }]
  ])("locks once the assignment has %s, like the trigger", (_label, facts) => {
    expect(hostLockReason({ status: "loaded", facts: { ...none, ...facts } })).toMatch(/already has repositories/);
  });

  it("locks while another assignment forks from this one", () => {
    expect(hostLockReason({ status: "loaded", facts: { ...none, forkTargetCount: 1 } })).toMatch(/forks from this/);
  });

  it("stays locked while checking and when the check fails", () => {
    expect(hostLockReason({ status: "loading" })).toMatch(/Checking/);
    expect(hostLockReason({ status: "error" })).toMatch(/Could not check/);
  });
});

describe("options Forgejo can't use yet", () => {
  it("disables the fork-based repository configurations and PR submissions on Forgejo only", () => {
    expect(repoModeUnavailableReason("forgejo", "template_with_student_forks", undefined)).toMatch(/fork/);
    expect(repoModeUnavailableReason("forgejo", "fork_from_prior_assignment", undefined)).toMatch(/fork/);
    expect(repoModeUnavailableReason("forgejo", "template_only_staff", undefined)).toBeNull();
    expect(repoModeUnavailableReason("forgejo", "none", undefined)).toBeNull();
    expect(repoModeUnavailableReason("forgejo", "no_submission", undefined)).toBeNull();
    expect(repoModeUnavailableReason("github", "fork_from_prior_assignment", undefined)).toBeNull();
    expect(submissionModeUnavailableReason("forgejo", "pr", undefined)).toMatch(/GitHub/);
    expect(submissionModeUnavailableReason("forgejo", "push", undefined)).toBeNull();
    expect(submissionModeUnavailableReason("github", "pr", undefined)).toBeNull();
  });

  it("keeps an unsupported value an existing Forgejo assignment was saved with", () => {
    const saved = { git_provider: "forgejo", repo_mode: "fork_from_prior_assignment", submission_mode: "pr" };
    expect(repoModeUnavailableReason("forgejo", "fork_from_prior_assignment", saved)).toBeNull();
    // Another unsupported mode is still disabled.
    expect(repoModeUnavailableReason("forgejo", "template_with_student_forks", saved)).not.toBeNull();
    expect(submissionModeUnavailableReason("forgejo", "pr", saved)).toBeNull();
    expect(
      forgejoConflicts("forgejo", { repo_mode: "fork_from_prior_assignment", submission_mode: "pr" }, saved)
    ).toEqual([]);
  });

  it("blocks the save when a GitHub choice is carried over to Forgejo", () => {
    expect(
      forgejoConflicts("forgejo", { repo_mode: "template_with_student_forks", submission_mode: "pr" }, undefined)
    ).toHaveLength(1);
    const githubSaved = { git_provider: "github", repo_mode: "fork_from_prior_assignment" };
    expect(forgejoConflicts("forgejo", { repo_mode: "fork_from_prior_assignment" }, githubSaved)[0]).toMatch(
      /Choose another repository configuration/
    );
    expect(forgejoConflicts("github", { repo_mode: "fork_from_prior_assignment" }, undefined)).toEqual([]);
    expect(
      forgejoConflicts("forgejo", { repo_mode: "template_only_staff", submission_mode: "push" }, undefined)
    ).toEqual([]);
  });

  it("doesn't offer to detach a saved Forgejo handout", () => {
    const saved = { git_provider: "forgejo", repo_mode: "template_only_staff", template_repo: "org/handout" };
    expect(repoModeUnavailableReason("forgejo", "none", saved)).toBe(FORGEJO_DETACH_REASON);
    expect(repoModeUnavailableReason("forgejo", "no_submission", saved)).toBe(FORGEJO_DETACH_REASON);
    expect(repoModeUnavailableReason("forgejo", "template_only_staff", saved)).toBeNull();
    // Without a handout there is nothing to clean up.
    expect(repoModeUnavailableReason("forgejo", "none", { ...saved, template_repo: null })).toBeNull();
    // GitHub keeps its own detach cleanup.
    expect(repoModeUnavailableReason("github", "none", { ...saved, git_provider: "github" })).toBeNull();
    expect(forgejoConflicts("forgejo", { repo_mode: "none" }, saved)[0]).toMatch(/Removing a Forgejo handout/);
  });

  it("leaves the autograder available on Forgejo, which grades only assignments that have it on", () => {
    expect(Object.keys(FORGEJO_UNSUPPORTED_SETTINGS)).not.toContain("has_autograder");
  });

  it("holds the autograder on for Forgejo, unless a saved Forgejo assignment already has it off", () => {
    expect(forgejoAutograderLockedOn("github", undefined)).toBe(false);
    expect(forgejoAutograderLockedOn("forgejo", undefined)).toBe(true);
    expect(forgejoAutograderLockedOn("forgejo", { git_provider: "github", has_autograder: false })).toBe(true);
    expect(forgejoAutograderLockedOn("forgejo", { git_provider: "forgejo", has_autograder: true })).toBe(true);
    expect(forgejoAutograderLockedOn("forgejo", { git_provider: "forgejo", has_autograder: false })).toBe(false);
  });

  it("shows checkbox settings off on Forgejo, but keeps a saved Forgejo assignment's values", () => {
    expect(forgejoSettingState("github", undefined)).toEqual({ disabled: false, forceOff: false });
    expect(forgejoSettingState("forgejo", undefined)).toEqual({ disabled: true, forceOff: true });
    expect(forgejoSettingState("forgejo", { git_provider: "github" })).toEqual({ disabled: true, forceOff: true });
    expect(forgejoSettingState("forgejo", { git_provider: "forgejo" })).toEqual({ disabled: true, forceOff: false });
  });
});

describe("GitHub prompts", () => {
  const org = "neu-cs4535";
  const github = { git_provider: "github", repo_mode: "template_only_staff", archived_at: null };
  const forgejo = { git_provider: "forgejo", repo_mode: "template_only_staff", archived_at: null };

  it("hide on a Forgejo assignment page and stay on a GitHub one", () => {
    expect(needsGitHubPrompts(org, [github], "forgejo")).toBe(false);
    expect(needsGitHubPrompts(org, [forgejo], "github")).toBe(true);
  });

  it("hide on course pages only when every live repository-backed assignment is on Forgejo", () => {
    expect(needsGitHubPrompts(org, [])).toBe(true);
    expect(needsGitHubPrompts(org, [forgejo])).toBe(false);
    expect(needsGitHubPrompts(org, [forgejo, github])).toBe(true);
    // No-repository and archived GitHub assignments don't need a GitHub account.
    expect(needsGitHubPrompts(org, [forgejo, { ...github, repo_mode: "none" }])).toBe(false);
    expect(needsGitHubPrompts(org, [forgejo, { ...github, repo_mode: "no_submission" }])).toBe(false);
    expect(needsGitHubPrompts(org, [forgejo, { ...github, archived_at: "2026-10-01T00:00:00Z" }])).toBe(false);
    // A course with only no-repository assignments keeps them, as on staging.
    expect(needsGitHubPrompts(org, [{ ...github, repo_mode: "none" }])).toBe(true);
  });

  it("never show in a course with no GitHub organization, which they would ask students to join", () => {
    expect(needsGitHubPrompts(null, [])).toBe(false);
    expect(needsGitHubPrompts(null, [github])).toBe(false);
    expect(needsGitHubPrompts(null, [github], "github")).toBe(false);
  });
});

// The picker component, rendered with a real react-hook-form instance.
const mockUseCourse = jest.fn();
jest.mock("@/hooks/useCourseController", () => ({
  useCourse: () => mockUseCourse()
}));

type LockRows = { repositories: number; graderRepo: string | null; forkTargets: number; fail?: boolean };
let lockRows: LockRows = { repositories: 0, graderRepo: null, forkTargets: 0 };
jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => {
        const result =
          table === "repositories"
            ? { count: lockRows.repositories, error: lockRows.fail ? { message: "denied" } : null }
            : { count: lockRows.forkTargets, error: null };
        const builder = {
          eq: () => builder,
          maybeSingle: () => Promise.resolve({ data: { grader_repo: lockRows.graderRepo }, error: null }),
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        };
        return builder;
      }
    })
  })
}));

let formRef: UseFormReturnType<Assignment> | undefined;

function Harness({ defaults, saved }: { defaults: Partial<Assignment>; saved?: Partial<Assignment> }) {
  const rhf = useForm<Assignment>({ defaultValues: defaults as Assignment });
  const form = {
    ...rhf,
    refineCore: { query: saved ? { data: { data: saved } } : undefined }
  } as unknown as UseFormReturnType<Assignment>;
  formRef = form;
  return <RepositoryHostPicker form={form} />;
}

function renderPicker(defaults: Partial<Assignment>, saved?: Partial<Assignment>) {
  return render(
    <ChakraProvider value={defaultSystem}>
      {/* The form wraps every section in Fieldset.Root. */}
      <Fieldset.Root>
        <Harness defaults={defaults} saved={saved} />
      </Fieldset.Root>
    </ChakraProvider>
  );
}

describe("RepositoryHostPicker", () => {
  beforeEach(() => {
    lockRows = { repositories: 0, graderRepo: null, forkTargets: 0 };
    mockUseCourse.mockReturnValue({ features: FLAG_ON });
    formRef = undefined;
  });

  it("renders nothing in a flag-off course", () => {
    mockUseCourse.mockReturnValue({ features: FLAG_OFF });
    renderPicker({ assignment_type: "code" });
    expect(screen.queryByLabelText("Repository host")).not.toBeInTheDocument();
  });

  it("offers GitHub and Forgejo in a flag-on course, defaulting to GitHub", () => {
    renderPicker({ assignment_type: "code" });
    const select = screen.getByLabelText("Repository host") as HTMLSelectElement;
    expect(select.value).toBe("github");
    expect(select).not.toBeDisabled();
    expect((screen.getByRole("option", { name: "Forgejo" }) as HTMLOptionElement).disabled).toBe(false);
  });

  it("locks an assignment that has repositories", async () => {
    lockRows = { repositories: 2, graderRepo: null, forkTargets: 0 };
    renderPicker(
      { assignment_type: "code", git_provider: "github" },
      { id: 7, git_provider: "github", template_repo: null }
    );
    await waitFor(() => expect(screen.getByText(/already has repositories/)).toBeInTheDocument());
    expect(screen.getByLabelText("Repository host")).toBeDisabled();
  });

  it("unlocks an assignment once the check finds no repositories", async () => {
    renderPicker(
      { assignment_type: "code", git_provider: "github" },
      { id: 7, git_provider: "github", template_repo: null }
    );
    expect(screen.getByLabelText("Repository host")).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText("Repository host")).not.toBeDisabled());
  });

  it("stays locked when the repository check fails", async () => {
    lockRows = { repositories: 0, graderRepo: null, forkTargets: 0, fail: true };
    renderPicker(
      { assignment_type: "code", git_provider: "github" },
      { id: 7, git_provider: "github", template_repo: null }
    );
    await waitFor(() => expect(screen.getByText(/Could not check/)).toBeInTheDocument());
    expect(screen.getByLabelText("Repository host")).toBeDisabled();
  });

  it("reports a fork mode carried over to Forgejo and blocks the save", async () => {
    renderPicker({ assignment_type: "code", git_provider: "forgejo", repo_mode: "template_with_student_forks" });
    expect(screen.getByTestId("repository-host-conflict")).toHaveTextContent(/fork the handout/);
    let valid = true;
    await act(async () => {
      valid = await formRef!.trigger("git_provider");
    });
    expect(valid).toBe(false);
  });

  it("keeps a saved Forgejo assignment's picker visible after the flag is turned off", async () => {
    mockUseCourse.mockReturnValue({ features: FLAG_OFF });
    renderPicker(
      { assignment_type: "code", git_provider: "forgejo" },
      { id: 8, git_provider: "forgejo", template_repo: null }
    );
    expect((screen.getByLabelText("Repository host") as HTMLSelectElement).value).toBe("forgejo");
    await waitFor(() => expect(screen.getByLabelText("Repository host")).not.toBeDisabled());
  });
});

describe("course default repository host (#1388)", () => {
  it("always returns GitHub while cloud-workspaces is off", () => {
    expect(defaultGitProviderForCourse(null)).toBe("github");
    expect(defaultGitProviderForCourse({ features: FLAG_OFF, default_git_provider: "forgejo", github_org: null })).toBe(
      "github"
    );
    expect(
      defaultGitProviderForCourse({ features: FLAG_OFF, default_git_provider: "forgejo", github_org: "neu-cs" })
    ).toBe("github");
    expect(defaultGitProviderForCourse({ features: [], default_git_provider: null, github_org: null })).toBe("github");
  });

  it("honors explicit course default when cloud-workspaces is on", () => {
    expect(
      defaultGitProviderForCourse({ features: FLAG_ON, default_git_provider: "forgejo", github_org: "neu-cs" })
    ).toBe("forgejo");
    expect(defaultGitProviderForCourse({ features: FLAG_ON, default_git_provider: "github", github_org: null })).toBe(
      "github"
    );
  });

  it("falls back to Forgejo when no GitHub org is set and keeps GitHub otherwise", () => {
    expect(defaultGitProviderForCourse({ features: FLAG_ON, default_git_provider: null, github_org: null })).toBe(
      "forgejo"
    );
    expect(defaultGitProviderForCourse({ features: FLAG_ON, default_git_provider: null, github_org: "   " })).toBe(
      "forgejo"
    );
    expect(defaultGitProviderForCourse({ features: FLAG_ON, default_git_provider: null, github_org: "neu-cs" })).toBe(
      "github"
    );
  });

  function NewAssignmentHarness({
    course
  }: {
    course: {
      features: { name: string; enabled: boolean }[];
      default_git_provider: string | null;
      github_org: string | null;
    };
  }) {
    const courseDefault = defaultGitProviderForCourse(course);
    const rhf = useForm<Assignment>({
      defaultValues: { assignment_type: "code", git_provider: courseDefault } as Assignment
    });
    const form = {
      ...rhf,
      refineCore: { query: undefined }
    } as unknown as UseFormReturnType<Assignment>;
    useSyncCourseDefaultGitProvider(form, courseDefault);
    formRef = form;
    return <RepositoryHostPicker form={form} />;
  }

  it("defaults new assignments to the course default and updates until the user picks a host", () => {
    const forgejoOnlyCourse = { features: FLAG_ON, default_git_provider: null, github_org: null };
    mockUseCourse.mockReturnValue(forgejoOnlyCourse);
    const { rerender } = render(
      <ChakraProvider value={defaultSystem}>
        <Fieldset.Root>
          <NewAssignmentHarness course={forgejoOnlyCourse} />
        </Fieldset.Root>
      </ChakraProvider>
    );
    expect((screen.getByLabelText("Repository host") as HTMLSelectElement).value).toBe("forgejo");

    // Before the user touches the select, a live course-default change updates the form.
    const githubCourse = { features: FLAG_ON, default_git_provider: "github", github_org: null };
    mockUseCourse.mockReturnValue(githubCourse);
    rerender(
      <ChakraProvider value={defaultSystem}>
        <Fieldset.Root>
          <NewAssignmentHarness course={githubCourse} />
        </Fieldset.Root>
      </ChakraProvider>
    );
    expect((screen.getByLabelText("Repository host") as HTMLSelectElement).value).toBe("github");

    // Once the user chooses a host (even flipping away and back), later course updates never override it.
    fireEvent.change(screen.getByLabelText("Repository host"), { target: { value: "forgejo" } });
    fireEvent.change(screen.getByLabelText("Repository host"), { target: { value: "github" } });
    expect((screen.getByLabelText("Repository host") as HTMLSelectElement).value).toBe("github");

    const backToForgejo = { features: FLAG_ON, default_git_provider: "forgejo", github_org: "neu-cs" };
    mockUseCourse.mockReturnValue(backToForgejo);
    rerender(
      <ChakraProvider value={defaultSystem}>
        <Fieldset.Root>
          <NewAssignmentHarness course={backToForgejo} />
        </Fieldset.Root>
      </ChakraProvider>
    );
    expect((screen.getByLabelText("Repository host") as HTMLSelectElement).value).toBe("github");
  });

  it("does not override an edited GitHub assignment when the course default is Forgejo", async () => {
    mockUseCourse.mockReturnValue({ features: FLAG_ON, default_git_provider: "forgejo", github_org: "neu-cs" });
    renderPicker(
      { assignment_type: "code", git_provider: "github" },
      { id: 9, git_provider: "github", template_repo: null }
    );
    expect((screen.getByLabelText("Repository host") as HTMLSelectElement).value).toBe("github");
    await waitFor(() => expect(screen.getByLabelText("Repository host")).not.toBeDisabled());
    expect((screen.getByLabelText("Repository host") as HTMLSelectElement).value).toBe("github");
  });
});
