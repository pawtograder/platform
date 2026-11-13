/**
 * Validators for every caller-supplied string that reaches a git argv, stdin stream or
 * environment variable (docs/handout-sync-git-worker.md §8.1).
 *
 * Each one either returns its input unchanged or throws `InvalidSyncInputError`. They are allow
 * lists, not deny lists: a value is accepted only when it has the one shape the engine needs, so
 * an option (`-x`, `--upload-pack=…`), a transport (`ext::sh -c id`, `file:///etc`) or a
 * traversal (`../x`) fails because it is not a SHA or an `owner/repo`, not because a pattern for
 * it was remembered.
 */
import { InvalidSyncInputError } from "./errors.ts";

/** The empty tree. Used as the old-handout side when `F` is null or unfetchable (§5.1). */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * GitHub's own limits: an owner is 1-39 characters of letters, digits and hyphens, not starting
 * with a hyphen. A repo name is 1-100 characters of letters, digits, `.`, `_` and `-`.
 */
const REPO_FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const SYNC_BRANCH_RE = /^sync-to-[0-9a-f]{7}$/;

/** A local tracking ref the engine may fetch `main` into, such as `refs/remotes/student/main`. */
const TRACKING_REF_RE = /^refs\/remotes\/[a-z][a-z0-9-]{0,31}\/main$/;

/** Blob modes the engine writes into an index. Gitlinks are dropped upstream (§5.3). */
export const INDEX_BLOB_MODES = ["100644", "100755", "120000"] as const;
export type IndexBlobMode = (typeof INDEX_BLOB_MODES)[number];

/** A full lowercase SHA-1. Abbreviations, uppercase and revision syntax are all refused. */
export function validateSha(value: unknown, field = "sha"): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new InvalidSyncInputError(field, value, "must be 40 lowercase hex characters");
  }
  return value;
}

/** `owner/repo` as GitHub spells it. The repo segment may not be `.` or `..`. */
export function validateRepoFullName(value: unknown, field = "repository"): string {
  if (typeof value !== "string" || !REPO_FULL_NAME_RE.test(value)) {
    throw new InvalidSyncInputError(field, value, "must be owner/repo");
  }
  const repo = value.slice(value.indexOf("/") + 1);
  if (repo === "." || repo === "..") {
    throw new InvalidSyncInputError(field, value, "repo segment may not be . or ..");
  }
  return value;
}

/** The only branch the engine ever writes: `sync-to-` plus 7 lowercase hex characters. */
export function validateSyncBranch(value: unknown, field = "branch"): string {
  if (typeof value !== "string" || !SYNC_BRANCH_RE.test(value)) {
    throw new InvalidSyncInputError(field, value, "must be sync-to-<7 lowercase hex>");
  }
  return value;
}

/** Builds the sync branch name from a validated handout SHA, as `sync-to-${H:0:7}` (§5.8). */
export function syncBranchFor(handoutSha: string): string {
  return `sync-to-${validateSha(handoutSha, "handout sha").slice(0, 7)}`;
}

/**
 * The expected current value for `--force-with-lease`. `null` means "the branch must not exist",
 * which git spells as an empty expectation.
 */
export function validateLeaseExpectation(value: unknown, field = "lease expectation"): string | null {
  if (value === null) return null;
  return validateSha(value, field);
}

export function validateTrackingRef(value: unknown, field = "tracking ref"): string {
  if (typeof value !== "string" || !TRACKING_REF_RE.test(value)) {
    throw new InvalidSyncInputError(field, value, "must be refs/remotes/<name>/main");
  }
  return value;
}

/**
 * A repo-relative path written to `update-index --index-info` on stdin. Paths never reach argv,
 * but the stream is NUL-delimited, so a NUL in a path would split one record into two. The other
 * checks repeat what git's own `verify_path` enforces, so a bad path fails here as
 * `invalid_sync_input` instead of as an opaque git exit.
 */
export function validateIndexPath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidSyncInputError(field, value, "must be a non-empty string");
  }
  if (value.includes("\0")) throw new InvalidSyncInputError(field, value, "contains NUL");
  if (value.startsWith("/")) throw new InvalidSyncInputError(field, value, "must be relative");
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new InvalidSyncInputError(field, value, "has an empty, . or .. segment");
    }
    if (segment.toLowerCase() === ".git") {
      throw new InvalidSyncInputError(field, value, "has a .git segment");
    }
  }
  return value;
}

export function validateIndexMode(value: unknown, field = "mode"): IndexBlobMode {
  if (typeof value !== "string" || !(INDEX_BLOB_MODES as readonly string[]).includes(value)) {
    throw new InvalidSyncInputError(field, value, `must be one of ${INDEX_BLOB_MODES.join(", ")}`);
  }
  return value as IndexBlobMode;
}

/**
 * A directory the worker created: the job repo, the template cache, the index file or HOME.
 * These never come from users, so this guards against a programming error that would point git
 * somewhere unexpected, such as a relative path resolved against the process cwd.
 */
export function validateLocalPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new InvalidSyncInputError(field, value, "must be an absolute path");
  }
  if (value.includes("\0") || value.includes("\n")) {
    throw new InvalidSyncInputError(field, value, "contains NUL or newline");
  }
  if (value.split("/").some((s) => s === "..")) {
    throw new InvalidSyncInputError(field, value, "has a .. segment");
  }
  return value;
}

/**
 * A commit identity name or email. Both go into the commit object's header line, where `<`, `>`
 * and newlines would let one value forge another field.
 */
export function validateIdentityPart(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new InvalidSyncInputError(field, value, "must be 1-200 characters");
  }
  if (/[<>\r\n\0]/.test(value)) {
    throw new InvalidSyncInputError(field, value, "may not contain <, >, CR, LF or NUL");
  }
  return value;
}

/**
 * A commit date in git's raw form, `<unix seconds> <+|-HHMM>`, which is how `cat-file commit`
 * prints the handout commit's committer date (§5.7). Accepting only this form keeps git's
 * free-form date parser, and its "now" fallbacks, out of a value that must be deterministic.
 */
export function validateGitDate(value: unknown, field = "date"): string {
  if (typeof value !== "string" || !/^\d{1,12} [+-]\d{4}$/.test(value)) {
    throw new InvalidSyncInputError(field, value, "must be '<unix seconds> <+|-HHMM>'");
  }
  return value;
}

/**
 * A GitHub token. It is placed in an HTTP header through `GIT_CONFIG_VALUE_0`, so whitespace or a
 * line break would let it inject a second header. The value is never echoed into the error.
 */
export function validateToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,512}$/.test(value)) {
    throw new InvalidSyncInputError("token", "(redacted)", "has unexpected characters or length");
  }
  return value;
}
