/**
 * `runGit()`: the only code path in the handout-sync worker that spawns git
 * (docs/handout-sync-git-worker.md §8.6).
 *
 * Repo names, SHAs and file contents in a sync all come from instructors or students, and git
 * can run commands without ever checking out a working tree: a transport such as `ext::`, an
 * option smuggled in as a positional (`--upload-pack=…`), a hook, a config file the worker did
 * not write, or an attribute that names a driver. Every one of those is closed here, in one
 * place, so the engine above it never builds an argv or an environment itself:
 *
 * - Callers pass a typed request per subcommand. Every caller-supplied string is validated
 *   (validate.ts) before argv exists, and a failure throws `InvalidSyncInputError` without
 *   spawning anything. Remote URLs are built here from a validated `owner/repo`, never taken from
 *   stored strings. Positionals follow `--` wherever the subcommand accepts it, and paths only
 *   ever travel on stdin.
 * - Every call carries the same `-c` hardening flags (§3.1, §8.1), so no call can forget one.
 * - The child gets `clearEnv: true` and an environment built from scratch (§8.2). The worker
 *   process holds the Supabase service-role key and the GitHub App private key, and neither may
 *   reach a git child or anything git spawns. The installation token travels only in
 *   `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, so it never appears in argv (`ps`), a URL or a config
 *   file.
 * - Each call has a timeout, honors the job's `AbortSignal`, and caps captured output (§8.4).
 * - stderr is redacted before it is logged, returned or put into an error.
 *
 * `runGit` returns the result of any exit, because several non-zero exits are answers rather than
 * failures (`merge-file` exits with the conflict count, `cat-file -e` exits 1 for a missing
 * object). `runGitChecked` is the variant for calls where any non-zero exit is a failure, and
 * `classifyGitFailure` maps a failed result onto the error types of §7.
 */
import {
  GitSyncError,
  GitSyncRetryableError,
  GitSyncTerminalError,
  GitUnfetchableError,
  InvalidSyncInputError
} from "./errors.ts";
import { redactSecrets } from "./redact.ts";
import {
  EMPTY_TREE_SHA,
  type IndexBlobMode,
  validateGitDate,
  validateIdentityPart,
  validateIndexMode,
  validateIndexPath,
  validateLeaseExpectation,
  validateLocalPath,
  validateRepoFullName,
  validateSha,
  validateSyncBranch,
  validateToken,
  validateTrackingRef
} from "./validate.ts";

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/** `merge-file --object-id` arrived in git 2.43. The image pins a newer git (§3.1). */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 43];

/** The largest legitimate stdout is an `ls-tree -r` of a large repo (§8.4). */
export const STDOUT_CAP_BYTES = 64 * 1024 * 1024;
export const STDERR_CAP_BYTES = 1024 * 1024;

/**
 * Per-call timeouts (§8.4). Network calls get 10 minutes. Local plumbing gets 60 s, which the spec
 * fixes for `merge-file`, `ls-tree`, `diff-tree` and `update-index`, and which this module also
 * applies to the other local calls the spec leaves unspecified. `ls-remote` moves no objects, so it
 * gets 2 minutes: twice `http.lowSpeedTime`.
 */
export const DEFAULT_TIMEOUT_MS: Readonly<Record<GitOp, number>> = {
  init: 60_000,
  fetch: 600_000,
  "ls-remote": 120_000,
  push: 600_000,
  "diff-tree": 60_000,
  "ls-tree": 60_000,
  "merge-file": 60_000,
  "read-tree": 60_000,
  "update-index": 60_000,
  "write-tree": 60_000,
  "commit-tree": 60_000,
  "cat-file": 60_000,
  "count-objects": 60_000
};

/**
 * After SIGTERM, how long git gets before SIGKILL. SIGTERM comes first because git handles it by
 * removing its lock and temp files and signalling the children it started (`git-remote-https`,
 * `index-pack`, `pack-objects`). SIGKILL would orphan them with the pipes still open.
 */
const KILL_GRACE_MS = 2_000;

/** After the child exits, how long to wait for a grandchild that still holds stdout or stderr. */
const PIPE_DRAIN_MS = 2_000;

