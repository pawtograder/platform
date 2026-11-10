import type * as Sentry from "npm:@sentry/deno@10.10.0";
import * as github from "./GitHubWrapper.ts";

/**
 * The repository operations the grading loop needs, so a Forgejo implementation (#1092, #1093) can sit
 * beside GitHub's without every caller learning about both (#1090). Signatures are the existing
 * GitHubWrapper ones; Forgejo will need its own owner and usernames, so they will change with it.
 *
 * Single-file reads and listings are not here: every caller reads a staff repository (handout, grader,
 * solution), and those stay on GitHub. Student code is read from the archive `cloneRepository` returns.
 */
export interface GitProvider {
  createRepo: typeof github.createRepo;
  syncRepoPermissions: typeof github.syncRepoPermissions;
  /** Runs the repository's grade.yml at `sha`. */
  startGrading(repository: string, sha: string, scope?: Sentry.Scope): Promise<unknown>;
  cloneRepository: typeof github.cloneRepository;
}

const gitHubProvider: GitProvider = {
  createRepo: github.createRepo,
  syncRepoPermissions: github.syncRepoPermissions,
  startGrading: (repository, sha, scope) => github.triggerWorkflow(repository, sha, "grade.yml", scope),
  cloneRepository: github.cloneRepository
};

/** Every class is on GitHub until Forgejo repositories exist (#1093). */
export function getGitProvider(): GitProvider {
  return gitHubProvider;
}
