/**
 * E2E fixture guard for real GitHub calls.
 *
 * The `pawtograder-playground` org is used both for genuine GitHub integration e2e tests AND for
 * throwaway fixtures that must NEVER touch real GitHub (classes slugged `e2e-ignore-*`, or repos
 * named `test-e2e*`/`e2e-test*`). Historically this "skip real GitHub" decision was duplicated
 * inline in ~5 places inside github-async-worker; several edge functions that call
 * GitHubWrapper.createRepo() directly bypassed it entirely and hit api.github.com for fixtures.
 *
 * This module is the single source of truth. It is intentionally pure and side-effect-free (no
 * Octokit import, cheap to load) so every caller — the worker and the direct-calling edge
 * functions — can share one tested predicate.
 *
 * Note the split: `isE2eFixtureTarget` is env-free (trivially unit-testable);
 * `shouldSkipRealGithubForE2eFixture` layers on the `PAWTOGRADER_GITHUB_STUB` gate. When the stub
 * is active we WANT calls to fall through to the stub seam (which records intent to
 * `e2e_github_calls` and returns a fake SHA) instead of silently skipping — so the stub wins.
 */

export const E2E_FIXTURE_ORG = "pawtograder-playground";

export interface E2eFixtureIdentifiers {
  org: string | null | undefined;
  courseSlug?: string | null;
  repoName?: string | null;
}

/**
 * Pure predicate: does this (org, courseSlug, repoName) identify an e2e fixture whose real GitHub
 * calls must be skipped? Every branch is fenced by the fixture org, so it can never match a real
 * class. The union of prefixes mirrors every current async-worker call site:
 *   - courseSlug `e2e-ignore-*`   (sync_student_team, sync_staff_team, create_repo, sync_permissions)
 *   - repoName   `e2e-ignore-*`   (archive_repo_and_lock matches the repo name, not a slug)
 *   - repoName   `test-e2e*` / `e2e-test*` (create_repo)
 */
export function isE2eFixtureTarget({ org, courseSlug, repoName }: E2eFixtureIdentifiers): boolean {
  if (org !== E2E_FIXTURE_ORG) return false;
  return (
    (courseSlug?.startsWith("e2e-ignore-") ?? false) ||
    (repoName?.startsWith("e2e-ignore-") ?? false) ||
    (repoName?.startsWith("test-e2e") ?? false) ||
    (repoName?.startsWith("e2e-test") ?? false)
  );
}

/**
 * True when a caller should skip real GitHub for this fixture. Returns false when the github stub
 * is enabled so the stub-record seam still runs.
 */
export function shouldSkipRealGithubForE2eFixture(ids: E2eFixtureIdentifiers): boolean {
  if (Deno.env.get("PAWTOGRADER_GITHUB_STUB") === "1") return false;
  return isE2eFixtureTarget(ids);
}
