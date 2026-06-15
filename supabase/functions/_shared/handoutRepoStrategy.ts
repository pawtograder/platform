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

export { TEMPLATE_HANDOUT_REPO_NAME };
