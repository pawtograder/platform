/**
 * @jest-environment node
 */

import {
  TEMPLATE_HANDOUT_REPO_NAME,
  resolveHandoutRepoAction,
  type HandoutSourceAssignment
} from "../../supabase/functions/_shared/handoutRepoStrategy";

const baseAssignment = {
  id: 42,
  class_id: 7,
  repo_mode: "template_only_staff" as const,
  source_assignment_id: null as number | null
};

describe("resolveHandoutRepoAction", () => {
  it("returns noop for repo_mode='none'", () => {
    expect(resolveHandoutRepoAction({ ...baseAssignment, repo_mode: "none" }, null)).toEqual({ kind: "noop" });
  });

  it("creates a template-flagged staff-only handout for the default mode", () => {
    expect(resolveHandoutRepoAction(baseAssignment, null)).toEqual({
      kind: "create",
      isTemplateRepo: true,
      sourceRepo: TEMPLATE_HANDOUT_REPO_NAME,
      studentTeamPermission: null
    });
  });

  it("creates a NON-template handout with student READ access for mode 2", () => {
    expect(resolveHandoutRepoAction({ ...baseAssignment, repo_mode: "template_with_student_forks" }, null)).toEqual({
      kind: "create",
      isTemplateRepo: false,
      sourceRepo: TEMPLATE_HANDOUT_REPO_NAME,
      studentTeamPermission: "pull"
    });
  });

  describe("fork_from_prior_assignment", () => {
    const mode3 = {
      ...baseAssignment,
      repo_mode: "fork_from_prior_assignment" as const,
      source_assignment_id: 100
    };
    const source: HandoutSourceAssignment = {
      id: 100,
      class_id: 7,
      template_repo: "course-org/cs101-handout-hw1",
      latest_template_sha: "abc1234"
    };

    it("inherits from the source assignment when configured correctly", () => {
      expect(resolveHandoutRepoAction(mode3, source)).toEqual({
        kind: "inherit_from_source",
        sourceAssignmentId: 100
      });
    });

    it("throws when source_assignment_id is null", () => {
      expect(() => resolveHandoutRepoAction({ ...mode3, source_assignment_id: null }, null)).toThrow(
        /source_assignment_id is null/
      );
    });

    it("throws when source assignment was not found", () => {
      expect(() => resolveHandoutRepoAction(mode3, null)).toThrow(/was not found/);
    });

    it("throws when source assignment is in a different class", () => {
      expect(() => resolveHandoutRepoAction(mode3, { ...source, class_id: 999 })).toThrow(/cannot fork from/);
    });

    it("throws when source assignment has no template_repo to inherit", () => {
      expect(() => resolveHandoutRepoAction(mode3, { ...source, template_repo: null })).toThrow(/no template_repo/);
    });
  });
});
