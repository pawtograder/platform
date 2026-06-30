// Pure helpers for picking what `createRepo` should do for a given assignment
// + student/group identity. Extracted so the orchestration in
// `assignment-create-all-repos` and `autograder-create-repos-for-student` can
// be unit-tested against a mocked GitHub layer.

import type { BranchProtectionConfig } from "./branchProtection.ts";

export type AssignmentRepoMode =
  | "none"
  | "template_only_staff"
  | "template_with_student_forks"
  | "fork_from_prior_assignment"
  | "no_submission";

export type AssignmentForRepoCreation = {
  id: number;
  repo_mode: AssignmentRepoMode;
  template_repo: string | null;
  source_assignment_id: number | null;
};

export type StudentIdentity = {
  /** Set for individual repos. */
  profile_id?: string | null;
  /** Set for group repos. */
  assignment_group_id?: number | null;
  /**
   * For group repos in mode 3 we match by group name on the source
   * assignment, since `assignment_group_id` differs between assignments even
   * for "the same group". The caller supplies this when copying groups across
   * assignments is the policy in use.
   */
  group_name?: string | null;
  /** Human description used in error messages. */
  display_name?: string;
};

/**
 * Minimal shape of a row in `public.repositories` needed to resolve a fork
 * source for mode `fork_from_prior_assignment`.
 */
export type SourceRepoRow = {
  repository: string;
  profile_id?: string | null;
  assignment_group_id?: number | null;
  group_name?: string | null;
};

export type RepoCreationStrategy =
  | { kind: "skip"; reason: "no_repo_mode" }
  | { kind: "skip"; reason: "missing_source"; error: string }
  | {
      kind: "create";
      creationMethod: "template" | "fork";
      sourceRepo: string;
    };

/**
 * Resolve what should happen for a single student/group when creating their
 * per-assignment repo, given the assignment's repo_mode and (for mode 3) the
 * list of repos on the source assignment.
 *
 * Returns a `skip` variant with an actionable error message rather than
 * throwing — the caller usually wants to surface the error in a list with
 * other per-student outcomes rather than failing the whole batch.
 */
export function resolveRepoCreationStrategy(
  assignment: AssignmentForRepoCreation,
  student: StudentIdentity,
  sourceAssignmentRepos: SourceRepoRow[] = []
): RepoCreationStrategy {
  switch (assignment.repo_mode) {
    case "none":
    case "no_submission":
      // Neither mode creates per-student repos. 'none' lets students upload
      // submission files; 'no_submission' has no student artifact at all.
      return { kind: "skip", reason: "no_repo_mode" };

    case "template_only_staff":
      if (!assignment.template_repo) {
        return {
          kind: "skip",
          reason: "missing_source",
          error: `Assignment ${assignment.id} has no template_repo configured`
        };
      }
      return {
        kind: "create",
        creationMethod: "template",
        sourceRepo: assignment.template_repo
      };

    case "template_with_student_forks":
      if (!assignment.template_repo) {
        return {
          kind: "skip",
          reason: "missing_source",
          error: `Assignment ${assignment.id} has no template_repo configured for student forks`
        };
      }
      return {
        kind: "create",
        creationMethod: "fork",
        sourceRepo: assignment.template_repo
      };

    case "fork_from_prior_assignment": {
      if (!assignment.source_assignment_id) {
        return {
          kind: "skip",
          reason: "missing_source",
          error: `Assignment ${assignment.id} is configured for fork_from_prior_assignment but has no source_assignment_id`
        };
      }
      const sourceRepo = findSourceRepo(student, sourceAssignmentRepos);
      if (!sourceRepo) {
        const who = student.display_name || student.group_name || student.profile_id || "(unknown)";
        return {
          kind: "skip",
          reason: "missing_source",
          error: `No source repository found on assignment ${assignment.source_assignment_id} for ${who}`
        };
      }
      return {
        kind: "create",
        creationMethod: "fork",
        sourceRepo: sourceRepo.repository
      };
    }
  }
}

function findSourceRepo(student: StudentIdentity, sourceRepos: SourceRepoRow[]): SourceRepoRow | null {
  if (student.profile_id) {
    return sourceRepos.find((r) => r.profile_id === student.profile_id) ?? null;
  }
  // Prefer matching groups by NAME. For cross-assignment forks (mode 3) the
  // assignment_group_id differs between the source and target assignments even
  // for "the same" group, so the id-based fallback below only matches when the
  // caller is working within a single assignment's id space (e.g. tests or
  // same-assignment re-runs). Mode-3 callers should always supply group_name.
  if (student.group_name) {
    return sourceRepos.find((r) => r.group_name === student.group_name) ?? null;
  }
  if (student.assignment_group_id != null) {
    return sourceRepos.find((r) => r.assignment_group_id === student.assignment_group_id) ?? null;
  }
  return null;
}

export type RepoCreationArgs = {
  org: string;
  repoName: string;
  courseSlug: string;
  githubUsernames: string[];
  branchProtection: BranchProtectionConfig;
};

/**
 * Build the full async-worker `CreateRepoArgs` payload for a student/group,
 * combining the strategy resolution with the per-row identity bits. Returns
 * null when the strategy says skip.
 */
export function buildCreateRepoArgs(
  args: RepoCreationArgs,
  strategy: RepoCreationStrategy,
  options: { isTemplateRepo?: boolean } = {}
): {
  org: string;
  repoName: string;
  templateRepo: string;
  isTemplateRepo: boolean;
  courseSlug: string;
  githubUsernames: string[];
  creationMethod: "template" | "fork";
  sourceRepo: string;
  branchProtection: BranchProtectionConfig;
} | null {
  if (strategy.kind !== "create") {
    return null;
  }
  return {
    org: args.org,
    repoName: args.repoName,
    templateRepo: strategy.sourceRepo,
    isTemplateRepo: options.isTemplateRepo ?? false,
    courseSlug: args.courseSlug,
    githubUsernames: args.githubUsernames,
    creationMethod: strategy.creationMethod,
    sourceRepo: strategy.sourceRepo,
    branchProtection: args.branchProtection
  };
}
