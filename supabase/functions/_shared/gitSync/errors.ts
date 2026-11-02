/**
 * Typed failures for the git-based handout sync (docs/handout-sync-git-worker.md §7).
 *
 * `runGit()` turns a failed git child into one of these, so callers branch on `kind` and
 * `retryable` instead of matching stderr themselves. Matching git's failure text happens in
 * exactly one place (`classifyGitFailure` in runGit.ts), next to the code that captured it.
 *
 * These deliberately do NOT extend `TerminalSyncError` from GitHubSyncHelpers.ts. That module
 * imports octokit-adjacent code, Redis, Sentry and Supabase at load time, and this directory has
 * to stay importable from a plain Deno worker and from unit tests with none of those. The terminal
 * subclass below carries the same `reason` field, so the sync entry point (WP3) bridges with
 * `new TerminalSyncError(err.message, err.reason)` where it catches a `GitSyncTerminalError`.
 */

/**
 * Every failure class this module can report.
 *
 * - `invalid_sync_input`: a repo name, SHA, branch, path or identity failed validation. Nothing was
 *   spawned. Terminal.
 * - `file_too_large`: GitHub refused the push with `GH001` (a file over 100 MB). Terminal.
 * - `lease_rejected`: `--force-with-lease` lost the race, or the server refused the ref update.
 *   Retryable: the next attempt re-reads the branch head.
 * - `unfetchable`: the remote refused to serve a SHA (`not our ref`, unadvertised object). Whether
 *   that is degraded, retryable or terminal depends on which input it was (§5.1, §5.2), so the
 *   engine decides.
 * - `network`: transport failure (`RPC failed`, `early EOF`, DNS, connection resets, HTTP 5xx).
 * - `auth_failed`: the remote refused the credential (HTTP 401 or 403, "Authentication failed").
 *   Retryable, because the usual cause is an expired or under-scoped installation token, but kept
 *   apart from `network` so it shows up on its own in metrics.
 * - `disk_full`: `ENOSPC` while writing objects or the index.
 * - `timeout`: the per-call timeout killed the child.
 * - `deadline_exceeded`: the job's `AbortSignal` fired and killed the child.
 * - `output_cap_exceeded`: stdout or stderr passed its cap and the child was killed.
 * - `remote_repo_not_found`: the remote answered "Repository not found". GitHub says this both
 *   for a missing repo and for one the token cannot see, so it is reported but not made terminal
 *   here. The REST pre-check (§8.4) is where a real 404 becomes terminal.
 * - `git_version_unsupported`: the installed git is older than the engine needs.
 * - `runtime_unsupported`: this Deno does not put a spawned child in its own process group, so a
 *   kill could not reach the helpers git starts (see `assertGitRuntime`).
 * - `spawn_failed`: the child could not be started (git missing, or the cwd is gone).
 * - `git_failed`: a non-zero exit that matched none of the above.
 * - `student_repo_has_no_main`: the student repo has no `refs/heads/main` (it is empty, or its
 *   default branch has another name). Raised by the engine, not by `runGit`. Terminal (§5.2).
 * - `non_utf8_path`: the handout diff names a path that is not valid UTF-8, which cannot pass
 *   through JS strings unchanged. Raised by the engine. Terminal (§5.3).
 * - `reset_check_mismatch`: the branch-safety check approved a different sync-branch head than
 *   the one the push would lease against, so the approval says nothing about the commit the push
 *   would overwrite. Raised by the engine before any push. Retryable: the next attempt re-reads
 *   the head and re-runs the check.
 */
export type GitFailureKind =
  | "invalid_sync_input"
  | "file_too_large"
  | "lease_rejected"
  | "unfetchable"
  | "network"
  | "disk_full"
  | "timeout"
  | "deadline_exceeded"
  | "output_cap_exceeded"
  | "remote_repo_not_found"
  | "auth_failed"
  | "git_version_unsupported"
  | "runtime_unsupported"
  | "spawn_failed"
  | "git_failed"
  | "student_repo_has_no_main"
  | "non_utf8_path"
  | "reset_check_mismatch";

/** Terminal reasons this module can produce. They become `TerminalSyncError.reason` in WP3. */
export type GitTerminalReason = "invalid_sync_input" | "file_too_large" | "student_repo_has_no_main" | "non_utf8_path";

/** Base class for every git sync failure. `retryable` is false only for the terminal subclass. */
export class GitSyncError extends Error {
  constructor(
    message: string,
    readonly kind: GitFailureKind,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "GitSyncError";
  }
}

/**
 * A failure that the next attempt would hit again with the same inputs. The handler records
 * `reason` on the row and does not redeliver.
 */
export class GitSyncTerminalError extends GitSyncError {
  constructor(
    message: string,
    readonly reason: GitTerminalReason,
    /**
     * For `file_too_large`: the path GitHub named, when the remote message included one. For
     * `non_utf8_path`: the offending path, escaped.
     */
    readonly path?: string
  ) {
    super(message, reason, false);
    this.name = "GitSyncTerminalError";
  }
}

/**
 * Validation failure. Thrown before argv is built, so a rejected input never reaches a spawn.
 * The message names the field and quotes the value through `JSON.stringify`, which keeps a
 * hostile value from forging log lines.
 */
export class InvalidSyncInputError extends GitSyncTerminalError {
  constructor(field: string, value: unknown, why: string) {
    super(`invalid ${field} ${safeQuote(value)}: ${why}`, "invalid_sync_input");
    this.name = "InvalidSyncInputError";
  }
}

/** A failure the worker should retry by throwing and letting the message redeliver. */
export class GitSyncRetryableError extends GitSyncError {
  constructor(message: string, kind: Exclude<GitFailureKind, GitTerminalReason | "unfetchable">) {
    super(message, kind, true);
    this.name = "GitSyncRetryableError";
  }
}

/**
 * The remote would not serve a requested object. Marked retryable because that is the safe
 * default for an uncaught one, but the engine is expected to catch it and apply the per-input
 * policy of §5.1 and §5.2 (empty tree for `F`, head of main for `S`, retry then terminal for `H`).
 */
export class GitUnfetchableError extends GitSyncError {
  constructor(message: string) {
    super(message, "unfetchable", true);
    this.name = "GitUnfetchableError";
  }
}

function safeQuote(value: unknown): string {
  if (typeof value !== "string") return `(${typeof value})`;
  const shown = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return JSON.stringify(shown);
}
