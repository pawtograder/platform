import type * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  forgejoConfig,
  getRepoFile,
  listRepoFiles,
  startGrading as startForgejoGrading,
  writeRepoFile
} from "./ForgejoWrapper.ts";
import type { FileListing } from "./FunctionTypes.d.ts";
import * as github from "./GitHubWrapper.ts";

/**
 * The repository operations the grading loop needs, so a Forgejo implementation (#1092, #1093) can sit
 * beside GitHub's without every caller learning about both (#1090). Signatures are the existing
 * GitHubWrapper ones; Forgejo will need its own owner and usernames, so they will change with it.
 *
 * Single-file reads, listings and writes for staff tools are `repoFilesOn` below. Student code is read from
 * the archive `cloneRepository` returns.
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

/** GitHub's. Forgejo repositories (#1093) call ForgejoWrapper directly, or `startGradingOn` below. */
export function getGitProvider(): GitProvider {
  return gitHubProvider;
}

/**
 * Runs grade.yml at `sha` on the repository's own host: a Forgejo repository tags the commit and dispatches
 * through Forgejo's API (#1257), as autograder-trigger-grading-workflow does for a single rerun.
 */
export async function startGradingOn(
  gitProvider: string | null | undefined,
  repository: string,
  sha: string,
  scope?: Sentry.Scope
): Promise<void> {
  if (gitProvider !== "forgejo") {
    await getGitProvider().startGrading(repository, sha, scope);
    return;
  }
  const config = forgejoConfig();
  if (!config) throw new Error("Forgejo grading isn't configured on this deployment");
  await startForgejoGrading(config, repository, sha);
}

/**
 * The file operations behind repository-get-file, -list-files and -write-file. Errors a caller acts on carry a
 * numeric `status`, on both hosts: 404 for a missing file, and 409 or 422 for a stale or racing write.
 */
export interface RepoFiles {
  getFile(repository: string, path: string, scope?: Sentry.Scope): Promise<{ content: string; sha?: string }>;
  listFiles(org: string, repo: string, scope?: Sentry.Scope): Promise<FileListing[]>;
  writeFile(
    repository: string,
    path: string,
    content: string,
    message: string,
    sha?: string,
    scope?: Sentry.Scope
  ): Promise<{ commit_sha?: string; content_sha?: string }>;
}

/** Thrown by repoFilesOn("forgejo") on a deployment without the Forgejo settings. */
export class ForgejoNotConfiguredError extends Error {
  constructor() {
    super("Forgejo is not set up on this deployment");
    this.name = "ForgejoNotConfiguredError";
  }
}

const gitHubFiles: RepoFiles = {
  getFile: (repository, path, scope) => github.getFileFromRepo(repository, path, scope),
  listFiles: (org, repo, scope) => github.listFilesInRepo(org, repo, scope),
  writeFile: (repository, path, content, message, sha, scope) =>
    github.writeFileToRepo(repository, path, content, message, sha, scope)
};

/** The file operations on a repository's own host. */
export function repoFilesOn(gitProvider: "github" | "forgejo"): RepoFiles {
  if (gitProvider === "github") return gitHubFiles;
  const config = forgejoConfig();
  if (!config) throw new ForgejoNotConfiguredError();
  return {
    getFile: (repository, path) => getRepoFile(config, repository, path),
    listFiles: (org, repo) => listRepoFiles(config, `${org}/${repo}`),
    writeFile: (repository, path, content, message, sha) =>
      writeRepoFile(config, repository, path, content, message, sha)
  };
}