/**
 * A fixed PATH. Git finds its own helpers through its compiled-in exec path, and the shell it uses
 * for the local transport resolves `git-upload-pack` from here. Inheriting the worker's PATH would
 * be the one parent variable left in the child.
 */
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export type GitOp =
  | "init"
  | "fetch"
  | "ls-remote"
  | "push"
  | "diff-tree"
  | "ls-tree"
  | "merge-file"
  | "read-tree"
  | "update-index"
  | "write-tree"
  | "commit-tree"
  | "cat-file"
  | "count-objects";

interface RequestBase {
  /** Absolute path of the bare repo the call runs against. The worker created it. */
  gitDir: string;
  /** Overrides `DEFAULT_TIMEOUT_MS` for this call. */
  timeoutMs?: number;
}

/** `git init --bare` with no template directory, so no sample hooks are ever written. */
export interface InitRequest extends RequestBase {
  op: "init";
}

/** What a fetch asks for. `main` is named here, never taken from input. */
export type FetchTarget =
  /** One commit by SHA, stored under no ref (§5.1, §5.2 baseline). */
  | { kind: "sha"; sha: string }
  /** `refs/heads/main` into a local tracking ref such as `refs/remotes/student/main` (§5.2). */
  | { kind: "main"; trackingRef: string };

export interface FetchRequest extends RequestBase {
  op: "fetch";
  repo: string;
  target: FetchTarget;
  /** Shallow depth. The engine always passes 1. Omit for a full fetch. */
  depth?: number;
}

/** Reads the head of one sync branch on the remote (§5.2). */
export interface LsRemoteRequest extends RequestBase {
  op: "ls-remote";
  repo: string;
  branch: string;
}

/** `push --force-with-lease` of one commit to one sync branch (§5.8). */
export interface PushRequest extends RequestBase {
  op: "push";
  repo: string;
  commit: string;
  branch: string;
  /** Current branch head the push replaces, or `null` for "the branch must not exist". */
  expect: string | null;
}

/** `diff-tree -r -z --no-renames` between two tree-ish SHAs (§5.3). */
export interface DiffTreeRequest extends RequestBase {
  op: "diff-tree";
  from: string;
  to: string;
  format: "raw" | "numstat";
}

/** `ls-tree -r -t -z --full-tree` of one tree-ish SHA (§5.4). */
export interface LsTreeRequest extends RequestBase {
  op: "ls-tree";
  treeish: string;
}

/**
 * `merge-file --object-id` of three blob ids (§5.5). The labels are fixed as the spec gives
 * them. Conflicted output is discarded by the engine, so they never reach a student (§11.2).
 */
export interface MergeFileRequest extends RequestBase {
  op: "merge-file";
  /** The student's blob at the baseline, `S:p`. */
  student: string;
  /** The old handout's blob, `F:p`. */
  handoutBefore: string;
  /** The new handout's blob, `H:p`. */
  handout: string;
}

/** `read-tree` into a private index file (§5.6). */
export interface ReadTreeRequest extends RequestBase {
  op: "read-tree";
  indexFile: string;
  treeish: string;
}

/** One `--index-info` record. A removal is written as mode 0 with the null object id. */
export type IndexInfoEntry =
  | { kind: "remove"; path: string }
  | { kind: "set"; path: string; mode: IndexBlobMode; oid: string };

/**
 * `update-index -z --index-info` with the records on stdin (§5.6). `--add --replace` is passed
 * whenever a record sets an entry. The engine sends removals in a call of their own first, so a
 * directory-to-file swap never collides in the index.
 */
export interface UpdateIndexRequest extends RequestBase {
  op: "update-index";
  indexFile: string;
  entries: readonly IndexInfoEntry[];
}

export interface WriteTreeRequest extends RequestBase {
  op: "write-tree";
  indexFile: string;
}

/** A commit identity. The same one is used as author and committer (§5.7). */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * `commit-tree` with the message on stdin and identity and date in the environment, so the
 * commit is a pure function of its inputs (§5.7).
 */
export interface CommitTreeRequest extends RequestBase {
  op: "commit-tree";
  tree: string;
  parents: readonly string[];
  /** Written byte for byte. `commit-tree` does not clean up a message read with `-F`. */
  message: string;
  identity: GitIdentity;
  /** Author and committer date in git's raw form, `<unix seconds> <+|-HHMM>`. */
  date: string;
}

