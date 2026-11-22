/**
 * Repository host (`assignments.git_provider`) rules for the assignment form and the GitHub prompts.
 * The database is the source of truth: `assignments_validate_git_provider` in
 * 20261020150000_assignment_git_provider.sql enforces the flag and the lock. These helpers only
 * decide what the form offers, so an instructor sees a reason instead of a rejected save.
 */
import { COURSE_FEATURES, courseFeatureEffectiveEnabled } from "@/lib/courseFeatures";

export type GitProviderName = "github" | "forgejo";

export const GIT_PROVIDER_LABELS: Record<GitProviderName, string> = {
  github: "GitHub",
  forgejo: "Forgejo"
};

/** Same first-entry, boolean-only reading as the SQL trigger: missing or malformed is off. */
export function cloudWorkspacesEnabled(features: { name: string; enabled: boolean }[] | null | undefined): boolean {
  return courseFeatureEffectiveEnabled(features, COURSE_FEATURES.CLOUD_WORKSPACES, false);
}

/**
 * Whether the form shows the Repository host picker. Only code assignments have a repository.
 * With the flag off the picker stays hidden, unless the saved assignment is already on Forgejo:
 * hiding it then would hide which host the assignment uses.
 */
export function showRepositoryHostPicker({
  flagEnabled,
  assignmentType,
  savedProvider
}: {
  flagEnabled: boolean;
  assignmentType: string | null | undefined;
  savedProvider: string | null | undefined;
}): boolean {
  if ((assignmentType ?? "code") !== "code") return false;
  return flagEnabled || savedProvider === "forgejo";
}

/** Why the Forgejo choice is disabled, or null when it can be picked. */
export function forgejoChoiceUnavailableReason({
  flagEnabled,
  savedProvider
}: {
  flagEnabled: boolean;
  savedProvider: string | null | undefined;
}): string | null {
  if (flagEnabled || savedProvider === "forgejo") return null;
  return "Cloud workspaces is off for this course.";
}

/** What the host lock depends on. Mirrors the conditions in assignments_validate_git_provider. */
export type HostLockFacts = {
  templateRepo: string | null | undefined;
  graderRepo: string | null | undefined;
  repositoryCount: number;
  /** Assignments whose `source_assignment_id` is this one. They must stay on the same host. */
  forkTargetCount: number;
};

export type HostLockState = { status: "new" } | { status: "loading" } | { status: "error" } | HostLockFactsState;
type HostLockFactsState = { status: "loaded"; facts: HostLockFacts };

/** Why the host can't change, or null when it can. Loading and failed checks lock, like the database would. */
export function hostLockReason(state: HostLockState): string | null {
  switch (state.status) {
    case "new":
      return null;
    case "loading":
      return "Checking whether this assignment has repositories…";
    case "error":
      return "Could not check whether this assignment has repositories, so its host can't be changed here.";
    case "loaded": {
      const { templateRepo, graderRepo, repositoryCount, forkTargetCount } = state.facts;
      if (templateRepo || graderRepo || repositoryCount > 0) {
        return "This assignment already has repositories, so its host can't change.";
      }
      if (forkTargetCount > 0) {
        return "Another assignment forks from this one, so its host can't change.";
      }
      return null;
    }
  }
}

/**
 * Options that staging's code does not support on Forgejo yet, with the reason the form shows.
 * Each entry comes from a GitHub-only path; remove it when Forgejo gains that path. The sources
 * are listed in the CW-10 evidence for #1091.
 */
export const FORGEJO_UNSUPPORTED_REPO_MODES: Readonly<Record<string, string>> = {
  // repoCreationStrategy.ts creates these with creationMethod "fork"; only GitHubWrapper forks.
  template_with_student_forks: "Forgejo can't fork the handout for students yet.",
  // Same fork path, and the trigger requires the source assignment to use the same host.
  fork_from_prior_assignment: "Forgejo can't fork repositories from a prior assignment yet."
};

export const FORGEJO_UNSUPPORTED_SUBMISSION_MODES: Readonly<Record<string, string>> = {
  // forgejo-repo-webhook handles push events only; pull requests are read by github-repo-webhook.
  pr: "Pull-request submissions are only read from GitHub."
};

/**
 * Checkbox settings that Forgejo can't use yet. The form shows them off and disabled. The
 * autograder is not here: Forgejo grading (#1239) only grades assignments with has_autograder on.
 */
export const FORGEJO_UNSUPPORTED_SETTINGS = {
  // Branch rules are applied by GitHub repository creation; nothing creates Forgejo repositories here.
  branch_protection: "Branch protection is only applied to GitHub repositories.",
  // fetch_repo_analytics in github-async-worker reads the GitHub API.
  enable_repo_analytics: "Repository analytics are only collected from GitHub."
} as const;

