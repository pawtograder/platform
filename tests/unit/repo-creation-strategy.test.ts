/**
 * @jest-environment node
 */

import {
  buildCreateRepoArgs,
  resolveRepoCreationStrategy,
  type AssignmentForRepoCreation,
  type SourceRepoRow
} from "@/supabase/functions/_shared/repoCreationStrategy";
import { DEFAULT_BRANCH_PROTECTION } from "@/supabase/functions/_shared/branchProtection";

const baseAssignment: AssignmentForRepoCreation = {
  id: 42,
  repo_mode: "template_only_staff",
  template_repo: "course-org/cs101-handout-hw1",
  source_assignment_id: null
};

describe("resolveRepoCreationStrategy", () => {
  it("skips entirely for repo_mode='none'", () => {
    const result = resolveRepoCreationStrategy(
      { ...baseAssignment, repo_mode: "none", template_repo: null },
      { profile_id: "p-1" }
    );
    expect(result).toEqual({ kind: "skip", reason: "no_repo_mode" });
  });

  it("skips entirely for repo_mode='no_submission'", () => {
    const result = resolveRepoCreationStrategy(
      { ...baseAssignment, repo_mode: "no_submission", template_repo: null },
      { profile_id: "p-1" }
    );
    expect(result).toEqual({ kind: "skip", reason: "no_repo_mode" });
  });

  it("creates via template for the default mode", () => {
    const result = resolveRepoCreationStrategy(baseAssignment, { profile_id: "p-1" });
    expect(result).toEqual({
      kind: "create",
      creationMethod: "template",
      sourceRepo: "course-org/cs101-handout-hw1"
    });
  });

  it("creates via fork when students get forks of the handout", () => {
    const result = resolveRepoCreationStrategy(
      { ...baseAssignment, repo_mode: "template_with_student_forks" },
      { profile_id: "p-1" }
    );
    expect(result).toEqual({
      kind: "create",
      creationMethod: "fork",
      sourceRepo: "course-org/cs101-handout-hw1"
    });
  });

  it("surfaces missing template_repo as an actionable skip in mode 1", () => {
    const result = resolveRepoCreationStrategy({ ...baseAssignment, template_repo: null }, { profile_id: "p-1" });
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.reason).toBe("missing_source");
    }
  });

  it("surfaces missing template_repo as an actionable skip in mode 2", () => {
    const result = resolveRepoCreationStrategy(
      { ...baseAssignment, repo_mode: "template_with_student_forks", template_repo: null },
      { profile_id: "p-1" }
    );
    expect(result.kind).toBe("skip");
    if (result.kind === "skip" && result.reason === "missing_source") {
      expect(result.error).toMatch(/student forks/);
    }
  });

  describe("fork_from_prior_assignment (mode 3)", () => {
    const mode3: AssignmentForRepoCreation = {
      ...baseAssignment,
      repo_mode: "fork_from_prior_assignment",
      template_repo: null,
      source_assignment_id: 100
    };

    const sourceRepos: SourceRepoRow[] = [
      { repository: "course-org/cs101-hw1-alice", profile_id: "p-alice" },
      { repository: "course-org/cs101-hw1-bob", profile_id: "p-bob" },
      { repository: "course-org/cs101-hw1-group-redteam", assignment_group_id: 7, group_name: "redteam" }
    ];

    it("resolves an individual student's fork source by profile_id", () => {
      const result = resolveRepoCreationStrategy(mode3, { profile_id: "p-alice" }, sourceRepos);
      expect(result).toEqual({
        kind: "create",
        creationMethod: "fork",
        sourceRepo: "course-org/cs101-hw1-alice"
      });
    });

    it("resolves a group fork source by group name", () => {
      const result = resolveRepoCreationStrategy(
        mode3,
        { assignment_group_id: 12, group_name: "redteam" },
        sourceRepos
      );
      expect(result).toEqual({
        kind: "create",
        creationMethod: "fork",
        sourceRepo: "course-org/cs101-hw1-group-redteam"
      });
    });

    it("falls back to matching by assignment_group_id when group name is missing", () => {
      const result = resolveRepoCreationStrategy(mode3, { assignment_group_id: 7 }, sourceRepos);
      expect(result).toEqual({
        kind: "create",
        creationMethod: "fork",
        sourceRepo: "course-org/cs101-hw1-group-redteam"
      });
    });

    it("skips with a useful error message when the source repo is missing", () => {
      const result = resolveRepoCreationStrategy(
        mode3,
        { profile_id: "p-nobody", display_name: "Nobody" },
        sourceRepos
      );
      expect(result.kind).toBe("skip");
      if (result.kind === "skip" && result.reason === "missing_source") {
        expect(result.error).toMatch(/Nobody/);
        expect(result.error).toMatch(/assignment 100/);
      }
    });

    it("skips when source_assignment_id is missing entirely", () => {
      const result = resolveRepoCreationStrategy(
        { ...mode3, source_assignment_id: null },
        { profile_id: "p-alice" },
        sourceRepos
      );
      expect(result.kind).toBe("skip");
      if (result.kind === "skip") {
        expect(result.reason).toBe("missing_source");
      }
    });
  });
});

describe("buildCreateRepoArgs", () => {
  it("returns null for a skip strategy", () => {
    expect(
      buildCreateRepoArgs(
        {
          org: "course-org",
          repoName: "cs101-hw2-alice",
          courseSlug: "cs101",
          githubUsernames: ["alice"],
          branchProtection: DEFAULT_BRANCH_PROTECTION
        },
        { kind: "skip", reason: "no_repo_mode" }
      )
    ).toBeNull();
  });

  it("packages the strategy's source/method into the async-worker envelope", () => {
    const payload = buildCreateRepoArgs(
      {
        org: "course-org",
        repoName: "cs101-hw2-alice",
        courseSlug: "cs101",
        githubUsernames: ["alice"],
        branchProtection: { blockForcePush: true, requirePullRequest: false, requiredReviewers: 0 }
      },
      {
        kind: "create",
        creationMethod: "fork",
        sourceRepo: "course-org/cs101-hw1-alice"
      }
    );
    expect(payload).toEqual({
      org: "course-org",
      repoName: "cs101-hw2-alice",
      templateRepo: "course-org/cs101-hw1-alice",
      isTemplateRepo: false,
      courseSlug: "cs101",
      githubUsernames: ["alice"],
      creationMethod: "fork",
      sourceRepo: "course-org/cs101-hw1-alice",
      branchProtection: { blockForcePush: true, requirePullRequest: false, requiredReviewers: 0 }
    });
  });

  it("respects isTemplateRepo override (used by the handout-repo flow)", () => {
    const payload = buildCreateRepoArgs(
      {
        org: "course-org",
        repoName: "cs101-handout-hw1",
        courseSlug: "cs101",
        githubUsernames: [],
        branchProtection: DEFAULT_BRANCH_PROTECTION
      },
      {
        kind: "create",
        creationMethod: "template",
        sourceRepo: "pawtograder/template-assignment-handout"
      },
      { isTemplateRepo: true }
    );
    expect(payload?.isTemplateRepo).toBe(true);
  });
});