/**
 * The `cat-file` forms the engine needs. There is deliberately no form that prints a blob:
 * file content stays out of JavaScript memory (§2).
 */
export type CatFileRequest = RequestBase & { op: "cat-file"; object: string } & (
    | { mode: "exists"; peel?: "commit" | "tree" }
    | { mode: "type" }
    | { mode: "size" }
    | { mode: "commit" }
  );

/** `count-objects -v`, for `/work` usage reporting. */
export interface CountObjectsRequest extends RequestBase {
  op: "count-objects";
}

export type GitRequest =
  | InitRequest
  | FetchRequest
  | LsRemoteRequest
  | PushRequest
  | DiffTreeRequest
  | LsTreeRequest
  | MergeFileRequest
  | ReadTreeRequest
  | UpdateIndexRequest
  | WriteTreeRequest
  | CommitTreeRequest
  | CatFileRequest
  | CountObjectsRequest;

// ---------------------------------------------------------------------------------------------
// Context and results
// ---------------------------------------------------------------------------------------------

/**
 * Where remotes live. Production uses `GITHUB_REMOTE`. Hermetic tests pass `protocol: "file"` with
 * a `remoteUrlFor` that returns `file://` URLs (§9.1). The protocol both selects the allow list
 * git enforces and is checked against every URL `remoteUrlFor` returns, so a remote config cannot
 * hand git a transport it did not declare.
 */
export interface RemoteConfig {
  protocol: "https" | "file";
  remoteUrlFor(repoFullName: string): string;
}

export const GITHUB_REMOTE: RemoteConfig = {
  protocol: "https",
  remoteUrlFor: (repoFullName) => `https://github.com/${repoFullName}.git`
};

/** What `runGit` logs for each call. It never includes the environment. */
export interface GitLogEntry {
  op: GitOp | "version";
  argv: string[];
  code: number;
  signal: Deno.Signal | null;
  durationMs: number;
  killedBy: KillReason | null;
  /** The last part of redacted stderr, only when the call failed. */
  stderrTail?: string;
}

export type GitLogger = (entry: GitLogEntry) => void;

/**
 * Test seams. None of these is set in production. `gitBinary` lets a test run a stand-in program
 * through the real spawn path (for example, one that prints its environment), which is why it is
 * an option on the context and not a raw-argv entry point.
 */
export interface GitTestHooks {
  gitBinary?: string;
  /** Called with the redacted argv immediately before each spawn. */
  onSpawn?: (argv: readonly string[]) => void;
  stdoutCapBytes?: number;
  stderrCapBytes?: number;
  killGraceMs?: number;
}

/** Per-job settings shared by every call the job makes. */
export interface GitContext {
  /** The job directory. Becomes `HOME`, so nothing in the worker's real home is read. */
  home: string;
  /** Installation token for this job (§8.2). Omit for local-only calls. */
  token?: string;
  /** Fires at the job deadline. Kills the running child. */
  signal?: AbortSignal;
  /** Defaults to `GITHUB_REMOTE`. */
  remote?: RemoteConfig;
  /** Defaults to one `console.log` line per call. */
  log?: GitLogger;
  testOnly?: GitTestHooks;
}

type KillReason = "timeout" | "aborted" | "stdout_cap" | "stderr_cap";

