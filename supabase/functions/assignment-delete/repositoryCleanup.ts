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

/**
 * GitHub owner and repository names use only these characters. Requiring them (rather than
 * "anything non-empty") is what lets delete_assignment_with_all_data parse names identically
 * in SQL: both sides trim ASCII spaces only and reject everything else unusual, so a value
 * holding a tab or a non-breaking space is invalid in both places instead of normalised by
 * JavaScript's trim() here and kept verbatim (or dropped) there.
 */
const GITHUB_NAME_PART = /^[A-Za-z0-9._-]+$/;

/** Strips leading/trailing ASCII spaces, matching SQL btrim(value, ' '). */
function trimSpaces(value: string) {
  return value.replace(/^ +| +$/g, "");
}

export function parseGitHubRepoFullName(value: string | null | undefined): {
  fullName: string;
  org: string;
  repo: string;
} | null {
  const trimmed = value == null ? "" : trimSpaces(value);
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split("/");
  if (parts.length !== 2) {
    return null;
  }

  const [org, repo] = parts.map(trimSpaces);
  if (!GITHUB_NAME_PART.test(org) || !GITHUB_NAME_PART.test(repo)) {
    return null;
  }

  return {
    fullName: `${org}/${repo}`,
    org,
    repo
  };
}

/**
 * The rule both hosts' delete preflights use to tell a student repo with work in it from one generated from the
 * handout. `shasNewestFirst` is the newest page of its default branch. A repo with more than one commit holds
 * student work unless its oldest commit is the handout's oldest or the handout commit last synced into it.
 */
export function hasOnlyHandoutCommits(
  shasNewestFirst: readonly string[],
  handoutOldestSha: string | null | undefined,
  syncedHandoutSha: string | null | undefined
): boolean {
  if (shasNewestFirst.length <= 1) return true;
  const oldest = shasNewestFirst[shasNewestFirst.length - 1];
  return oldest === handoutOldestSha || oldest === syncedHandoutSha;
}

export function modifiedRepositoryMessage(repository: string): string {
  return (
    `Cannot delete assignment: Repository ${repository} has been modified beyond the template. ` +
    `Please manually delete modified repositories if you want to proceed.`
  );
}

export function selectGitHubCleanupStrategy(targetCount: number): GitHubCleanupStrategy {
  return targetCount > ASYNC_ARCHIVE_REPO_THRESHOLD ? "archive_asynchronously" : "delete_synchronously";
}

/**
 * The strategy for what the delete RPC reported: GitHub and Forgejo repositories share one budget, so a
 * mixed assignment is counted across both hosts.
 */
export function selectCleanupStrategyForDeleted(deleteResult: {
  github_repositories?: unknown;
  forgejo_repositories?: unknown;
}): { strategy: GitHubCleanupStrategy; github: GitHubRepoTarget[]; forgejo: GitHubRepoTarget[] } {
  const github = parseDeletedGitHubRepositories(deleteResult.github_repositories);
  const forgejo = parseDeletedGitHubRepositories(deleteResult.forgejo_repositories);
  return { strategy: selectGitHubCleanupStrategy(github.length + forgejo.length), github, forgejo };
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

/**
 * The `github_repositories` that delete_assignment_with_all_data reports it removed, as
 * targets. The RPC already validated and deduplicated them; anything that does not parse
 * here is dropped rather than trusted, since these names go straight into DELETE calls.
 */
export function parseDeletedGitHubRepositories(value: unknown): GitHubRepoTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const targets: GitHubRepoTarget[] = [];
  for (const entry of value as { kind?: unknown; full_name?: unknown }[]) {
    const kind = entry?.kind;
    if (kind !== "student" && kind !== "template" && kind !== "solution") {
      continue;
    }
    const parsed = parseGitHubRepoFullName(typeof entry.full_name === "string" ? entry.full_name : null);
    if (parsed) {
      targets.push({ kind, ...parsed });
    }
  }
  return targets;
}

/** Must stay in step with the format() in delete_assignment_with_all_data, which builds the same ids. */
export function buildAssignmentDeleteArchiveDebugId(
  assignmentId: number,
  target: Pick<GitHubRepoTarget, "kind" | "repo">,
  index: number
) {
  const safeRepoName = target.repo.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
  return `assignment-delete-${assignmentId}-${target.kind}-${index + 1}-${safeRepoName}`;
}
