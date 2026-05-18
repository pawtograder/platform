export const ASYNC_ARCHIVE_REPO_THRESHOLD = 5;

export type GitHubCleanupStrategy = "delete_synchronously" | "archive_asynchronously";
export type GitHubRepoTargetKind = "student" | "template" | "solution";

export type GitHubRepoTarget = {
  kind: GitHubRepoTargetKind;
  fullName: string;
  org: string;
  repo: string;
  sourceId?: number | string | null;
};

export type InvalidGitHubRepoTarget = {
  kind: GitHubRepoTargetKind;
  value: string | null | undefined;
  sourceId?: number | string | null;
  critical: boolean;
  reason: string;
};

export type AssignmentRepositoryRow = {
  id?: number | string | null;
  repository?: string | null;
};

export type CollectGitHubRepoTargetsArgs = {
  repositories?: AssignmentRepositoryRow[] | null;
  templateRepo?: string | null;
  graderRepo?: string | null;
};

export type CollectedGitHubRepoTargets = {
  targets: GitHubRepoTarget[];
  invalidTargets: InvalidGitHubRepoTarget[];
};

export function parseGitHubRepoFullName(value: string | null | undefined): {
  fullName: string;
  org: string;
  repo: string;
} | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split("/");
  if (parts.length !== 2) {
    return null;
  }

  const [org, repo] = parts.map((part) => part.trim());
  if (!org || !repo) {
    return null;
  }

  return {
    fullName: `${org}/${repo}`,
    org,
    repo
  };
}

export function selectGitHubCleanupStrategy(targetCount: number): GitHubCleanupStrategy {
  return targetCount > ASYNC_ARCHIVE_REPO_THRESHOLD ? "archive_asynchronously" : "delete_synchronously";
}

function targetKey(org: string, repo: string) {
  return `${org.toLowerCase()}/${repo.toLowerCase()}`;
}

function addTarget(
  targets: GitHubRepoTarget[],
  seen: Set<string>,
  invalidTargets: InvalidGitHubRepoTarget[],
  kind: GitHubRepoTargetKind,
  value: string | null | undefined,
  sourceId: number | string | null | undefined,
  critical: boolean
) {
  if (!value?.trim()) {
    return;
  }

  const parsed = parseGitHubRepoFullName(value);
  if (!parsed) {
    invalidTargets.push({
      kind,
      value,
      sourceId,
      critical,
      reason: "Repository must be in owner/repo format"
    });
    return;
  }

  const key = targetKey(parsed.org, parsed.repo);
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  targets.push({
    kind,
    sourceId,
    ...parsed
  });
}

export function collectGitHubRepoTargets({
  repositories,
  templateRepo,
  graderRepo
}: CollectGitHubRepoTargetsArgs): CollectedGitHubRepoTargets {
  const targets: GitHubRepoTarget[] = [];
  const invalidTargets: InvalidGitHubRepoTarget[] = [];
  const seen = new Set<string>();

  for (const repository of repositories ?? []) {
    addTarget(targets, seen, invalidTargets, "student", repository.repository, repository.id, false);
  }

  addTarget(targets, seen, invalidTargets, "template", templateRepo, null, true);
  addTarget(targets, seen, invalidTargets, "solution", graderRepo, null, true);

  return { targets, invalidTargets };
}

export function buildAssignmentDeleteArchiveDebugId(
  assignmentId: number,
  target: Pick<GitHubRepoTarget, "kind" | "repo">,
  index: number
) {
  const safeRepoName = target.repo.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
  return `assignment-delete-${assignmentId}-${target.kind}-${index + 1}-${safeRepoName}`;
}