export interface GitResult {
  op: GitOp | "version";
  /** Redacted argv, as logged. */
  argv: string[];
  code: number;
  signal: Deno.Signal | null;
  /** Raw bytes. Plumbing output can carry paths that are not valid UTF-8. */
  stdout: Uint8Array;
  /** Decoded and redacted. */
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputCapExceeded: "stdout" | "stderr" | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------------------------
// Building argv and environment
// ---------------------------------------------------------------------------------------------

interface Invocation {
  op: GitOp | "version";
  args: string[];
  cwd: string;
  /** Variables specific to this call, merged over the base environment. */
  extraEnv: Record<string, string>;
  stdin: Uint8Array | null;
  timeoutMs: number;
}

/**
 * The `-c` flags every call carries (§3.1, §8.1, §8.6 item 2). Command-line config is "protected"
 * in git's terms, so `safe.directory` is honored from here.
 *
 * Beyond the spec's list:
 * - `core.attributesFile=/dev/null`: git reads `$HOME/.config/git/attributes` regardless of
 *   `GIT_CONFIG_GLOBAL`. HOME is the job directory, so the file cannot exist, and this keeps it
 *   that way if HOME ever changes.
 * - `gc.auto=0` and `maintenance.auto=false`: a fetch can otherwise start `git gc --auto` or
 *   `git maintenance run --auto`, which would outlive the call and escape its timeout.
 */
function hardeningFlags(protocol: RemoteConfig["protocol"], safeDirectory: string): string[] {
  const config = [
    "core.hooksPath=/dev/null",
    `attr.tree=${EMPTY_TREE_SHA}`,
    "core.attributesFile=/dev/null",
    "credential.helper=",
    "fetch.recurseSubmodules=false",
    "submodule.recurse=false",
    "protocol.allow=never",
    `protocol.${protocol}.allow=always`,
    "core.fsmonitor=false",
    `safe.directory=${safeDirectory}`,
    "pack.threads=1",
    "pack.windowMemory=64m",
    "core.packedGitLimit=128m",
    "core.bigFileThreshold=16m",
    "http.lowSpeedLimit=1000",
    "http.lowSpeedTime=60",
    "gc.auto=0",
    "maintenance.auto=false"
  ];
  return config.flatMap((c) => ["-c", c]);
}

/**
 * The child's whole environment (§8.2). `GIT_TRACE*`, `GIT_CURL_VERBOSE` and everything else in
 * the worker's environment are absent because `clearEnv` starts from nothing.
 *
 * `GIT_ATTR_NOSYSTEM=1` is the attributes counterpart of `GIT_CONFIG_NOSYSTEM`: without it git
 * reads `/etc/gitattributes` from the image.
 */
function baseEnv(ctx: GitContext, protocol: RemoteConfig["protocol"]): Record<string, string> {
  const env: Record<string, string> = {
    PATH: CHILD_PATH,
    HOME: ctx.home,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: protocol
  };
  if (ctx.token !== undefined) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = authHeader(ctx.token);
  }
  return env;
}

function authHeader(token: string): string {
  // validateToken admits only ASCII, so btoa's Latin-1 input rule holds.
  const basic = btoa(`x-access-token:${validateToken(token)}`);
  return `AUTHORIZATION: basic ${basic}`;
}

/** Strings that must never appear in a log line or error: the token and the header built from it. */
function knownSecrets(ctx: GitContext): string[] {
  if (ctx.token === undefined) return [];
  const header = authHeader(ctx.token);
  return [ctx.token, header, header.slice("AUTHORIZATION: basic ".length)];
}

/**
 * Builds the URL for `owner/repo` and checks it against the declared protocol. In production
 * that means `https://github.com/...` with no userinfo, because the auth header is scoped to that
 * origin and nothing else should receive it. A `file` remote may only return `file://` URLs.
 */
function remoteUrl(repo: string, remote: RemoteConfig): string {
  const name = validateRepoFullName(repo);
  const raw = remote.remoteUrlFor(name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidSyncInputError("remote url", raw, "does not parse");
  }
  const ok =
    remote.protocol === "https"
      ? url.protocol === "https:" && url.hostname === "github.com" && url.port === ""
      : url.protocol === "file:" && url.host === "";
  if (!ok || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new InvalidSyncInputError("remote url", raw, `is not a plain ${remote.protocol} URL`);
  }
  return raw;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new InvalidSyncInputError(field, String(value), "must be a positive integer");
  }
  return value;
}

/**
 * Validates `req` and returns the argv tail, cwd, per-call environment and stdin. Everything that
 * can throw `InvalidSyncInputError` runs here, before `spawnGit` is reached.
 */