/**
 * Switching to a no-repository mode detaches the handout, and the edit page first removes the
 * grading workflow from it through assignment-sync-autograder-workflow, which rejects Forgejo.
 */
export const FORGEJO_DETACH_REASON = "Removing a Forgejo handout from an assignment isn't supported yet.";

/**
 * A Forgejo assignment's grader repository stays on GitHub (D6), so the Autograder page sets it up.
 * Turning the autograder on or off adds or parks grade.yml in the Forgejo handout, through
 * assignment-sync-autograder-workflow, as it does for GitHub.
 */
export const FORGEJO_GRADER_SETUP_REASON =
  "The grader repository for a Forgejo assignment stays on GitHub. Enter it below.";

/** The saved row an edit form was loaded with, or undefined on the create form. */
export type SavedHostValues = {
  git_provider?: string | null;
  repo_mode?: string | null;
  submission_mode?: string | null;
  template_repo?: string | null;
};

/**
 * True when an unsupported value should be shown as saved rather than overridden: the assignment
 * was already saved on Forgejo with it. Anything else is a new choice and follows the Forgejo rules.
 */
export function keepsSavedForgejoValue(saved: SavedHostValues | undefined): boolean {
  return saved?.git_provider === "forgejo";
}

/** Why `mode` is disabled in the Repository configuration select, or null when it is offered. */
export function repoModeUnavailableReason(
  provider: string | null | undefined,
  mode: string,
  saved: SavedHostValues | undefined
): string | null {
  if (provider !== "forgejo") return null;
  if (keepsSavedForgejoValue(saved) && saved?.repo_mode === mode) return null;
  if (saved?.template_repo && (mode === "none" || mode === "no_submission")) return FORGEJO_DETACH_REASON;
  return FORGEJO_UNSUPPORTED_REPO_MODES[mode] ?? null;
}

/** Why `mode` is disabled in the Submission mode select, or null when it is offered. */
export function submissionModeUnavailableReason(
  provider: string | null | undefined,
  mode: string,
  saved: SavedHostValues | undefined
): string | null {
  if (provider !== "forgejo") return null;
  if (keepsSavedForgejoValue(saved) && saved?.submission_mode === mode) return null;
  return FORGEJO_UNSUPPORTED_SUBMISSION_MODES[mode] ?? null;
}

/**
 * Whether a checkbox setting is locked off for Forgejo. A saved Forgejo assignment keeps showing
 * its stored value (still disabled), so the form never changes it behind the instructor's back.
 */
export function forgejoSettingState(
  provider: string | null | undefined,
  saved: SavedHostValues | undefined
): { disabled: boolean; forceOff: boolean } {
  if (provider !== "forgejo") return { disabled: false, forceOff: false };
  return { disabled: true, forceOff: !keepsSavedForgejoValue(saved) };
}

/**
 * Selected values that Forgejo can't use and that weren't saved that way. Each message blocks the
 * save. This happens when an instructor picks a fork mode on GitHub and then switches to Forgejo.
 */
export function forgejoConflicts(
  provider: string | null | undefined,
  values: { repo_mode?: string | null; submission_mode?: string | null },
  saved: SavedHostValues | undefined
): string[] {
  const conflicts: string[] = [];
  const repoReason = values.repo_mode ? repoModeUnavailableReason(provider, values.repo_mode, saved) : null;
  if (repoReason) conflicts.push(`${repoReason} Choose another repository configuration.`);
  const submissionReason = values.submission_mode
    ? submissionModeUnavailableReason(provider, values.submission_mode, saved)
    : null;
  // A fork mode is the only way to reach PR mode, so report the repository configuration alone.
  if (submissionReason && !repoReason) conflicts.push(`${submissionReason} Choose push submissions.`);
  return conflicts;
}

type AssignmentForPrompts = {
  git_provider?: string | null;
  repo_mode?: string | null;
  archived_at?: string | null;
};

/**
 * Whether to show the GitHub link and invitation prompts. On an assignment page, only a Forgejo
 * assignment hides them. On course pages they hide only when every live repository-backed
 * assignment is on Forgejo, the same rule the invitation queries in #1128 use. A course with no
 * such assignments keeps them, as on staging. A course with no GitHub organization never shows them:
 * they invite students to join that organization, and GitHub repositories can't be created without it.
 */
export function needsGitHubPrompts(
  courseGitHubOrg: string | null,
  assignments: readonly AssignmentForPrompts[],
  assignmentGitProvider?: string | null
): boolean {
  if (!courseGitHubOrg) return false;
  if (assignmentGitProvider) return assignmentGitProvider !== "forgejo";
  const repoBacked = assignments.filter(
    (a) => !a.archived_at && a.repo_mode !== "none" && a.repo_mode !== "no_submission"
  );
  return repoBacked.length === 0 || repoBacked.some((a) => a.git_provider !== "forgejo");
}
