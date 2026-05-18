export type CommitStatusForHistory = {
  commit_author?: string | null;
  commit_date?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  conclusion?: string | null;
  submission_id?: number | null;
  requested_at?: string | null;
  workflow_triggered_at?: string | null;
  check_run_marked_in_progress_at?: string | null;
};

export type RepositoryCheckRunForHistory = {
  id: number;
  sha: string;
  created_at: string;
  commit_message: string | null;
  status: unknown;
  triggered_by?: string | null;
};

export type GitHubCommitForHistory = {
  sha: string;
  html_url?: string | null;
  commit: {
    message?: string | null;
    author?: {
      name?: string | null;
      date?: string | null;
    } | null;
    committer?: {
      name?: string | null;
      date?: string | null;
    } | null;
  };
};

export type SubmissionForCommitHistory = {
  id: number;
  sha: string;
  created_at: string;
  is_active?: boolean | null;
  is_not_graded?: boolean | null;
  ordinal?: number | null;
  repository_check_run_id?: number | null;
  grader_results?:
    | {
        score?: number | null;
        max_score?: number | null;
        errors?: unknown;
      }
    | null
    | {
        score?: number | null;
        max_score?: number | null;
        errors?: unknown;
      }[];
};

export type CommitHistoryEntry = {
  sha: string;
  checkRunId: number | null;
  source: "database" | "github" | "database_and_github";
  commitMessage: string;
  author: string | null;
  commitDate: string | null;
  recordedAt: string | null;
  htmlUrl: string | null;
  status: CommitStatusForHistory;
  triggeredBy: string | null;
  submissions: SubmissionForCommitHistory[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCommitStatus(status: unknown): CommitStatusForHistory {
  if (!isRecord(status)) {
    return {};
  }

  return {
    commit_author: typeof status.commit_author === "string" ? status.commit_author : null,
    commit_date: typeof status.commit_date === "string" ? status.commit_date : null,
    created_at: typeof status.created_at === "string" ? status.created_at : null,
    created_by: typeof status.created_by === "string" ? status.created_by : null,
    started_at: typeof status.started_at === "string" ? status.started_at : null,
    completed_at: typeof status.completed_at === "string" ? status.completed_at : null,
    conclusion: typeof status.conclusion === "string" ? status.conclusion : null,
    submission_id: typeof status.submission_id === "number" ? status.submission_id : null,
    requested_at: typeof status.requested_at === "string" ? status.requested_at : null,
    workflow_triggered_at: typeof status.workflow_triggered_at === "string" ? status.workflow_triggered_at : null,
    check_run_marked_in_progress_at:
      typeof status.check_run_marked_in_progress_at === "string" ? status.check_run_marked_in_progress_at : null
  };
}

function parseTime(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function firstLine(message: string | null | undefined): string {
  return (message ?? "").split("\n")[0] || "No commit message";
}

function sortedSubmissions(submissions: SubmissionForCommitHistory[]): SubmissionForCommitHistory[] {
  return [...submissions].sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at));
}

export function mergeCommitHistory({
  checkRuns,
  githubCommits,
  submissions
}: {
  checkRuns: RepositoryCheckRunForHistory[];
  githubCommits: GitHubCommitForHistory[];
  submissions: SubmissionForCommitHistory[];
}): CommitHistoryEntry[] {
  const submissionsBySha = new Map<string, SubmissionForCommitHistory[]>();
  for (const submission of submissions) {
    const list = submissionsBySha.get(submission.sha) ?? [];
    list.push(submission);
    submissionsBySha.set(submission.sha, list);
  }

  const githubBySha = new Map(githubCommits.map((commit) => [commit.sha, commit]));
  const entriesBySha = new Map<string, CommitHistoryEntry>();

  for (const checkRun of checkRuns) {
    const githubCommit = githubBySha.get(checkRun.sha);
    const status = normalizeCommitStatus(checkRun.status);
    const commitDate =
      status.commit_date ?? githubCommit?.commit.author?.date ?? githubCommit?.commit.committer?.date ?? null;
    const author =
      status.commit_author ??
      githubCommit?.commit.author?.name ??
      githubCommit?.commit.committer?.name ??
      status.created_by ??
      null;

    entriesBySha.set(checkRun.sha, {
      sha: checkRun.sha,
      checkRunId: checkRun.id,
      source: githubCommit ? "database_and_github" : "database",
      commitMessage: firstLine(checkRun.commit_message || githubCommit?.commit.message),
      author,
      commitDate,
      recordedAt: checkRun.created_at,
      htmlUrl: githubCommit?.html_url ?? null,
      status,
      triggeredBy: checkRun.triggered_by ?? null,
      submissions: sortedSubmissions(submissionsBySha.get(checkRun.sha) ?? [])
    });
  }

  for (const githubCommit of githubCommits) {
    if (entriesBySha.has(githubCommit.sha)) {
      continue;
    }
    entriesBySha.set(githubCommit.sha, {
      sha: githubCommit.sha,
      checkRunId: null,
      source: "github",
      commitMessage: firstLine(githubCommit.commit.message),
      author: githubCommit.commit.author?.name ?? githubCommit.commit.committer?.name ?? null,
      commitDate: githubCommit.commit.author?.date ?? githubCommit.commit.committer?.date ?? null,
      recordedAt: null,
      htmlUrl: githubCommit.html_url ?? null,
      status: {},
      triggeredBy: null,
      submissions: sortedSubmissions(submissionsBySha.get(githubCommit.sha) ?? [])
    });
  }

  return Array.from(entriesBySha.values()).sort((a, b) => {
    const bTime = Math.max(parseTime(b.commitDate), parseTime(b.recordedAt));
    const aTime = Math.max(parseTime(a.commitDate), parseTime(a.recordedAt));
    if (bTime !== aTime) {
      return bTime - aTime;
    }
    return a.sha.localeCompare(b.sha);
  });
}

export function getCommitHistorySourceLabel(source: CommitHistoryEntry["source"]) {
  if (source === "github") {
    return "From GitHub";
  }
  if (source === "database_and_github") {
    return "Recorded by webhook + GitHub";
  }
  return "Recorded by webhook";
}

export function getSubmissionAutograderLabel(submission: SubmissionForCommitHistory, fallbackMaxScore?: number | null) {
  if (submission.is_not_graded) {
    return "Not for grading";
  }
  const graderResult = Array.isArray(submission.grader_results)
    ? submission.grader_results[0]
    : submission.grader_results;
  if (!graderResult) {
    return "In Progress";
  }
  if (graderResult.errors) {
    return "Error";
  }
  const maxScore = graderResult.max_score ?? fallbackMaxScore;
  return maxScore == null ? `${graderResult.score ?? 0}` : `${graderResult.score ?? 0}/${maxScore}`;
}