function buildInvocation(req: GitRequest, ctx: GitContext): Invocation {
  const remote = ctx.remote ?? GITHUB_REMOTE;
  if (remote.protocol !== "https" && remote.protocol !== "file") {
    throw new InvalidSyncInputError("remote protocol", String(remote.protocol), "must be https or file");
  }
  validateLocalPath(ctx.home, "home");
  const gitDir = validateLocalPath(req.gitDir, "gitDir");
  const timeoutMs = req.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS[req.op] : positiveInt(req.timeoutMs, "timeoutMs");
  const prefix = ["--no-replace-objects", ...hardeningFlags(remote.protocol, gitDir)];
  const inRepo = (...rest: string[]) => [`--git-dir=${gitDir}`, ...prefix, ...rest];
  const extraEnv: Record<string, string> = {};
  let stdin: Uint8Array | null = null;
  let args: string[];
  let cwd = gitDir;

  switch (req.op) {
    case "init":
      // No --git-dir: the directory is the positional, and it does not exist yet.
      cwd = ctx.home;
      args = [...prefix, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", "--template=", "--", gitDir];
      break;

    case "fetch": {
      const url = remoteUrl(req.repo, remote);
      const refspec =
        req.target.kind === "sha"
          ? validateSha(req.target.sha, "fetch sha")
          : req.target.kind === "main"
            ? `+refs/heads/main:${validateTrackingRef(req.target.trackingRef)}`
            : invalidVariant("fetch target", req.target);
      const depth = req.depth === undefined ? [] : [`--depth=${positiveInt(req.depth, "depth")}`];
      args = inRepo(
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        ...depth,
        "--",
        url,
        refspec
      );
      break;
    }

    case "ls-remote": {
      const url = remoteUrl(req.repo, remote);
      args = inRepo("ls-remote", "--refs", "--", url, `refs/heads/${validateSyncBranch(req.branch)}`);
      break;
    }

    case "push": {
      const url = remoteUrl(req.repo, remote);
      const branch = validateSyncBranch(req.branch);
      const commit = validateSha(req.commit, "push commit");
      const expect = validateLeaseExpectation(req.expect) ?? "";
      args = inRepo(
        "push",
        "--no-verify",
        "--no-recurse-submodules",
        `--force-with-lease=refs/heads/${branch}:${expect}`,
        "--",
        url,
        `${commit}:refs/heads/${branch}`
      );
      break;
    }

    case "diff-tree": {
      // diff-tree's `--` separates tree-ishes from pathspecs, so the validated SHAs come first and
      // the trailing `--` says "no pathspec". The same holds for ls-tree.
      const format = req.format === "raw" ? "--raw" : req.format === "numstat" ? "--numstat" : null;
      if (format === null) throw new InvalidSyncInputError("diff-tree format", String(req.format), "raw or numstat");
      args = inRepo(
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        format,
        validateSha(req.from, "diff-tree from"),
        validateSha(req.to, "diff-tree to"),
        "--"
      );
      break;
    }

    case "ls-tree":
      args = inRepo("ls-tree", "-r", "-t", "-z", "--full-tree", validateSha(req.treeish, "ls-tree treeish"), "--");
      break;

    case "merge-file":
      args = inRepo(
        "merge-file",
        "--object-id",
        "-L",
        "yours",
        "-L",
        "handout-before",
        "-L",
        "handout",
        "--",
        validateSha(req.student, "merge-file student"),
        validateSha(req.handoutBefore, "merge-file handoutBefore"),
        validateSha(req.handout, "merge-file handout")
      );
      break;

    case "read-tree":
      extraEnv.GIT_INDEX_FILE = validateLocalPath(req.indexFile, "indexFile");
      args = inRepo("read-tree", "--", validateSha(req.treeish, "read-tree treeish"));
      break;

    case "update-index": {
      extraEnv.GIT_INDEX_FILE = validateLocalPath(req.indexFile, "indexFile");
      if (!Array.isArray(req.entries)) throw new InvalidSyncInputError("entries", "(not an array)", "array");
      const records: string[] = [];
      let sets = false;
      for (const entry of req.entries) {
        const path = validateIndexPath(entry.path);
        if (entry.kind === "remove") {
          records.push(`0 ${"0".repeat(40)}\t${path}\0`);
        } else if (entry.kind === "set") {
          sets = true;
          records.push(`${validateIndexMode(entry.mode)} ${validateSha(entry.oid, "index oid")}\t${path}\0`);
        } else {
          invalidVariant("index entry", entry);
        }
      }
      stdin = new TextEncoder().encode(records.join(""));
      args = inRepo("update-index", "-z", ...(sets ? ["--add", "--replace"] : []), "--index-info");
      break;
    }

    case "write-tree":
      extraEnv.GIT_INDEX_FILE = validateLocalPath(req.indexFile, "indexFile");
      args = inRepo("write-tree");
      break;

    case "commit-tree": {
      const tree = validateSha(req.tree, "commit-tree tree");
      if (!Array.isArray(req.parents)) throw new InvalidSyncInputError("parents", "(not an array)", "array");
      const parents = req.parents.flatMap((p) => ["-p", validateSha(p, "commit-tree parent")]);
      if (typeof req.message !== "string" || req.message.includes("\0")) {
        throw new InvalidSyncInputError("commit message", "(message)", "must be a string without NUL");
      }
      const name = validateIdentityPart(req.identity?.name, "identity name");
      const email = validateIdentityPart(req.identity?.email, "identity email");
      const date = validateGitDate(req.date);
      Object.assign(extraEnv, {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: date
      });
      stdin = new TextEncoder().encode(req.message);
      args = inRepo("commit-tree", "--no-gpg-sign", ...parents, "-F", "-", "--", tree);
      break;
    }

    case "cat-file": {
      const object = validateSha(req.object, "cat-file object");
      switch (req.mode) {
        case "exists": {
          const peel =
            req.peel === undefined ? "" : req.peel === "commit" || req.peel === "tree" ? `^{${req.peel}}` : null;
          if (peel === null) throw new InvalidSyncInputError("cat-file peel", String(req.peel), "commit or tree");
          args = inRepo("cat-file", "-e", "--", `${object}${peel}`);
          break;
        }
        case "type":
          args = inRepo("cat-file", "-t", "--", object);
          break;
        case "size":
          args = inRepo("cat-file", "-s", "--", object);
          break;
        case "commit":
          args = inRepo("cat-file", "commit", "--", object);
          break;
        default:
          invalidVariant("cat-file mode", req);
      }
      break;
    }

    case "count-objects":
      args = inRepo("count-objects", "-v");
      break;

    default:
      invalidVariant("git op", req);
  }

  return { op: req.op, args, cwd, extraEnv, stdin, timeoutMs };
}

function invalidVariant(field: string, value: unknown): never {
  const tag =
    value !== null && typeof value === "object"
      ? JSON.stringify(
          (value as { op?: unknown; kind?: unknown; mode?: unknown }).op ??
            (value as { kind?: unknown }).kind ??
            (value as { mode?: unknown }).mode
        )
      : String(value);
  throw new InvalidSyncInputError(field, String(tag), "unknown variant");
}

// ---------------------------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------------------------

/**
 * Runs one git call. Throws `InvalidSyncInputError` before spawning if any input is invalid, and
 * `GitSyncRetryableError("deadline_exceeded")` without spawning if the job signal has already
 * fired. Otherwise returns the result of whatever exit the child made, including a kill.
 */
export async function runGit(req: GitRequest, ctx: GitContext): Promise<GitResult> {
  return await spawnGit(buildInvocation(req, ctx), ctx);
}

/**
 * `runGit`, then throws the classified error for any exit other than a clean 0. Use it for calls
 * where a non-zero exit carries no answer.
 */
export async function runGitChecked(req: GitRequest, ctx: GitContext): Promise<GitResult> {
  const result = await runGit(req, ctx);
  const error = classifyGitFailure(result);
  if (error) throw error;
  return result;
}

async function spawnGit(inv: Invocation, ctx: GitContext): Promise<GitResult> {
  const remote = ctx.remote ?? GITHUB_REMOTE;
  const secrets = knownSecrets(ctx);
  const argv = ["git", ...inv.args].map((a) => redactSecrets(a, secrets));
  if (ctx.signal?.aborted) {
    throw new GitSyncRetryableError(`git ${inv.op} not started: job deadline reached`, "deadline_exceeded");
  }
  const env = { ...baseEnv(ctx, remote.protocol), ...inv.extraEnv };
  const stdoutCap = ctx.testOnly?.stdoutCapBytes ?? STDOUT_CAP_BYTES;
  const stderrCap = ctx.testOnly?.stderrCapBytes ?? STDERR_CAP_BYTES;
  const killGraceMs = ctx.testOnly?.killGraceMs ?? KILL_GRACE_MS;

  ctx.testOnly?.onSpawn?.(argv);
  const started = performance.now();
  const child = new Deno.Command(ctx.testOnly?.gitBinary ?? "git", {
    args: inv.args,
    cwd: inv.cwd,
    clearEnv: true,
    env,
    stdin: inv.stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped"
  }).spawn();

  let killedBy: KillReason | null = null;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (reason: KillReason) => {
    if (killedBy !== null) return;
    killedBy = reason;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    escalation = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }, killGraceMs);
  };

  const timer = setTimeout(() => kill("timeout"), inv.timeoutMs);
  const onAbort = () => kill("aborted");
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  const stdoutReader = capture(child.stdout, stdoutCap, () => kill("stdout_cap"));
  const stderrReader = capture(child.stderr, stderrCap, () => kill("stderr_cap"));
  const stdinDone = inv.stdin ? writeStdin(child.stdin, inv.stdin) : Promise.resolve();

  let status: Deno.CommandStatus;
  try {
    status = await child.status;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
  await stdinDone;
  // A grandchild that git started can keep a pipe open after git itself is gone. Give the readers
  // a moment to see EOF, then stop waiting for them.
  const [stdout, stderrBytes] = await settleWithin(PIPE_DRAIN_MS, [stdoutReader, stderrReader]);

  const stderr = redactSecrets(new TextDecoder().decode(stderrBytes), secrets);
  const signal = status.signal ?? null;
  const reason = killedBy as KillReason | null;
  const result: GitResult = {
    op: inv.op,
    argv,
    code: status.code,
    signal,
    stdout,
    stderr,
    timedOut: reason === "timeout",
    aborted: reason === "aborted",
    outputCapExceeded: reason === "stdout_cap" ? "stdout" : reason === "stderr_cap" ? "stderr" : null,
    durationMs: Math.round(performance.now() - started)
  };
  const failed = status.code !== 0 || signal !== null;
  (ctx.log ?? defaultLog)({
    op: inv.op,
    argv,
    code: status.code,
    signal,
    durationMs: result.durationMs,
    killedBy: reason,
    ...(failed ? { stderrTail: tail(stderr, 1000) } : {})
  });
  return result;
}

