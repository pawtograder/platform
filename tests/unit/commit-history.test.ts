import {
  getCommitHistorySourceLabel,
  getSubmissionAutograderLabel,
  mergeCommitHistory,
  RepositoryCheckRunForHistory,
  SubmissionForCommitHistory
} from "@/lib/commitHistory";

const checkRun = (overrides: Partial<RepositoryCheckRunForHistory>): RepositoryCheckRunForHistory => ({
  id: 1,
  sha: "aaa111",
  created_at: "2026-01-01T00:00:00.000Z",
  commit_message: "DB message",
  status: {
    commit_author: "DB Author",
    commit_date: "2026-01-01T00:00:00.000Z"
  },
  ...overrides
});

const submission = (overrides: Partial<SubmissionForCommitHistory>): SubmissionForCommitHistory => ({
  id: 10,
  sha: "aaa111",
  created_at: "2026-01-01T00:05:00.000Z",
  is_active: false,
  ordinal: 1,
  repository_check_run_id: 1,
  ...overrides
});

describe("commit history helpers", () => {
  it("sorts DB-only commits by commit date", () => {
    const entries = mergeCommitHistory({
      checkRuns: [
        checkRun({ id: 1, sha: "older", status: { commit_date: "2026-01-01T00:00:00.000Z" } }),
        checkRun({ id: 2, sha: "newer", status: { commit_date: "2026-01-02T00:00:00.000Z" } })
      ],
      githubCommits: [],
      submissions: []
    });

    expect(entries.map((entry) => entry.sha)).toEqual(["newer", "older"]);
    expect(entries[0].source).toBe("database");
  });

  it("includes GitHub-only commits", () => {
    const entries = mergeCommitHistory({
      checkRuns: [],
      githubCommits: [
        {
          sha: "github-only",
          html_url: "https://github.example/commit/github-only",
          commit: {
            message: "GitHub message\n\nbody",
            author: { name: "GitHub Author", date: "2026-01-03T00:00:00.000Z" }
          }
        }
      ],
      submissions: []
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sha: "github-only",
      source: "github",
      commitMessage: "GitHub message",
      author: "GitHub Author",
      commitDate: "2026-01-03T00:00:00.000Z"
    });
  });

  it("merges matching DB and GitHub commits while preserving DB status", () => {
    const entries = mergeCommitHistory({
      checkRuns: [
        checkRun({
          sha: "same",
          commit_message: "DB wins",
          status: {
            commit_author: "DB Author",
            commit_date: "2026-01-04T00:00:00.000Z",
            workflow_triggered_at: "2026-01-04T00:01:00.000Z"
          }
        })
      ],
      githubCommits: [
        {
          sha: "same",
          html_url: "https://github.example/commit/same",
          commit: {
            message: "GitHub message",
            author: { name: "GitHub Author", date: "2026-01-03T00:00:00.000Z" }
          }
        }
      ],
      submissions: []
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "database_and_github",
      commitMessage: "DB wins",
      author: "DB Author",
      commitDate: "2026-01-04T00:00:00.000Z",
      htmlUrl: "https://github.example/commit/same"
    });
    expect(entries[0].status.workflow_triggered_at).toBe("2026-01-04T00:01:00.000Z");
  });

  it("attaches multiple submissions for one commit newest first", () => {
    const entries = mergeCommitHistory({
      checkRuns: [checkRun({ sha: "aaa111" })],
      githubCommits: [],
      submissions: [
        submission({ id: 1, sha: "aaa111", created_at: "2026-01-01T00:01:00.000Z" }),
        submission({ id: 2, sha: "aaa111", created_at: "2026-01-01T00:02:00.000Z" })
      ]
    });

    expect(entries[0].submissions.map((s) => s.id)).toEqual([2, 1]);
  });

  it("falls back to recorded date when commit date is invalid", () => {
    const entries = mergeCommitHistory({
      checkRuns: [
        checkRun({
          sha: "invalid-date",
          created_at: "2026-01-05T00:00:00.000Z",
          status: { commit_date: "not a date" }
        }),
        checkRun({
          sha: "valid-older",
          created_at: "2026-01-04T00:00:00.000Z",
          status: { commit_date: "2026-01-04T00:00:00.000Z" }
        })
      ],
      githubCommits: [],
      submissions: []
    });

    expect(entries.map((entry) => entry.sha)).toEqual(["invalid-date", "valid-older"]);
  });

  it("formats source and submission status labels", () => {
    expect(getCommitHistorySourceLabel("github")).toBe("From GitHub");
    expect(getCommitHistorySourceLabel("database")).toBe("Recorded by webhook");
    expect(getCommitHistorySourceLabel("database_and_github")).toBe("Recorded by webhook + GitHub");
    expect(
      getSubmissionAutograderLabel(
        submission({
          grader_results: { score: 8, max_score: null, errors: null }
        }),
        10
      )
    ).toBe("8/10");
    expect(getSubmissionAutograderLabel(submission({ is_not_graded: true }))).toBe("Not for grading");
  });
});
