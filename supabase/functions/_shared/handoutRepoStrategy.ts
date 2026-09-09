// Pure helpers that describe what `assignment-create-handout-repo` should do
// for each repo_mode. Extracted so the dispatcher can be unit-tested without
// mocking GitHub.

import type { AssignmentForRepoCreation, AssignmentRepoMode } from "./repoCreationStrategy.ts";

const TEMPLATE_HANDOUT_REPO_NAME = "pawtograder/template-assignment-handout";

export type HandoutRepoAction =
  | {
      kind: "create";
      isTemplateRepo: boolean;
      sourceRepo: string;
      /**
       * `null` means staff team only (current behavior). `"pull"` grants the
       * `<slug>-students` team READ access — used for
       * template_with_student_forks where the handout is the upstream students
       * fork from.
       */
      studentTeamPermission: "pull" | null;
    }
  | {
      kind: "inherit_from_source";
      sourceAssignmentId: number;
    }
  | { kind: "noop" };

export type HandoutSourceAssignment = {
  id: number;
  class_id: number;
  template_repo: string | null;
  latest_template_sha?: string | null;
};

/**
 * Decide what (if anything) `assignment-create-handout-repo` should do for an
 * assignment based on its repo_mode. For `fork_from_prior_assignment` the
 * caller must additionally pass the source assignment row (to validate it's in
 * the same class and to copy its template_repo onto this assignment so the
 * handout-history UI keeps working).
 */
export function resolveHandoutRepoAction(
  assignment: Pick<AssignmentForRepoCreation, "id" | "repo_mode" | "source_assignment_id"> & {
    class_id: number;
  },
  source: HandoutSourceAssignment | null
): HandoutRepoAction {
  const mode: AssignmentRepoMode = assignment.repo_mode;
  // 'none' (upload) and 'no_submission' (no artifact) both opt out of any
  // handout repo on GitHub.
  if (mode === "none" || mode === "no_submission") {
    return { kind: "noop" };
  }
  if (mode === "template_only_staff") {
    return {
      kind: "create",
      isTemplateRepo: true,
      sourceRepo: TEMPLATE_HANDOUT_REPO_NAME,
      studentTeamPermission: null
    };
  }
  if (mode === "template_with_student_forks") {
    return {
      kind: "create",
      isTemplateRepo: false,
      sourceRepo: TEMPLATE_HANDOUT_REPO_NAME,
      studentTeamPermission: "pull"
    };
  }
  // mode === "fork_from_prior_assignment"
  if (!assignment.source_assignment_id) {
    throw new Error(
      `Assignment ${assignment.id} repo_mode=fork_from_prior_assignment but source_assignment_id is null`
    );
  }
  if (!source) {
    throw new Error(
      `Assignment ${assignment.id} references source assignment ${assignment.source_assignment_id} but it was not found`
    );
  }
  if (source.class_id !== assignment.class_id) {
    throw new Error(
      `Assignment ${assignment.id} (class ${assignment.class_id}) cannot fork from assignment ${source.id} (class ${source.class_id})`
    );
  }
  if (!source.template_repo) {
    throw new Error(`Source assignment ${source.id} has no template_repo to inherit from`);
  }
  return { kind: "inherit_from_source", sourceAssignmentId: source.id };
}

/**
 * repo_modes that opt out of GitHub repos entirely. `assignment-create-handout-repo` actively
 * CLEARS template_repo for these, so a NULL pointer on one of them is the correct state, not a
 * failure to be repaired.
 */
const REPO_MODES_WITHOUT_REPOS: readonly AssignmentRepoMode[] = ["none", "no_submission"];

/**
 * Should this assignment have BOTH a handout and a solution ("grader") repo?
 *
 * repo_mode is the only input. The new-assignment page gates its two creation calls on exactly
 * this condition and nothing else, so `has_autograder` and `submission_mode` deliberately do NOT
 * narrow it:
 *
 *   - A repo-only assignment (has_autograder = false) still gets a handout — grade.yml is stripped
 *     from it, not the repo skipped — and still needs pawtograder.yml read out of a solution repo,
 *     because that is where `submissionFiles` comes from and the empty-submission check depends on
 *     it whether or not an autograder ever runs.
 *   - PR submission mode forces has_autograder off, and the same reasoning applies.
 *   - `fork_from_prior_assignment` INHERITS its handout from the source assignment rather than
 *     creating one, but template_repo is still expected to be non-NULL, so it still answers true
 *     here. It gets its own solution repo normally.
 *
 * Exported so the repo reconciler decides "should this pointer be non-NULL?" from the same place
 * `resolveHandoutRepoAction` decides what to create, rather than restating the matrix in a SQL
 * filter that can drift away from it.
 */
export function assignmentShouldHaveRepos(mode: AssignmentRepoMode): boolean {
  return !REPO_MODES_WITHOUT_REPOS.includes(mode);
}

/**
 * What `assignment-create-handout-repo` would leave in `assignments.template_repo` for this
 * assignment, or null when that cannot be determined.
 *
 * The reconciler uses this to tell "the handout run never finished" from "an instructor chose a
 * custom handout" — the first is safe to rerun, the second must be left alone because the create
 * function rebuilds the pointer and would erase their choice.
 *
 * It exists because that test is NOT simply the derived `<class>-handout-<assignment>` name.
 * `fork_from_prior_assignment` creates no handout at all; it mirrors the source assignment's
 * pointer, which can never equal the derived name. Comparing every mode against the derived name
 * therefore reported every inherited handout as custom, so an inherit that wrote its pointer and
 * then died before recording its workflow hash got solution creation only — publishing grader_repo,
 * dropping the assignment out of the repair scan for good, and leaving every student submission
 * rejected for a workflow-SHA mismatch.
 *
 * Lives next to `resolveHandoutRepoAction` so the two cannot drift: this must answer for the
 * pointer whatever that decides to create.
 */
export function expectedHandoutRepo(args: {
  mode: AssignmentRepoMode;
  githubOrg: string | null | undefined;
  classSlug: string | null | undefined;
  assignmentSlug: string | null | undefined;
  /** The fork source's `template_repo`. Only consulted for `fork_from_prior_assignment`. */
  sourceTemplateRepo: string | null;
}): string | null {
  if (REPO_MODES_WITHOUT_REPOS.includes(args.mode)) return null;
  if (args.mode === "fork_from_prior_assignment") return args.sourceTemplateRepo;
  if (!args.githubOrg || !args.classSlug || !args.assignmentSlug) return null;
  return `${args.githubOrg}/${args.classSlug}-handout-${args.assignmentSlug}`;
}

export { REPO_MODES_WITHOUT_REPOS, TEMPLATE_HANDOUT_REPO_NAME };