function defaultLog(entry: GitLogEntry): void {
  console.log(JSON.stringify({ msg: "git", ...entry }));
}

interface Capture {
  done: Promise<Uint8Array>;
  cancel(): void;
}

/**
 * Reads a child pipe into memory up to `cap` bytes. Past the cap it calls `onExceed` (which kills
 * the child) and stops reading, so the child also sees a closed pipe.
 */
function capture(stream: ReadableStream<Uint8Array>, cap: number, onExceed: () => void): Capture {
  const reader = stream.getReader();
  const done = (async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (total + value.byteLength > cap) {
          chunks.push(value.subarray(0, cap - total));
          total = cap;
          onExceed();
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch {
      // Cancelled after the drain window, or the pipe broke. Keep what was read.
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  })();
  return { done, cancel: () => void reader.cancel().catch(() => {}) };
}

async function settleWithin(ms: number, captures: Capture[]): Promise<Uint8Array[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const all = Promise.all(captures.map((c) => c.done));
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), ms);
  });
  const first = await Promise.race([all, expired]);
  clearTimeout(timer);
  if (first === "expired") for (const c of captures) c.cancel();
  return await all;
}

/** Writes stdin and closes it. A child that exits early breaks the pipe, which is not an error here. */
async function writeStdin(stream: WritableStream<Uint8Array>, bytes: Uint8Array): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch {
    // The child's exit status says what went wrong.
  }
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

