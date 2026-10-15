/**
 * @jest-environment node
 */

import {
  ASYNC_ARCHIVE_REPO_THRESHOLD,
  buildAssignmentDeleteArchiveDebugId,
  collectGitHubRepoTargets,
  parseDeletedGitHubRepositories,
  parseGitHubRepoFullName,
  selectGitHubCleanupStrategy
} from "../../supabase/functions/assignment-delete/repositoryCleanup";

describe("assignment-delete repository cleanup helpers", () => {
  describe("selectGitHubCleanupStrategy", () => {
    it("uses synchronous deletion for at most the async archival threshold", () => {
      expect(selectGitHubCleanupStrategy(0)).toBe("delete_synchronously");
      expect(selectGitHubCleanupStrategy(1)).toBe("delete_synchronously");
      expect(selectGitHubCleanupStrategy(ASYNC_ARCHIVE_REPO_THRESHOLD)).toBe("delete_synchronously");
    });

    it("uses asynchronous archival above the threshold", () => {
      expect(selectGitHubCleanupStrategy(ASYNC_ARCHIVE_REPO_THRESHOLD + 1)).toBe("archive_asynchronously");
    });
  });

  describe("parseGitHubRepoFullName", () => {
    it("parses valid owner/repo names", () => {
      expect(parseGitHubRepoFullName(" pawtograder-playground/example-repo ")).toEqual({
        fullName: "pawtograder-playground/example-repo",
        org: "pawtograder-playground",
        repo: "example-repo"
      });
    });

    it("rejects empty and malformed names", () => {
      expect(parseGitHubRepoFullName(null)).toBeNull();
      expect(parseGitHubRepoFullName("")).toBeNull();
      expect(parseGitHubRepoFullName("owner")).toBeNull();
      expect(parseGitHubRepoFullName("owner/")).toBeNull();
      expect(parseGitHubRepoFullName("/repo")).toBeNull();
      expect(parseGitHubRepoFullName("owner/repo/extra")).toBeNull();
    });
  });

  describe("collectGitHubRepoTargets", () => {
    it("collects student, template, and solution repositories", () => {
      const result = collectGitHubRepoTargets({
        repositories: [
          { id: 1, repository: "org/student-1" },
          { id: 2, repository: "org/student-2" }
        ],
        templateRepo: "org/template",
        graderRepo: "org/solution"
      });

      expect(result.invalidTargets).toEqual([]);
      expect(result.targets.map((target) => `${target.kind}:${target.fullName}`)).toEqual([
        "student:org/student-1",
        "student:org/student-2",
        "template:org/template",
        "solution:org/solution"
      ]);
    });

    it("deduplicates repository targets case-insensitively", () => {
      const result = collectGitHubRepoTargets({
        repositories: [
          { id: 1, repository: "Org/shared" },
          { id: 2, repository: "org/SHARED" }
        ],
        templateRepo: "org/shared",
        graderRepo: "org/solution"
      });

      expect(result.targets.map((target) => target.fullName)).toEqual(["Org/shared", "org/solution"]);
    });

    it("reports invalid student rows as non-critical and invalid template/solution rows as critical", () => {
      const result = collectGitHubRepoTargets({
        repositories: [
          { id: 1, repository: "org/valid-student" },
          { id: 2, repository: "not-a-full-name" }
        ],
        templateRepo: "bad-template",
        graderRepo: "bad/solution/extra"
      });

      expect(result.targets.map((target) => target.fullName)).toEqual(["org/valid-student"]);
      expect(result.invalidTargets).toEqual([
        expect.objectContaining({ kind: "student", sourceId: 2, critical: false }),
        expect.objectContaining({ kind: "template", critical: true }),
        expect.objectContaining({ kind: "solution", critical: true })
      ]);
    });

    it("ignores empty optional repository values", () => {
      const result = collectGitHubRepoTargets({
        repositories: [{ id: 1, repository: null }],
        templateRepo: "",
        graderRepo: undefined
      });

      expect(result.targets).toEqual([]);
      expect(result.invalidTargets).toEqual([]);
    });
  });

  describe("buildAssignmentDeleteArchiveDebugId", () => {
    it("includes assignment id, target kind, index, and sanitized repo name", () => {
      expect(
        buildAssignmentDeleteArchiveDebugId(
          449,
          {
            kind: "student",
            repo: "repo with spaces"
          },
          2
        )
      ).toBe("assignment-delete-449-student-3-repo-with-spaces");
    });
  });

  describe("parseDeletedGitHubRepositories", () => {
    it("turns the RPC's github_repositories into targets, in order", () => {
      expect(
        parseDeletedGitHubRepositories([
          { kind: "student", full_name: "Org/student-1" },
          { kind: "template", full_name: "Org/handout" },
          { kind: "solution", full_name: "org/solution" }
        ])
      ).toEqual([
        { kind: "student", fullName: "Org/student-1", org: "Org", repo: "student-1" },
        { kind: "template", fullName: "Org/handout", org: "Org", repo: "handout" },
        { kind: "solution", fullName: "org/solution", org: "org", repo: "solution" }
      ]);
    });

    it("drops entries with an unknown kind or a malformed name rather than trusting them", () => {
      expect(
        parseDeletedGitHubRepositories([
          { kind: "student", full_name: "not-a-repo" },
          { kind: "student", full_name: "a/b/c" },
          { kind: "fork", full_name: "Org/x" },
          { kind: "student", full_name: 42 },
          null,
          { kind: "student", full_name: "Org/ok" }
        ])
      ).toEqual([{ kind: "student", fullName: "Org/ok", org: "Org", repo: "ok" }]);
    });

    it("returns no targets for a missing or non-array result (e.g. an RPC from before the field existed)", () => {
      expect(parseDeletedGitHubRepositories(undefined)).toEqual([]);
      expect(parseDeletedGitHubRepositories({ kind: "student", full_name: "Org/x" })).toEqual([]);
    });
  });
});