// ---------------------------------------------------------------------------------------------
// Failure classification (§7)
// ---------------------------------------------------------------------------------------------

const DISK_FULL_RE = /No space left on device|ENOSPC/i;
const GH001_RE = /\bGH001\b/;
/** GitHub's wording: "remote: error: File big.bin is 120.00 MB; this exceeds GitHub's file size limit". */
const GH001_PATH_RE = /File (.+?) is [\d.]+ MB; this exceeds/;
const LEASE_RE = /\(stale info\)|cannot lock ref|incorrect old value|failed to update ref/i;
const UNFETCHABLE_RE =
  /not our ref|unadvertised object|couldn't find remote ref|no such remote ref|upload-pack: not our ref/i;
const REPO_NOT_FOUND_RE = /Repository not found/i;
const NETWORK_RE = new RegExp(
  [
    "RPC failed",
    "early EOF",
    "the remote end hung up unexpectedly",
    "unexpected disconnect",
    "Could not resolve host",
    "Failed to connect",
    "Connection (?:timed out|reset|refused)",
    "Operation timed out",
    "transfer closed",
    "Empty reply from server",
    "SSL_(?:read|write|connect)",
    "GnuTLS",
    "gnutls_handshake",
    "TLS connection",
    "returned error: 5\\d\\d",
    "HTTP/2 stream",
    "index-pack failed",
    "invalid index-pack output"
  ].join("|"),
  "i"
);

/**
 * Maps a git child's (already redacted) stderr to an error type, or `null` when the text matches
 * no known failure. Exported so the patterns can be tested against captured git output.
 *
 * Order matters where one failure prints another's symptom: `ENOSPC` during `index-pack` also
 * prints `early EOF`, and a refused SHA is reported as a `remote error`.
 */
export function classifyGitStderr(op: string, stderr: string): GitSyncError | null {
  const detail = tail(stderr.trim(), 2000);
  if (DISK_FULL_RE.test(stderr)) {
    return new GitSyncRetryableError(`git ${op}: disk full: ${detail}`, "disk_full");
  }
  if (GH001_RE.test(stderr)) {
    const path = GH001_PATH_RE.exec(stderr)?.[1];
    return new GitSyncTerminalError(
      `git ${op}: GitHub refused a file over its size limit${path ? ` (${path})` : ""}: ${detail}`,
      "file_too_large",
      path
    );
  }
  if (LEASE_RE.test(stderr)) {
    return new GitSyncRetryableError(`git ${op}: branch lease rejected: ${detail}`, "lease_rejected");
  }
  if (UNFETCHABLE_RE.test(stderr)) {
    return new GitUnfetchableError(`git ${op}: remote would not serve the object: ${detail}`);
  }
  if (REPO_NOT_FOUND_RE.test(stderr)) {
    return new GitSyncRetryableError(`git ${op}: repository not found: ${detail}`, "remote_repo_not_found");
  }
  if (NETWORK_RE.test(stderr)) {
    return new GitSyncRetryableError(`git ${op}: network failure: ${detail}`, "network");
  }
  return null;
}

/**
 * The error for a failed result, or `null` for a clean exit. A kill takes precedence over
 * whatever stderr says, because a killed child's stderr is cut off mid-stream. Unrecognized
 * failures are `git_failed` and retryable, so the read cap (§3.1) bounds them.
 */
export function classifyGitFailure(result: GitResult): GitSyncError | null {
  const { op } = result;
  if (result.aborted) {
    return new GitSyncRetryableError(`git ${op} killed at the job deadline`, "deadline_exceeded");
  }
  if (result.timedOut) return new GitSyncRetryableError(`git ${op} timed out`, "timeout");
  if (result.outputCapExceeded) {
    return new GitSyncRetryableError(`git ${op} exceeded the ${result.outputCapExceeded} cap`, "output_cap_exceeded");
  }
  if (result.code === 0 && result.signal === null) return null;
  return (
    classifyGitStderr(op, result.stderr) ??
    new GitSyncError(
      `git ${op} failed (${result.signal ?? `exit ${result.code}`}): ${tail(result.stderr.trim(), 2000)}`,
      "git_failed",
      true
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------------------------

/** Parses `git version 2.43.0` (and vendor suffixes) into numbers, or `null`. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * Asserts that the installed git is at least `min` (default `MIN_GIT_VERSION`). Run once at worker
 * startup. It goes through the same spawn path as every other call, with the same environment.
 */
export async function assertGitVersion(
  ctx: GitContext,
  min: readonly [number, number] = MIN_GIT_VERSION
): Promise<[number, number, number]> {
  validateLocalPath(ctx.home, "home");
  const result = await spawnGit(
    { op: "version", args: ["--version"], cwd: ctx.home, extraEnv: {}, stdin: null, timeoutMs: 10_000 },
    ctx
  );
  const text = new TextDecoder().decode(result.stdout);
  const version = parseGitVersion(text);
  if (result.code !== 0 || version === null) {
    throw new GitSyncError(`could not read git version: ${text.trim() || result.stderr.trim()}`, "git_failed", true);
  }
  const [major, minor] = version;
  if (major < min[0] || (major === min[0] && minor < min[1])) {
    throw new GitSyncError(
      `git ${version.join(".")} is older than ${min.join(".")}; merge-file --object-id needs ${min.join(".")}`,
      "git_version_unsupported",
      false
    );
  }
  return version;
}
