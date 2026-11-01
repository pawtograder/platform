/**
 * Tests for runGit.ts and its validators (docs/handout-sync-git-build-plan.md, WP1 acceptance).
 *
 * The integration cases spawn the real git against local bare repos reached over `file://`.
 * Fixture directories live under `.test-tmp/` at the repo root (gitignored; override with
 * `GITSYNC_TEST_TMPDIR`) rather than `/tmp` or `~/.cache`, because the snap-packaged Deno can read
 * neither. Each test removes its own directory.
 *
 * Fixture setup calls git directly through `fixtureGit`. That is test scaffolding for building
 * remotes, not a second production spawn path.
 */
import { assert, assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  GitSyncError,
  GitSyncTerminalError,
  GitUnfetchableError,
  InvalidSyncInputError,
  type GitFailureKind
} from "./errors.ts";
import { redactSecrets } from "./redact.ts";
import {
  assertGitVersion,
  classifyGitFailure,
  classifyGitStderr,
  type GitContext,
  type GitLogEntry,
  type GitRequest,
  type GitResult,
  parseGitVersion,
  assertGitRuntime,
  gh001Path,
  lsRemoteSyncBranch,
  parseLsRemoteExact,
  runGit,
  runGitChecked
} from "./runGit.ts";
import {
  EMPTY_TREE_SHA,
  syncBranchFor,
  validateIndexPath,
  validateLeaseExpectation,
  validateRepoFullName,
  validateSha,
  validateSyncBranch
} from "./validate.ts";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const TEST_ROOT =
  Deno.env.get("GITSYNC_TEST_TMPDIR") ?? new URL("../../../../.test-tmp/gitsync", import.meta.url).pathname;

/**
 * The snap-packaged Deno runs in a mount namespace without the host's git, so the cases that need
 * real git are skipped there. The skip condition is narrow on purpose: only a spawn that fails
 * with `NotFound` (no `git` executable visible to this Deno) skips. Any other spawn error, such as
 * a missing `--allow-run`, propagates and fails the file, and a git that runs but exits non-zero
 * does not skip. In CI (`CI` set) nothing is skipped, so a runner that lost git fails loudly.
 */
async function gitIsMissing(): Promise<boolean> {
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null", stderr: "null" }).output();
    return false;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return true;
    throw e;
  }
}
const SKIP_REAL_GIT = !Deno.env.get("CI") && (await gitIsMissing());
if (SKIP_REAL_GIT) {
  console.error(
    [
      "",
      "!!! runGit.test.ts: `git` is not visible to this Deno (spawn failed with NotFound; the snap Deno does this).",
      "!!! SKIPPED: every case that runs real git (each is listed as ignored below).",
      "!!! These cases are NOT covered by this run. Use a non-snap Deno, or set CI=1 to make the skip a failure.",
      ""
    ].join("\n")
  );
}

/**
 * The kill tests need a Deno whose `detached` spawn makes the child a process-group leader. The
 * snap Deno 2.3.7 does not, so they are skipped there, loudly, and never in CI. Production checks
 * the same property at startup with `assertChildProcessGroups`.
 */
async function detachedMakesProcessGroup(): Promise<boolean> {
  const options: Deno.CommandOptions & { detached?: boolean } = {
    args: ["5"],
    detached: true,
    stdout: "null",
    stderr: "null"
  };
  const child = new Deno.Command("sleep", options).spawn();
  try {
    // Succeeds only if a group with the child's pid as its id exists. See assertChildProcessGroups.
    Deno.kill(-child.pid, "SIGCONT");
    return true;
  } catch {
    return false;
  } finally {
    child.kill("SIGKILL");
    await child.status;
  }
}
const SKIP_PROCESS_GROUPS = !Deno.env.get("CI") && !(await detachedMakesProcessGroup());
if (SKIP_PROCESS_GROUPS) {
  console.error(
    [
      "",
      "!!! runGit.test.ts: this Deno's detached spawn does not create a process group (the snap Deno 2.3.7 does this).",
      "!!! SKIPPED: the process-group kill cases (listed as ignored below). They are NOT covered by this run.",
      ""
    ].join("\n")
  );
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const GOOD_REPO = "neu-cs3100/handout-hw1";
const GOOD_BRANCH = "sync-to-abcdef0";

/** Every hostile shape the WP1 acceptance list names. */
const HOSTILE_INPUTS = [
  "-x",
  "--upload-pack=touch /tmp/pwned",
  "ext::sh -c id",
  "file:///etc",
  "a/b/c",
  "../x",
  "",
  "a".repeat(39),
  "A".repeat(40)
];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  await Deno.mkdir(TEST_ROOT, { recursive: true });
  const dir = await Deno.makeTempDir({ dir: TEST_ROOT, prefix: "rungit-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Runs the system git for fixture setup, with an environment that ignores the developer's config. */
async function fixtureGit(args: string[], opts: { cwd: string; stdin?: string; allowFail?: boolean }): Promise<string> {
  const child = new Deno.Command("git", {
    args,
    cwd: opts.cwd,
    clearEnv: true,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: opts.cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_DATE: "1700000000 +0000"
    },
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped"
  }).spawn();
  if (opts.stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const out = await child.output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  if (!out.success && !opts.allowFail) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return stdout;
}

/**
 * Builds a bare remote at `<root>/remotes/<owner>/<repo>.git` from a series of snapshots, one
 * commit per snapshot on `main`. Returns the commit SHAs in order. The remote allows fetching any
 * reachable SHA, as GitHub does.
 */
async function makeRemote(root: string, fullName: string, snapshots: Array<Record<string, string>>): Promise<string[]> {
  const work = `${root}/work/${fullName}`;
  await Deno.mkdir(work, { recursive: true });
  await fixtureGit(["init", "-q", "-b", "main", work], { cwd: root });
  const shas: string[] = [];
  let previous = new Set<string>();
  for (const [i, snapshot] of snapshots.entries()) {
    for (const path of previous) {
      if (!(path in snapshot)) await Deno.remove(`${work}/${path}`);
    }
    for (const [path, content] of Object.entries(snapshot)) {
      const dir = path.includes("/") ? `${work}/${path.slice(0, path.lastIndexOf("/"))}` : work;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${work}/${path}`, content);
    }
    previous = new Set(Object.keys(snapshot));
    await fixtureGit(["add", "-A"], { cwd: work });
    await fixtureGit(["commit", "-q", "--allow-empty", "-m", `snapshot ${i}`], { cwd: work });
    shas.push(await fixtureGit(["rev-parse", "HEAD"], { cwd: work }));
  }
  const bare = remotePath(root, fullName);
  await Deno.mkdir(bare.slice(0, bare.lastIndexOf("/")), { recursive: true });
  await fixtureGit(["clone", "-q", "--bare", work, bare], { cwd: root });
  await fixtureGit(["--git-dir", bare, "config", "uploadpack.allowReachableSHA1InWant", "true"], { cwd: root });
  return shas;
}

function remotePath(root: string, fullName: string): string {
  return `${root}/remotes/${fullName}.git`;
}

/** A context against `file://` remotes under `root`, recording every spawn and log line. */
function fileContext(root: string, home: string, extra: Partial<GitContext> = {}) {
  const spawns: string[][] = [];
  const logs: GitLogEntry[] = [];
  const ctx: GitContext = {
    home,
    remote: { protocol: "file", remoteUrlFor: (name) => `file://${remotePath(root, name)}` },
    log: (entry) => logs.push(entry),
    ...extra,
    testOnly: { onSpawn: (argv) => spawns.push([...argv]), ...extra.testOnly }
  };
  return { ctx, spawns, logs };
}

/** Writes an executable stand-in for git, used through the `testOnly.gitBinary` seam. */
async function stubBinary(dir: string, name: string, script: string): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${script}\n`);
  await Deno.chmod(path, 0o755);
  return path;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------------

Deno.test("validators reject every hostile input in the WP1 list", () => {
  const validators: Array<[string, (v: unknown) => unknown]> = [
    ["validateSha", (v) => validateSha(v)],
    ["validateRepoFullName", (v) => validateRepoFullName(v)],
    ["validateSyncBranch", (v) => validateSyncBranch(v)],
    ["validateLeaseExpectation", (v) => validateLeaseExpectation(v)]
  ];
  for (const [name, validate] of validators) {
    for (const input of HOSTILE_INPUTS) {
      let threw: unknown = null;
      try {
        validate(input);
      } catch (e) {
        threw = e;
      }
      assert(threw instanceof InvalidSyncInputError, `${name} accepted ${JSON.stringify(input)}`);
      assertEquals((threw as InvalidSyncInputError).reason, "invalid_sync_input");
    }
  }
});

Deno.test("validators accept the shapes the engine uses", () => {
  assertEquals(validateSha(SHA_A), SHA_A);
  assertEquals(validateSha(EMPTY_TREE_SHA), EMPTY_TREE_SHA);
  for (const name of ["a/b", "neu-cs3100/fa26-handout-hw-img1", "A-1/x.y_z", "o/.github", "o/..."]) {
    assertEquals(validateRepoFullName(name), name);
  }
  assertEquals(validateSyncBranch(GOOD_BRANCH), GOOD_BRANCH);
  assertEquals(syncBranchFor(`abcdef0${"1".repeat(33)}`), "sync-to-abcdef0");
  assertEquals(validateLeaseExpectation(null), null);
  assertEquals(validateLeaseExpectation(SHA_B), SHA_B);
});

Deno.test("repo name validation rejects . and .. segments and over-long owners", () => {
  for (const bad of [
    "o/.",
    "o/..",
    ".",
    "..",
    "./x",
    "-o/x",
    "o/x/",
    "/o/x",
    `${"a".repeat(40)}/x`,
    `o/${"r".repeat(101)}`
  ]) {
    assertThrowsInvalid(() => validateRepoFullName(bad), bad);
  }
});

Deno.test("sync branch validation accepts only sync-to-<7 lowercase hex>", () => {
  for (const bad of ["main", "sync-to-abcdef", "sync-to-abcdef01", "sync-to-ABCDEF0", "refs/heads/sync-to-abcdef0"]) {
    assertThrowsInvalid(() => validateSyncBranch(bad), bad);
  }
});

Deno.test("index path validation rejects traversal, absolute, empty and NUL paths", () => {
  for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/", ".git/config", "x/.GIT/y", "a\0b"]) {
    assertThrowsInvalid(() => validateIndexPath(bad), bad);
  }
  // Paths travel on stdin, so a leading dash is an ordinary file name.
  for (const ok of ["-x", "src/main.java", ".github/workflows/grade.yml", "dir with spaces/f"]) {
    assertEquals(validateIndexPath(ok), ok);
  }
});

function assertThrowsInvalid(fn: () => unknown, input: string): void {
  try {
    fn();
  } catch (e) {
    assertInstanceOf(e, InvalidSyncInputError);
    return;
  }
  throw new Error(`accepted ${JSON.stringify(input)}`);
}

// ---------------------------------------------------------------------------------------------
// Nothing is spawned for invalid input
// ---------------------------------------------------------------------------------------------

/** Every request field that carries a caller-supplied string, with a hostile value substituted. */
function hostileRequests(gitDir: string, bad: string): Array<[string, GitRequest]> {
  const index = `${gitDir}/sync.index`;
  return [
    ["fetch.repo", { op: "fetch", gitDir, repo: bad, target: { kind: "sha", sha: SHA_A } }],
    ["fetch.sha", { op: "fetch", gitDir, repo: GOOD_REPO, target: { kind: "sha", sha: bad } }],
    ["fetch.trackingRef", { op: "fetch", gitDir, repo: GOOD_REPO, target: { kind: "main", trackingRef: bad } }],
    ["push.repo", { op: "push", gitDir, repo: bad, commit: SHA_A, branch: GOOD_BRANCH, expect: null }],
    ["push.commit", { op: "push", gitDir, repo: GOOD_REPO, commit: bad, branch: GOOD_BRANCH, expect: null }],
    ["push.branch", { op: "push", gitDir, repo: GOOD_REPO, commit: SHA_A, branch: bad, expect: null }],
    ["push.expect", { op: "push", gitDir, repo: GOOD_REPO, commit: SHA_A, branch: GOOD_BRANCH, expect: bad }],
    ["diff-tree.from", { op: "diff-tree", gitDir, from: bad, to: SHA_A, format: "raw" }],
    ["diff-tree.to", { op: "diff-tree", gitDir, from: SHA_A, to: bad, format: "numstat" }],
    ["ls-tree.treeish", { op: "ls-tree", gitDir, treeish: bad }],
    ["merge-file.student", { op: "merge-file", gitDir, student: bad, handoutBefore: SHA_A, handout: SHA_B }],
    ["merge-file.handoutBefore", { op: "merge-file", gitDir, student: SHA_A, handoutBefore: bad, handout: SHA_B }],
    ["merge-file.handout", { op: "merge-file", gitDir, student: SHA_A, handoutBefore: SHA_B, handout: bad }],
    ["read-tree.treeish", { op: "read-tree", gitDir, indexFile: index, treeish: bad }],
    [
      "update-index.oid",
      { op: "update-index", gitDir, indexFile: index, entries: [{ kind: "set", path: "a", mode: "100644", oid: bad }] }
    ],
    [
      "commit-tree.tree",
      { op: "commit-tree", gitDir, tree: bad, parents: [SHA_A], message: "m", identity: ID, date: DATE }
    ],
    [
      "commit-tree.parent",
      { op: "commit-tree", gitDir, tree: SHA_A, parents: [bad], message: "m", identity: ID, date: DATE }
    ],
    ["cat-file.object", { op: "cat-file", gitDir, object: bad, mode: "exists", peel: "commit" }],
    ["gitDir", { op: "count-objects", gitDir: bad }]
  ];
}

const ID = { name: "pawtograder[bot]", email: "1+pawtograder[bot]@users.noreply.github.com" };
const DATE = "1700000000 +0000";

Deno.test("runGit rejects hostile input in every request field without spawning", async () => {
  const spawned: string[][] = [];
  const ctx: GitContext = {
    home: "/nonexistent-home",
    remote: { protocol: "file", remoteUrlFor: (n) => `file:///nonexistent/${n}.git` },
    log: () => {},
    testOnly: { onSpawn: (argv) => spawned.push([...argv]) }
  };
  let cases = 0;
  for (const bad of HOSTILE_INPUTS) {
    for (const [field, req] of hostileRequests("/nonexistent/job.git", bad)) {
      await assertRejects(() => runGit(req, ctx), InvalidSyncInputError, undefined, `${field}=${JSON.stringify(bad)}`);
      cases++;
    }
    const gitDir = "/nonexistent/job.git";
    await assertRejects(
      () => lsRemoteSyncBranch({ gitDir, repo: bad, branch: GOOD_BRANCH }, ctx),
      InvalidSyncInputError
    );
    await assertRejects(() => lsRemoteSyncBranch({ gitDir, repo: GOOD_REPO, branch: bad }, ctx), InvalidSyncInputError);
    cases += 2;
  }
  const index = "/nonexistent/job.git/sync.index";
  const others: GitRequest[] = [
    { op: "update-index", gitDir: "/j", indexFile: index, entries: [{ kind: "remove", path: "../x" }] },
    {
      op: "update-index",
      gitDir: "/j",
      indexFile: index,
      entries: [{ kind: "set", path: "a", mode: "040000" as "100644", oid: SHA_A }]
    },
    { op: "read-tree", gitDir: "/j", indexFile: "relative/index", treeish: SHA_A },
    {
      op: "commit-tree",
      gitDir: "/j",
      tree: SHA_A,
      parents: [],
      message: "m",
      identity: { name: "a\nb", email: "e" },
      date: DATE
    },
    {
      op: "commit-tree",
      gitDir: "/j",
      tree: SHA_A,
      parents: [],
      message: "m",
      identity: { name: "a", email: "<e>" },
      date: DATE
    },
    { op: "commit-tree", gitDir: "/j", tree: SHA_A, parents: [], message: "m", identity: ID, date: "yesterday" },
    { op: "commit-tree", gitDir: "/j", tree: SHA_A, parents: [], message: "a\0b", identity: ID, date: DATE },
    { op: "fetch", gitDir: "/j", repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A }, depth: 0 },
    { op: "fetch", gitDir: "/j", repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A }, timeoutMs: -1 }
  ];
  for (const req of others) {
    await assertRejects(() => runGit(req, ctx), InvalidSyncInputError);
    cases++;
  }
  // A token with a line break would inject a second HTTP header.
  await assertRejects(
    () => runGit({ op: "count-objects", gitDir: "/j" }, { ...ctx, token: "ghs_abc\r\nX-Evil: 1" }),
    InvalidSyncInputError
  );
  assert(cases > 150);
  assertEquals(spawned, []);
});

Deno.test("remote URLs must match the declared protocol, and https must be plain github.com", async () => {
  const spawned: string[][] = [];
  const req: GitRequest = { op: "fetch", gitDir: "/j", repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A } };
  const base = { home: "/h", log: () => {}, testOnly: { onSpawn: (a: readonly string[]) => spawned.push([...a]) } };
  const urls: Array<["https" | "file", string]> = [
    ["file", "ext::sh -c id"],
    ["file", "https://github.com/o/r.git"],
    ["file", "file://evil.example.com/o/r.git"],
    ["https", "file:///etc"],
    ["https", "ext::sh -c id"],
    ["https", "http://github.com/o/r.git"],
    ["https", "https://evil.example.com/o/r.git"],
    ["https", "https://x:y@github.com/o/r.git"],
    ["https", "https://github.com:8443/o/r.git"],
    ["https", "fd::17"]
  ];
  for (const [protocol, url] of urls) {
    await assertRejects(
      () => runGit(req, { ...base, remote: { protocol, remoteUrlFor: () => url } }),
      InvalidSyncInputError,
      undefined,
      `${protocol} ${url}`
    );
  }
  await assertRejects(
    () => runGit(req, { ...base, remote: { protocol: "ext" as "file", remoteUrlFor: () => "ext::sh" } }),
    InvalidSyncInputError
  );
  assertEquals(spawned, []);
});

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

const ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_ATTR_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_ALLOW_PROTOCOL",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0"
];

function parseEnv(output: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return env;
}

Deno.test("the child environment contains none of the parent's variables", async () => {
  await withTempDir(async (dir) => {
    const printEnv = await stubBinary(dir, "print-env", "exec /usr/bin/env");
    const planted = {
      SUPABASE_SERVICE_ROLE_KEY: "planted-service-role-key-0123456789",
      GITHUB_APP_PRIVATE_KEY: "planted-private-key-0123456789",
      GIT_TRACE: "1",
      GIT_CURL_VERBOSE: "1",
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp/evil'",
      GIT_DIR: "/tmp/evil.git"
    };
    await withEnv(planted, async () => {
      const token = "ghs_" + "T".repeat(36);
      const { ctx, spawns, logs } = fileContext(dir, dir, { token, testOnly: { gitBinary: printEnv } });
      const result = await runGit({ op: "count-objects", gitDir: dir }, ctx);
      assertEquals(result.code, 0);
      const env = parseEnv(text(result.stdout));
      // /bin/sh itself may export PWD, SHLVL and `_`. Those come from the shell, not from us.
      const shellAdded = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
      const keys = [...env.keys()].filter((k) => !shellAdded.has(k)).sort();
      assertEquals(keys, [...ALLOWED_ENV_KEYS].sort());
      for (const key of Object.keys(Deno.env.toObject())) {
        if (ALLOWED_ENV_KEYS.includes(key) || shellAdded.has(key)) continue;
        assert(!env.has(key), `parent variable ${key} reached the child`);
      }
      // Values too, in case one were copied under an allowed name.
      for (const value of [planted.SUPABASE_SERVICE_ROLE_KEY, planted.GITHUB_APP_PRIVATE_KEY, "core.hookspath"]) {
        assert(![...env.values()].some((v) => v.includes(value)), `${value} reached the child`);
      }
      assertEquals(env.get("PATH"), "/usr/local/bin:/usr/bin:/bin");
      assertEquals(env.get("HOME"), dir);
      assertEquals(env.get("GIT_ALLOW_PROTOCOL"), "file");
      assertEquals(env.get("GIT_CONFIG_KEY_0"), "http.https://github.com/.extraheader");
      assertEquals(env.get("GIT_CONFIG_VALUE_0"), `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`);
      // The token travels only in the environment: never in argv or a log line.
      for (const argv of spawns) assert(!argv.join(" ").includes(token));
      assert(!JSON.stringify(logs).includes(token));
      assert(!JSON.stringify(logs).includes(btoa(`x-access-token:${token}`)));
    });
  });
});

Deno.test("testOnly.extraEnv admits only proxy variables and cannot replace a hardening variable", async () => {
  await withTempDir(async (dir) => {
    const printEnv = await stubBinary(dir, "print-env", "exec /usr/bin/env");
    const spawned: string[][] = [];
    const ctxWith = (extraEnv: Record<string, string>): GitContext => ({
      home: dir,
      token: "ghs_" + "E".repeat(36),
      remote: { protocol: "file", remoteUrlFor: (n) => `file://${remotePath(dir, n)}` },
      log: () => {},
      testOnly: { gitBinary: printEnv, onSpawn: (a) => spawned.push([...a]), extraEnv }
    });
    for (const [key, value] of [
      ["GIT_ALLOW_PROTOCOL", "ext:file:https"],
      ["GIT_CONFIG_COUNT", "2"],
      ["GIT_CONFIG_VALUE_0", "AUTHORIZATION: basic attacker"],
      ["GIT_CONFIG_PARAMETERS", "'core.hookspath'='/tmp/evil'"],
      ["GIT_SSL_NO_VERIFY", "1"],
      ["GIT_TRACE", "1"],
      ["PATH", "/tmp/evil"],
      ["HOME", "/tmp/evil"],
      ["LD_PRELOAD", "/tmp/evil.so"],
      ["http_proxy", "http://127.0.0.1:1"]
    ]) {
      await assertRejects(
        () => runGit({ op: "count-objects", gitDir: dir }, ctxWith({ [key]: value })),
        InvalidSyncInputError,
        undefined,
        key
      );
    }
    await assertRejects(
      () => runGit({ op: "count-objects", gitDir: dir }, ctxWith({ https_proxy: "http://x\nGIT_TRACE=1" })),
      InvalidSyncInputError
    );
    assertEquals(spawned, [], "a rejected extraEnv still spawned");

    // The allowed keys pass through, and the hardening variables keep their values.
    const proxy = "http://127.0.0.1:9";
    const result = await runGit(
      { op: "count-objects", gitDir: dir },
      ctxWith({ https_proxy: proxy, HTTPS_PROXY: proxy, no_proxy: "localhost", NO_PROXY: "localhost" })
    );
    const env = parseEnv(text(result.stdout));
    assertEquals(env.get("https_proxy"), proxy);
    assertEquals(env.get("NO_PROXY"), "localhost");
    assertEquals(env.get("GIT_ALLOW_PROTOCOL"), "file");
    assertEquals(env.get("PATH"), "/usr/local/bin:/usr/bin:/bin");
  });
});

Deno.test("without a token there is no extraheader, and commit-tree adds only identity variables", async () => {
  await withTempDir(async (dir) => {
    const printEnv = await stubBinary(dir, "print-env", "cat >/dev/null; exec /usr/bin/env");
    const { ctx } = fileContext(dir, dir, { testOnly: { gitBinary: printEnv } });
    const result = await runGit(
      { op: "commit-tree", gitDir: dir, tree: SHA_A, parents: [SHA_B], message: "m\n", identity: ID, date: DATE },
      ctx
    );
    const env = parseEnv(text(result.stdout));
    assert(!env.has("GIT_CONFIG_COUNT"));
    assertEquals(env.get("GIT_AUTHOR_NAME"), ID.name);
    assertEquals(env.get("GIT_COMMITTER_EMAIL"), ID.email);
    assertEquals(env.get("GIT_AUTHOR_DATE"), DATE);
    assertEquals(env.get("GIT_COMMITTER_DATE"), DATE);
    const index = await runGit({ op: "write-tree", gitDir: dir, indexFile: `${dir}/sync.index` }, ctx);
    assertEquals(parseEnv(text(index.stdout)).get("GIT_INDEX_FILE"), `${dir}/sync.index`);
  });
});

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

const PLANTED_GHS = "ghs_" + "Ab1".repeat(12);
const PLANTED_STDERR = [
  `fatal: unable to access 'https://x-access-token:${PLANTED_GHS}@github.com/o/r.git/': RPC failed`,
  "> AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX2FiYw==",
  "Authorization: Bearer topsecretbearer",
  "remote: see https://user:hunter2pass@example.com/path",
  `token ${PLANTED_GHS} and ghp_${"Z".repeat(36)} and github_pat_${"Q".repeat(40)}`
].join("\n");

function assertNoSecrets(s: string): void {
  for (const secret of [
    PLANTED_GHS,
    "eC1hY2Nlc3MtdG9rZW46",
    "topsecretbearer",
    "hunter2pass",
    "user:",
    "Z".repeat(36),
    "Q".repeat(40)
  ]) {
    assert(!s.includes(secret), `${secret} survived redaction in: ${s}`);
  }
}

Deno.test("redactSecrets removes tokens, Authorization headers and URL userinfo", () => {
  const out = redactSecrets(PLANTED_STDERR);
  assertNoSecrets(out);
  // The text around the secrets survives, so the classifier and a human can still read it.
  assertStringIncludes(out, "RPC failed");
  assertStringIncludes(out, "github.com/o/r.git");
  assertEquals(redactSecrets("plain message"), "plain message");
});

Deno.test("URL userinfo after another URL is redacted, whatever separates them", () => {
  for (const input of [
    "'https://example.com','https://bob:hunter2pass@host/x'",
    "(https://example.com)https://bob:hunter2pass@host/x",
    "https://a.com|https://bob:hunter2pass@host"
  ]) {
    const out = redactSecrets(input);
    assert(!out.includes("hunter2pass"), `userinfo survived in ${JSON.stringify(out)}`);
    assertStringIncludes(out, "https://[REDACTED]@host");
  }
});

/** The URL-userinfo regex redact.ts used before the linear scan. Quadratic: short inputs only. */
const OLD_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/** A small deterministic PRNG (mulberry32), so a failing corpus string can be reproduced. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("differential: the scan redacts every URL userinfo the old regex redacted", () => {
  const next = prng(20261101);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const schemes = ["https", "http", "git+ssh", "a.b", "x", "ftp", ""];
  const userinfoParts = ["bob", ":", "pw", "x", ".", "-", "%40", "a:b", "", "://"];
  const hosts = ["host", "github.com", "a.com", "example", "", ":"];
  const separators = ["", " ", "\t", "\n", "'", "','", ",", "(", ")", "|", ":", "/", "@", "://"];
  const noise = ["/", ":", "@", "://", "x", "a.", "@@", ":/"];
  // A URL-shaped segment: scheme, separator, optional userinfo and `@`, host, optional path.
  const url = () => {
    let u = `${pick(schemes)}://`;
    const parts = Math.floor(next() * 3);
    for (let i = 0; i < parts; i++) u += pick(userinfoParts);
    if (next() < 0.7) u += "@";
    u += pick(hosts);
    if (next() < 0.5) u += "/x";
    return u;
  };
  let oldMatches = 0;
  for (let n = 0; n < 4000; n++) {
    let input = "";
    const segments = 1 + Math.floor(next() * 4);
    for (let i = 0; i < segments; i++) {
      if (i > 0) input += pick(separators);
      input += next() < 0.75 ? url() : pick(noise);
    }
    const out = redactSecrets(input);
    // Run the old regex over the NEW output. Whatever it would still redact must already be the
    // marker; otherwise the scan missed a userinfo the old regex caught.
    for (const m of out.matchAll(OLD_USERINFO_RE)) {
      const userinfo = m[0].slice(m[1].length, -1);
      assert(userinfo.endsWith("[REDACTED]"), `missed userinfo in ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    }
    oldMatches += [...input.matchAll(OLD_USERINFO_RE)].length;
  }
  // The corpus has to exercise the old regex often enough for the comparison to mean something.
  assert(oldMatches > 1000, `corpus too weak: the old regex matched only ${oldMatches} times`);
});

Deno.test("redactSecrets removes known secrets that match no pattern", () => {
  assertEquals(redactSecrets("x opaque-secret-value y", ["opaque-secret-value"]), "x [REDACTED] y");
});

Deno.test("stderr is redacted in the result, the error message and the log", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/stderr.txt`, `${PLANTED_STDERR}\nknown: opaquetoken12345\n`);
    const noisy = await stubBinary(dir, "noisy", `cat "${dir}/stderr.txt" >&2; exit 128`);
    const { ctx, logs } = fileContext(dir, dir, { token: "opaquetoken12345", testOnly: { gitBinary: noisy } });
    const result = await runGit(
      { op: "fetch", gitDir: dir, repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A } },
      ctx
    );
    assertEquals(result.code, 128);
    assertNoSecrets(result.stderr);
    assert(!result.stderr.includes("opaquetoken12345"));
    const error = classifyGitFailure(result);
    assertInstanceOf(error, GitSyncError);
    assertEquals(error.kind, "network");
    assertNoSecrets(error.message);
    assertEquals(logs.length, 1);
    assertNoSecrets(JSON.stringify(logs));
    assert(!JSON.stringify(logs).includes("opaquetoken12345"));
    await assertRejects(
      () => runGitChecked({ op: "fetch", gitDir: dir, repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A } }, ctx),
      GitSyncError,
      "[REDACTED]"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Timeouts, deadline and output caps
// ---------------------------------------------------------------------------------------------

Deno.test("a per-call timeout kills the child and reports the signal", async () => {
  await withTempDir(async (dir) => {
    const sleeper = await stubBinary(dir, "sleeper", "exec sleep 30");
    const { ctx } = fileContext(dir, dir, { testOnly: { gitBinary: sleeper } });
    const started = performance.now();
    const result = await runGit({ op: "ls-tree", gitDir: dir, treeish: SHA_A, timeoutMs: 200 }, ctx);
    assert(performance.now() - started < 5_000);
    assert(result.timedOut);
    assertEquals(result.signal, "SIGTERM");
    assertEquals(classifyGitFailure(result)?.kind, "timeout");
    assertEquals(classifyGitFailure(result)?.retryable, true);
  });
});

Deno.test("a child that ignores SIGTERM is killed with SIGKILL after the grace period", async () => {
  await withTempDir(async (dir) => {
    const stubborn = await stubBinary(dir, "stubborn", "trap '' TERM\nexec sleep 30");
    const { ctx } = fileContext(dir, dir, { testOnly: { gitBinary: stubborn, killGraceMs: 100 } });
    const result = await runGit({ op: "ls-tree", gitDir: dir, treeish: SHA_A, timeoutMs: 200 }, ctx);
    assert(result.timedOut);
    assertEquals(result.signal, "SIGKILL");
  });
});

Deno.test("the job AbortSignal kills the child; an already-fired signal spawns nothing", async () => {
  await withTempDir(async (dir) => {
    const sleeper = await stubBinary(dir, "sleeper", "exec sleep 30");
    const deadline = new AbortController();
    const { ctx, spawns } = fileContext(dir, dir, { signal: deadline.signal, testOnly: { gitBinary: sleeper } });
    setTimeout(() => deadline.abort(), 200);
    const result = await runGit(
      { op: "fetch", gitDir: dir, repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A } },
      ctx
    );
    assert(result.aborted);
    assertEquals(result.signal, "SIGTERM");
    const error = classifyGitFailure(result);
    assertEquals(error?.kind, "deadline_exceeded");
    assertEquals(error?.retryable, true);
    assertEquals(spawns.length, 1);
    await assertRejects(() => runGit({ op: "count-objects", gitDir: dir }, ctx), GitSyncError, "deadline");
    assertEquals(spawns.length, 1);
  });
});

Deno.test("stdout past its cap kills the child and keeps exactly the cap", async () => {
  await withTempDir(async (dir) => {
    const flood = await stubBinary(dir, "flood", "exec cat /dev/zero");
    const { ctx } = fileContext(dir, dir, { testOnly: { gitBinary: flood, stdoutCapBytes: 100_000 } });
    const result = await runGit({ op: "ls-tree", gitDir: dir, treeish: SHA_A }, ctx);
    assertEquals(result.outputCapExceeded, "stdout");
    assertEquals(result.stdout.byteLength, 100_000);
    assert(result.signal !== null, "child was not killed");
    assertEquals(classifyGitFailure(result)?.kind, "output_cap_exceeded");
  });
});

Deno.test("stderr past its cap kills the child", async () => {
  await withTempDir(async (dir) => {
    const flood = await stubBinary(dir, "flood", "exec cat /dev/zero >&2");
    const { ctx } = fileContext(dir, dir, { testOnly: { gitBinary: flood, stderrCapBytes: 10_000 } });
    const result = await runGit({ op: "diff-tree", gitDir: dir, from: SHA_A, to: SHA_B, format: "raw" }, ctx);
    assertEquals(result.outputCapExceeded, "stderr");
    assert(result.signal !== null, "child was not killed");
  });
});

// ---------------------------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------------------------

const GH001_STDERR = [
  "remote: error: Trace: 0123456789abcdef",
  "remote: error: See https://gh.io/lfs for more information.",
  "remote: error: File assets/big.ppm is 120.50 MB; this exceeds GitHub's file size limit of 100.00 MB",
  "remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.",
  " ! [remote rejected] abc -> sync-to-abcdef0 (pre-receive hook declined)"
].join("\n");

Deno.test("known git failure text maps to the error types of spec §7", () => {
  const cases: Array<[string, string, GitFailureKind | null, boolean | null]> = [
    ["push", GH001_STDERR, "file_too_large", false],
    [
      "push",
      " ! [rejected]        abc -> sync-to-abcdef0 (stale info)\nerror: failed to push some refs",
      "lease_rejected",
      true
    ],
    [
      "push",
      " ! [remote rejected] abc -> sync-to-abcdef0 (cannot lock ref 'refs/heads/sync-to-abcdef0': is at 1 but expected 2)",
      "lease_rejected",
      true
    ],
    [
      "fetch",
      "fatal: remote error: upload-pack: not our ref 1111111111111111111111111111111111111111",
      "unfetchable",
      true
    ],
    [
      "fetch",
      "error: Server does not allow request for unadvertised object 1111111111111111111111111111111111111111",
      "unfetchable",
      true
    ],
    ["fetch", "fatal: couldn't find remote ref refs/heads/main", "unfetchable", true],
    ["fetch", "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502", "network", true],
    ["push", "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)", "network", true],
    [
      "fetch",
      "fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF\nfatal: index-pack failed",
      "network",
      true
    ],
    [
      "ls-remote",
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "network",
      true
    ],
    ["push", "fatal: the remote end hung up unexpectedly", "network", true],
    [
      "fetch",
      "fatal: sha1 file '/work/jobs/1.git/objects/pack/tmp_pack_x' write error: No space left on device\nfatal: early EOF",
      "disk_full",
      true
    ],
    ["update-index", "error: unable to write file: ENOSPC", "disk_full", true],
    [
      "fetch",
      "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
      "remote_repo_not_found",
      true
    ],
    ["fetch", "error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401", "auth_failed", true],
    ["push", "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403", "auth_failed", true],
    [
      "push",
      "remote: Permission to org/repo.git denied to pawtograder[bot].\nfatal: unable to access",
      "auth_failed",
      true
    ],
    ["fetch", "fatal: Authentication failed for 'https://github.com/o/r.git/'", "auth_failed", true],
    [
      "fetch",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "auth_failed",
      true
    ],
    ["fetch", "fatal: something new and strange", null, null]
  ];
  for (const [op, stderr, kind, retryable] of cases) {
    const error = classifyGitStderr(op, stderr);
    assertEquals(error?.kind ?? null, kind, `${op}: ${stderr}`);
    if (error) assertEquals(error.retryable, retryable, stderr);
  }
  const gh001 = classifyGitStderr("push", GH001_STDERR);
  assertInstanceOf(gh001, GitSyncTerminalError);
  assertEquals(gh001.reason, "file_too_large");
  assertEquals(gh001.path, "assets/big.ppm");
  assertInstanceOf(classifyGitStderr("fetch", cases[3][1]), GitUnfetchableError);
});

Deno.test("classification believes each failure only from the ops that produce it", () => {
  // A local op whose stderr echoes a path or message containing GitHub's wording.
  assertEquals(classifyGitStderr("read-tree", GH001_STDERR), null);
  assertEquals(classifyGitStderr("read-tree", "fatal: bad path 'remote: error: GH001: x'"), null);
  // On push, GH001 counts only as GitHub's own anchored line.
  assertEquals(classifyGitStderr("push", "error: src refspec GH001 does not match any"), null);
  assertEquals(classifyGitStderr("push", "remote: error: see GH001: elsewhere"), null);
  // Lease wording is only believed from push.
  assertEquals(classifyGitStderr("fetch", "error: cannot lock ref 'refs/remotes/student/main'"), null);
  assertEquals(classifyGitStderr("update-index", "fatal: (stale info) failed to update ref"), null);
  // Unfetchable wording is only believed from fetch.
  assertEquals(classifyGitStderr("cat-file", "fatal: not our ref"), null);
  // Transport wording is only believed from ops that talk to a remote.
  assertEquals(classifyGitStderr("ls-tree", "fatal: early EOF"), null);
  assertEquals(classifyGitStderr("merge-file", "error: RPC failed; HTTP 502"), null);
  // 4xx other than auth is the request's fault, not the network's.
  assertEquals(
    classifyGitStderr("push", "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413"),
    null
  );
  assertEquals(
    classifyGitStderr("fetch", "error: RPC failed; HTTP 404 curl 22 The requested URL returned error: 404"),
    null
  );
  assertEquals(
    classifyGitStderr("push", "error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503")?.kind,
    "network"
  );
});

Deno.test("gh001Path parses GitHub's line and nothing else", () => {
  assertEquals(gh001Path(GH001_STDERR), "assets/big.ppm");
  assertEquals(
    gh001Path("remote: error: File a b/c is d.bin is 101.00 MB; this exceeds GitHub's limit"),
    "a b/c is d.bin"
  );
  assertEquals(gh001Path("remote: error: File x is big; this exceeds"), undefined);
  assertEquals(gh001Path("error: File x is 101.00 MB; this exceeds"), undefined);
});

/**
 * Times `fn`, fails if it takes longer than `limitMs`, and returns the time taken. The budgets are
 * generous on purpose: the linear versions take milliseconds, the quadratic ones tens of seconds,
 * so a slow CI runner cannot blur the two.
 */
function assertFast(label: string, limitMs: number, fn: () => unknown): number {
  const started = performance.now();
  fn();
  const elapsed = performance.now() - started;
  assert(elapsed < limitMs, `${label} took ${elapsed.toFixed(0)} ms (limit ${limitMs} ms)`);
  return elapsed;
}

const PER_CALL_BUDGET_MS = 1_000;
const AGGREGATE_BUDGET_MS = 5_000;

/** 1 MiB inputs, the stderr cap, shaped to trigger backtracking in the patterns this module uses. */
const ADVERSARIAL: Array<[string, string]> = [
  ["a.a.a.", "a.".repeat(512 * 1024)],
  ["scheme chars then ://", "a".repeat(1024 * 1024 - 3) + "://"],
  ["://x repeated", "://x".repeat(256 * 1024)],
  ["File File", "remote: error: File " + "File ".repeat(200 * 1024)],
  ["File lines", "remote: error: File x is \n".repeat(40 * 1024)],
  ["is is", "remote: error: File" + " is".repeat(340 * 1024)],
  ["basic spaces", ("basic" + " ".repeat(1000)).repeat(1000)],
  ["authorization spaces", ("authorization" + " ".repeat(1000)).repeat(1000)],
  ["x-access-token", "x-access-token:".repeat(70 * 1024)],
  ["Permission to", ("Permission to " + "a".repeat(300)).repeat(3400)],
  ["returned error", "returned error: 4".repeat(60 * 1024)]
];

Deno.test("redaction is linear: 1 MiB of adversarial stderr, 1 s per call, 5 s in total", () => {
  let total = 0;
  for (const [label, input] of ADVERSARIAL) {
    total += assertFast(`redactSecrets(${label})`, PER_CALL_BUDGET_MS, () =>
      redactSecrets(input, ["some-known-secret-value"])
    );
  }
  assert(total < AGGREGATE_BUDGET_MS, `redaction took ${total.toFixed(0)} ms in total`);
});

Deno.test("classification is linear: 1 MiB of adversarial stderr, 1 s per call, 5 s in total", () => {
  let total = 0;
  for (const [label, input] of ADVERSARIAL) {
    for (const op of ["push", "fetch"]) {
      total += assertFast(`classifyGitStderr(${op}, ${label})`, PER_CALL_BUDGET_MS, () => classifyGitStderr(op, input));
    }
    total += assertFast(`gh001Path(${label})`, PER_CALL_BUDGET_MS, () => gh001Path(input));
  }
  assert(total < AGGREGATE_BUDGET_MS, `classification took ${total.toFixed(0)} ms in total`);
});

Deno.test("classifyGitFailure: clean exit is null, unknown failure is git_failed", () => {
  const base: GitResult = {
    op: "ls-tree",
    argv: [],
    code: 0,
    signal: null,
    stdout: new Uint8Array(),
    stderr: "",
    timedOut: false,
    aborted: false,
    outputCapExceeded: null,
    durationMs: 1
  };
  assertEquals(classifyGitFailure(base), null);
  assertEquals(classifyGitFailure({ ...base, code: 128, stderr: "fatal: odd" })?.kind, "git_failed");
  assertEquals(classifyGitFailure({ ...base, code: 1, signal: "SIGSEGV" })?.kind, "git_failed");
  // A kill outranks stderr, which a killed child leaves cut off.
  assertEquals(
    classifyGitFailure({ ...base, code: 143, signal: "SIGTERM", timedOut: true, stderr: "early EOF" })?.kind,
    "timeout"
  );
});

// ---------------------------------------------------------------------------------------------
// Real git
// ---------------------------------------------------------------------------------------------

Deno.test(
  { name: "git version check passes on the installed git and fails above it", ignore: SKIP_REAL_GIT },
  async () => {
    await withTempDir(async (dir) => {
      const { ctx } = fileContext(dir, dir);
      const version = await assertGitVersion(ctx);
      assert(version[0] > 2 || (version[0] === 2 && version[1] >= 43));
      const error = await assertRejects(() => assertGitVersion(ctx, [99, 0]), GitSyncError);
      assertEquals(error.kind, "git_version_unsupported");
      assertEquals(parseGitVersion("git version 2.45.2.windows.1"), [2, 45, 2]);
      assertEquals(parseGitVersion("git version 2.39.5 (Apple Git-154)"), [2, 39, 5]);
      assertEquals(parseGitVersion("nope"), null);
    });
  }
);

Deno.test(
  {
    name: "real git failures classify: lease rejection, unfetchable SHA, GH001 from the remote",
    ignore: SKIP_REAL_GIT
  },
  async () => {
    await withTempDir(async (root) => {
      const [first, second] = await makeRemote(root, "org/student", [{ "a.txt": "one\n" }, { "a.txt": "two\n" }]);
      const job = `${root}/jobs/1.git`;
      await Deno.mkdir(`${root}/jobs`, { recursive: true });
      const { ctx } = fileContext(root, `${root}/jobs`);
      await runGitChecked({ op: "init", gitDir: job }, ctx);
      await runGitChecked(
        { op: "fetch", gitDir: job, repo: "org/student", target: { kind: "sha", sha: second }, depth: 1 },
        ctx
      );

      // Unfetchable: a SHA the remote does not have.
      const missing = await runGit(
        { op: "fetch", gitDir: job, repo: "org/student", target: { kind: "sha", sha: SHA_A }, depth: 1 },
        ctx
      );
      assertInstanceOf(classifyGitFailure(missing), GitUnfetchableError);

      // Lease: create the branch at `second`, then try to move it to `first` claiming it must not
      // exist, then claiming a stale head. Both lose; the true head wins.
      await runGitChecked({ op: "fetch", gitDir: job, repo: "org/student", target: { kind: "sha", sha: first } }, ctx);
      const push = { op: "push" as const, gitDir: job, repo: "org/student", branch: GOOD_BRANCH };
      await runGitChecked({ ...push, commit: second, expect: null }, ctx);
      const absent = await runGit({ ...push, commit: first, expect: null }, ctx);
      assertEquals(classifyGitFailure(absent)?.kind, "lease_rejected");
      const stale = await runGit({ ...push, commit: first, expect: first }, ctx);
      assertEquals(classifyGitFailure(stale)?.kind, "lease_rejected");
      await runGitChecked({ ...push, commit: first, expect: second }, ctx);

      // GH001: a pre-receive hook on the remote prints GitHub's wording. The hook runs in the
      // remote's own receive-pack, so this also shows our hooksPath does not leak to the remote side.
      const hook = `${remotePath(root, "org/student")}/hooks/pre-receive`;
      await Deno.writeTextFile(
        hook,
        '#!/bin/sh\necho "error: File big/blob.bin is 150.00 MB; this exceeds GitHub\'s file size limit of 100.00 MB" >&2\n' +
          'echo "error: GH001: Large files detected." >&2\nexit 1\n'
      );
      await Deno.chmod(hook, 0o755);
      const tooLarge = await runGit({ ...push, commit: second, branch: "sync-to-1234567", expect: null }, ctx);
      const error = classifyGitFailure(tooLarge);
      assertInstanceOf(error, GitSyncTerminalError);
      assertEquals(error.reason, "file_too_large");
      assertEquals(error.path, "big/blob.bin");
    });
  }
);

/**
 * The `.gitattributes` canary (spec §8.1, WP1 acceptance). The handout's tree names `evil` merge,
 * diff and filter drivers for every path. Driver definitions that would create the canary are
 * planted everywhere config could come from: the parent environment, `$HOME/.gitconfig`,
 * `$HOME/.config/git/attributes`, the remote's config, and, as a worst case the worker never
 * produces, the job repo's own config. Every builder then runs against it.
 */
Deno.test(
  { name: "an attributes file naming drivers never runs anything through any builder", ignore: SKIP_REAL_GIT },
  async () => {
    await withTempDir(async (root) => {
      const canary = `${root}/CANARY`;
      const evil = `touch ${canary}; cat`;
      const evilConfig: Array<[string, string]> = [
        ["merge.evil.driver", `touch ${canary}`],
        ["merge.evil.name", "evil"],
        ["diff.evil.command", `touch ${canary}`],
        ["diff.evil.textconv", evil],
        ["diff.evil.binary", "false"],
        ["filter.evil.clean", evil],
        ["filter.evil.smudge", evil],
        ["filter.evil.required", "false"]
      ];
      const attributes = "* merge=evil diff=evil filter=evil text\n";
      const handout = await makeRemote(root, "org/handout", [
        { ".gitattributes": attributes, "a.txt": "one\ntwo\nthree\n", "gone.txt": "bye\n" },
        { ".gitattributes": attributes, "a.txt": "one\ntwo\nTHREE\n", "new.txt": "hi\n" }
      ]);
      const [F, H] = handout;
      const student = await makeRemote(root, "org/student", [
        { ".gitattributes": attributes, "a.txt": "one\ntwo\nthree\n", "gone.txt": "bye\n" },
        { ".gitattributes": attributes, "a.txt": "ONE\ntwo\nthree\n", "gone.txt": "bye\n" }
      ]);
      const S = student[1];
      for (const [key, value] of evilConfig) {
        for (const name of ["org/handout", "org/student"]) {
          await fixtureGit(["--git-dir", remotePath(root, name), "config", key, value], { cwd: root });
        }
      }

      // The canary mechanism works: plain git, told to read attributes from H's tree with the
      // drivers defined, does create it.
      const control = `${root}/control.git`;
      await fixtureGit(["clone", "-q", "--bare", remotePath(root, "org/handout"), control], { cwd: root });
      await fixtureGit(
        [
          "--git-dir",
          control,
          "-c",
          `diff.evil.textconv=${evil}`,
          "-c",
          `attr.tree=${H}`,
          "diff-tree",
          "-p",
          "--textconv",
          F,
          H
        ],
        { cwd: root }
      );
      assert(await exists(canary), "control: the planted driver did not run, so the canary proves nothing");
      await Deno.remove(canary);

      const home = `${root}/home`;
      await Deno.mkdir(`${home}/.config/git`, { recursive: true });
      await Deno.writeTextFile(
        `${home}/.gitconfig`,
        evilConfig.map(([k, v]) => `[${k.split(".")[0]} "evil"]\n\t${k.split(".")[2]} = "${v}"\n`).join("")
      );
      await Deno.writeTextFile(`${home}/.config/git/attributes`, attributes);
      const job = `${home}/job.git`;
      const parentConfig: Record<string, string> = { GIT_CONFIG_COUNT: String(evilConfig.length) };
      evilConfig.forEach(([k, v], i) => {
        parentConfig[`GIT_CONFIG_KEY_${i}`] = k;
        parentConfig[`GIT_CONFIG_VALUE_${i}`] = v;
      });

      await withEnv(parentConfig, async () => {
        const { ctx, spawns } = fileContext(root, home);
        await runGitChecked({ op: "init", gitDir: job }, ctx);
        for (const [key, value] of evilConfig) {
          await fixtureGit(["--git-dir", job, "config", key, value], { cwd: root });
        }
        for (const sha of [H, F]) {
          await runGitChecked(
            { op: "fetch", gitDir: job, repo: "org/handout", target: { kind: "sha", sha }, depth: 1 },
            ctx
          );
        }
        await runGitChecked(
          { op: "fetch", gitDir: job, repo: "org/student", target: { kind: "sha", sha: S }, depth: 1 },
          ctx
        );
        await runGitChecked(
          {
            op: "fetch",
            gitDir: job,
            repo: "org/student",
            target: { kind: "main", trackingRef: "refs/remotes/student/main" },
            depth: 1
          },
          ctx
        );
        // Also a worst case: HEAD resolves to a tree that carries the attributes. A bare repo reads
        // attributes from HEAD's tree unless `attr.tree` says otherwise, so this is what the
        // empty-tree override has to defeat. The worker's own job repos keep an unborn HEAD.
        await fixtureGit(["--git-dir", job, "update-ref", "refs/heads/main", H], { cwd: root });
        const branch = syncBranchFor(H);
        assertEquals(await lsRemoteSyncBranch({ gitDir: job, repo: "org/student", branch }, ctx), null);

        assertEquals(
          (await runGit({ op: "cat-file", gitDir: job, object: H, mode: "exists", peel: "commit" }, ctx)).code,
          0
        );
        assertEquals((await runGit({ op: "cat-file", gitDir: job, object: SHA_A, mode: "exists" }, ctx)).code, 1);
        assertEquals(
          text((await runGitChecked({ op: "cat-file", gitDir: job, object: H, mode: "type" }, ctx)).stdout).trim(),
          "commit"
        );
        const commitText = text(
          (await runGitChecked({ op: "cat-file", gitDir: job, object: H, mode: "commit" }, ctx)).stdout
        );
        const hTree = /^tree ([0-9a-f]{40})$/m.exec(commitText)![1];
        const hDate = /^committer .* (\d+ [+-]\d{4})$/m.exec(commitText)![1];
        await runGitChecked({ op: "cat-file", gitDir: job, object: hTree, mode: "size" }, ctx);

        const blobs = async (treeish: string) => {
          const out = text((await runGitChecked({ op: "ls-tree", gitDir: job, treeish }, ctx)).stdout);
          const map = new Map<string, string>();
          for (const record of out.split("\0").filter(Boolean)) {
            const [meta, path] = record.split("\t");
            map.set(path, meta.split(" ")[2]);
          }
          return map;
        };
        const [fBlobs, hBlobs, sBlobs] = [await blobs(F), await blobs(H), await blobs(S)];

        const raw = text(
          (await runGitChecked({ op: "diff-tree", gitDir: job, from: F, to: H, format: "raw" }, ctx)).stdout
        );
        assertEquals(
          raw
            .split("\0")
            .filter((_, i) => i % 2 === 1)
            .sort(),
          ["a.txt", "gone.txt", "new.txt"]
        );
        await runGitChecked({ op: "diff-tree", gitDir: job, from: EMPTY_TREE_SHA, to: H, format: "numstat" }, ctx);

        // Student edited line 1, handout edited line 3: a clean merge, written into the job repo.
        const merged = await runGitChecked(
          {
            op: "merge-file",
            gitDir: job,
            student: sBlobs.get("a.txt")!,
            handoutBefore: fBlobs.get("a.txt")!,
            handout: hBlobs.get("a.txt")!
          },
          ctx
        );
        const mergedOid = text(merged.stdout).trim();
        validateSha(mergedOid);

        const indexFile = `${job}/sync.index`;
        await runGitChecked({ op: "read-tree", gitDir: job, indexFile, treeish: S }, ctx);
        await runGitChecked(
          { op: "update-index", gitDir: job, indexFile, entries: [{ kind: "remove", path: "gone.txt" }] },
          ctx
        );
        await runGitChecked(
          {
            op: "update-index",
            gitDir: job,
            indexFile,
            entries: [
              { kind: "set", path: "a.txt", mode: "100644", oid: mergedOid },
              { kind: "set", path: "new.txt", mode: "100755", oid: hBlobs.get("new.txt")! }
            ]
          },
          ctx
        );
        const tree = text((await runGitChecked({ op: "write-tree", gitDir: job, indexFile }, ctx)).stdout).trim();
        const commitReq: GitRequest = {
          op: "commit-tree",
          gitDir: job,
          tree,
          parents: [S],
          message: `Sync handout updates to ${H.slice(0, 7)}\n\nbody\n`,
          identity: ID,
          date: hDate
        };
        const commit = text((await runGitChecked(commitReq, ctx)).stdout).trim();
        // Deterministic: the same inputs give the same commit.
        assertEquals(text((await runGitChecked(commitReq, ctx)).stdout).trim(), commit);
        const committed = text(
          (await runGitChecked({ op: "cat-file", gitDir: job, object: commit, mode: "commit" }, ctx)).stdout
        );
        assert(committed.endsWith(`Sync handout updates to ${H.slice(0, 7)}\n\nbody\n`));

        await runGitChecked({ op: "push", gitDir: job, repo: "org/student", commit, branch, expect: null }, ctx);
        assertEquals(await lsRemoteSyncBranch({ gitDir: job, repo: "org/student", branch }, ctx), { sha: commit });
        await runGitChecked({ op: "count-objects", gitDir: job }, ctx);

        // Merged content landed on the remote without anything materialized here.
        const landed = await fixtureGit(["--git-dir", remotePath(root, "org/student"), "show", `${commit}:a.txt`], {
          cwd: root
        });
        assertEquals(landed, "ONE\ntwo\nTHREE");

        // Every builder ran, and every spawn carried the hardening flags.
        const ops = new Set(
          spawns.map((argv) => argv.find((a, i) => i > 0 && !a.startsWith("-") && argv[i - 1] !== "-c"))
        );
        for (const op of [
          "init",
          "fetch",
          "ls-remote",
          "push",
          "diff-tree",
          "ls-tree",
          "merge-file",
          "read-tree",
          "update-index",
          "write-tree",
          "commit-tree",
          "cat-file",
          "count-objects"
        ]) {
          assert(ops.has(op), `${op} was not exercised`);
        }
        for (const argv of spawns) assertHardened(argv, job);
      });
      assert(!(await exists(canary)), "a driver ran: the canary file exists");
    });
  }
);

function assertHardened(argv: string[], gitDir: string): void {
  const configs = argv.filter((_, i) => argv[i - 1] === "-c");
  for (const required of [
    "core.hooksPath=/dev/null",
    `attr.tree=${EMPTY_TREE_SHA}`,
    "credential.helper=",
    "fetch.recurseSubmodules=false",
    "submodule.recurse=false",
    "protocol.allow=never",
    "protocol.file.allow=always",
    "core.fsmonitor=false",
    `safe.directory=${gitDir}`,
    "pack.threads=1",
    "pack.windowMemory=64m",
    "core.packedGitLimit=128m",
    "core.bigFileThreshold=16m",
    "http.lowSpeedLimit=1000",
    "http.lowSpeedTime=60"
  ]) {
    assert(configs.includes(required), `${argv.join(" ")} lacks -c ${required}`);
  }
  assert(!configs.includes("protocol.https.allow=always"), "file-mode call also allowed https");
}

Deno.test("positionals follow -- in network argv, and the lease is spelled as the spec gives it", async () => {
  await withTempDir(async (dir) => {
    const ok = await stubBinary(dir, "ok", "exit 0");
    const { ctx, spawns } = fileContext(dir, dir, { testOnly: { gitBinary: ok } });
    const url = `file://${remotePath(dir, GOOD_REPO)}`;
    await runGit({ op: "push", gitDir: dir, repo: GOOD_REPO, commit: SHA_A, branch: GOOD_BRANCH, expect: null }, ctx);
    await runGit({ op: "push", gitDir: dir, repo: GOOD_REPO, commit: SHA_A, branch: GOOD_BRANCH, expect: SHA_B }, ctx);
    await runGit({ op: "fetch", gitDir: dir, repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A }, depth: 1 }, ctx);
    await lsRemoteSyncBranch({ gitDir: dir, repo: GOOD_REPO, branch: GOOD_BRANCH }, ctx);
    const tails = spawns.map((argv) => argv.slice(argv.indexOf("--")));
    assertEquals(tails, [
      ["--", url, `${SHA_A}:refs/heads/${GOOD_BRANCH}`],
      ["--", url, `${SHA_A}:refs/heads/${GOOD_BRANCH}`],
      ["--", url, SHA_A],
      ["--", url, `refs/heads/${GOOD_BRANCH}`]
    ]);
    assert(spawns[0].includes(`--force-with-lease=refs/heads/${GOOD_BRANCH}:`));
    assert(spawns[1].includes(`--force-with-lease=refs/heads/${GOOD_BRANCH}:${SHA_B}`));
    // Production default: https only, built from owner/repo.
    const prod: GitContext = {
      home: dir,
      log: () => {},
      testOnly: { gitBinary: ok, onSpawn: (a) => spawns.push([...a]) }
    };
    await lsRemoteSyncBranch({ gitDir: dir, repo: GOOD_REPO, branch: GOOD_BRANCH }, prod);
    const last = spawns[spawns.length - 1];
    assert(last.includes(`https://github.com/${GOOD_REPO}.git`));
    assert(last.includes("protocol.https.allow=always"));
    assert(!last.includes("protocol.file.allow=always"));
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Process-group kills (no orphaned helpers)
// ---------------------------------------------------------------------------------------------

/**
 * True while `pid` exists. SIGCONT is harmless to a running process and fails with ESRCH once the
 * pid is gone. (Deno requires `--allow-all` to read `/proc/<pid>`.) An orphan is reparented and
 * reaped within milliseconds, so the zombie window does not matter to `gone()`.
 */
function alive(pid: number): Promise<boolean> {
  try {
    Deno.kill(pid, "SIGCONT");
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

/** Waits up to `ms` for `pid` to be gone. Returns whether it is gone. */
async function gone(pid: number, ms = 1_000): Promise<boolean> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (!(await alive(pid))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !(await alive(pid));
}

/** Kills a leftover test process so a failing assertion does not leave it behind. */
function reap(pid: number): void {
  try {
    Deno.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** A stand-in git that starts a long-lived grandchild and records its pid, then waits. */
async function forkingStub(dir: string, grandchild = "sleep 300"): Promise<{ bin: string; pidFile: string }> {
  const pidFile = `${dir}/grandchild.pid`;
  const bin = await stubBinary(dir, "forking", `${grandchild} &\necho $! > "${pidFile}"\nexec sleep 301`);
  return { bin, pidFile };
}

async function readPid(pidFile: string): Promise<number> {
  return Number((await Deno.readTextFile(pidFile)).trim());
}

Deno.test({
  name: "a timeout kill reaches the grandchildren git started, not only git",
  ignore: SKIP_PROCESS_GROUPS,
  fn: async () => {
    await withTempDir(async (dir) => {
      const { bin, pidFile } = await forkingStub(dir);
      const { ctx } = fileContext(dir, dir, { testOnly: { gitBinary: bin } });
      const result = await runGit({ op: "ls-tree", gitDir: dir, treeish: SHA_A, timeoutMs: 300 }, ctx);
      const pid = await readPid(pidFile);
      try {
        assert(result.timedOut);
        assert(await gone(pid), `grandchild ${pid} survived the timeout kill`);
      } finally {
        reap(pid);
      }
    });
  }
});

Deno.test({
  name: "a job-deadline abort reaches the grandchildren git started",
  ignore: SKIP_PROCESS_GROUPS,
  fn: async () => {
    await withTempDir(async (dir) => {
      const { bin, pidFile } = await forkingStub(dir);
      const deadline = new AbortController();
      const { ctx } = fileContext(dir, dir, { signal: deadline.signal, testOnly: { gitBinary: bin } });
      setTimeout(() => deadline.abort(), 300);
      const result = await runGit(
        { op: "fetch", gitDir: dir, repo: GOOD_REPO, target: { kind: "sha", sha: SHA_A } },
        ctx
      );
      const pid = await readPid(pidFile);
      try {
        assert(result.aborted);
        assert(await gone(pid), `grandchild ${pid} survived the abort`);
      } finally {
        reap(pid);
      }
    });
  }
});

Deno.test({
  name: "a grandchild that ignores SIGTERM is swept with SIGKILL once git has exited",
  ignore: SKIP_PROCESS_GROUPS,
  fn: async () => {
    await withTempDir(async (dir) => {
      // `exec` keeps the ignored disposition, so only SIGKILL stops this sleep.
      const { bin, pidFile } = await forkingStub(dir, "(trap '' TERM; exec sleep 300)");
      const { ctx } = fileContext(dir, dir, { testOnly: { gitBinary: bin, killGraceMs: 10_000 } });
      const result = await runGit({ op: "ls-tree", gitDir: dir, treeish: SHA_A, timeoutMs: 300 }, ctx);
      const pid = await readPid(pidFile);
      try {
        assert(result.timedOut);
        assertEquals(result.signal, "SIGTERM");
        // Well inside the 10 s grace: the sweep after git's exit, not the escalation timer, did it.
        assert(await gone(pid), `grandchild ${pid} that ignores SIGTERM survived`);
      } finally {
        reap(pid);
      }
    });
  }
});

/**
 * Every process whose environment has `HOME=<home>`, from `ps e` (Deno requires `--allow-all` to
 * read `/proc/<pid>/environ` directly). Each job has its own HOME, so this finds exactly the
 * processes that one test's git calls started.
 */
async function processesWithHome(home: string): Promise<Array<{ pid: number; cmdline: string }>> {
  const out = await new Deno.Command("ps", { args: ["-ww", "-e", "e", "-o", "pid=,args="], stdout: "piped" }).output();
  const needle = ` HOME=${home}`;
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .filter((line) => line.includes(`${needle} `) || line.endsWith(needle))
    .map((line) => {
      const trimmed = line.trim();
      const space = trimmed.indexOf(" ");
      return { pid: Number(trimmed.slice(0, space)), cmdline: trimmed.slice(space + 1, space + 200) };
    });
}

Deno.test({
  name: "real git: a fetch hung on a silent server leaves no git-remote-https behind",
  ignore: SKIP_REAL_GIT || SKIP_PROCESS_GROUPS,
  fn: async () => {
    await withTempDir(async (root) => {
      // Accepts connections and never answers, so curl's CONNECT through it hangs.
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const conns: Deno.Conn[] = [];
      const accepting = (async () => {
        try {
          for await (const conn of listener) conns.push(conn);
        } catch {
          // Listener closed.
        }
      })();
      const home = `${root}/home`;
      await Deno.mkdir(home);
      const proxy = `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`;
      const ctx: GitContext = {
        home,
        token: "ghs_" + "P".repeat(36),
        log: () => {},
        testOnly: { extraEnv: { https_proxy: proxy, HTTPS_PROXY: proxy } }
      };
      const job = `${home}/job.git`;
      let leftovers: Array<{ pid: number; cmdline: string }> = [];
      try {
        await runGitChecked({ op: "init", gitDir: job }, ctx);
        const result = await runGit(
          {
            op: "fetch",
            gitDir: job,
            repo: GOOD_REPO,
            target: { kind: "sha", sha: SHA_A },
            depth: 1,
            timeoutMs: 1_500
          },
          ctx
        );
        assert(result.timedOut, `fetch was not killed by the timeout: ${result.stderr}`);
        assert(conns.length > 0, "git never reached the silent server, so this proves nothing");
        await new Promise((r) => setTimeout(r, 300));
        leftovers = await processesWithHome(home);
        assertEquals(leftovers, [], "processes with the job's HOME survived the kill");
      } finally {
        for (const { pid } of leftovers) reap(pid);
        listener.close();
        for (const conn of conns) conn.close();
        await accepting;
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// ls-remote reads only the exact ref
// ---------------------------------------------------------------------------------------------

Deno.test("parseLsRemoteExact ignores tail-matching decoys and refuses duplicates", () => {
  const ref = `refs/heads/${GOOD_BRANCH}`;
  const decoy = `${SHA_A}\trefs/heads/x/${ref}\n`;
  assertEquals(parseLsRemoteExact(decoy, ref), null);
  assertEquals(parseLsRemoteExact(`${decoy}${SHA_B}\t${ref}\n`, ref), { sha: SHA_B });
  assertEquals(parseLsRemoteExact(`${SHA_B}\t${ref}\n${decoy}`, ref), { sha: SHA_B });
  assertEquals(parseLsRemoteExact("", ref), null);
  const dup = assertThrowsGit(() => parseLsRemoteExact(`${SHA_A}\t${ref}\n${SHA_B}\t${ref}\n`, ref));
  assertStringIncludes(dup.message, "more than once");
  assertThrowsGit(() => parseLsRemoteExact(`nothex\t${ref}\n`, ref));
});

function assertThrowsGit(fn: () => unknown): GitSyncError {
  try {
    fn();
  } catch (e) {
    assertInstanceOf(e, GitSyncError);
    return e;
  }
  throw new Error("did not throw");
}

Deno.test({
  name: "real git: lsRemoteSyncBranch ignores a decoy ref and finds the real branch",
  ignore: SKIP_REAL_GIT,
  fn: async () => {
    await withTempDir(async (root) => {
      const [first, second] = await makeRemote(root, "org/student", [{ "a.txt": "1\n" }, { "a.txt": "2\n" }]);
      const remote = remotePath(root, "org/student");
      const branch = GOOD_BRANCH;
      // A student can push this ref. ls-remote's tail match prints it for our pattern.
      await fixtureGit(["--git-dir", remote, "update-ref", `refs/heads/x/refs/heads/${branch}`, first], { cwd: root });
      const job = `${root}/job.git`;
      const { ctx } = fileContext(root, root);
      await runGitChecked({ op: "init", gitDir: job }, ctx);
      assertEquals(await lsRemoteSyncBranch({ gitDir: job, repo: "org/student", branch }, ctx), null);
      await fixtureGit(["--git-dir", remote, "update-ref", `refs/heads/${branch}`, second], { cwd: root });
      assertEquals(await lsRemoteSyncBranch({ gitDir: job, repo: "org/student", branch }, ctx), { sha: second });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Attribute isolation is load-bearing
// ---------------------------------------------------------------------------------------------

Deno.test({
  name: "real git: EMPTY_TREE_SHA is git's own empty tree (an unresolvable attr.tree is silently ignored)",
  ignore: SKIP_REAL_GIT,
  fn: async () => {
    await withTempDir(async (dir) => {
      assertEquals(await fixtureGit(["hash-object", "-t", "tree", "/dev/null"], { cwd: dir }), EMPTY_TREE_SHA);
    });
  }
});

/** The numstat record for `path`, such as "1\t1" or "-\t-" (binary). */
function numstatFor(output: string, path: string): string | undefined {
  const record = output.split("\0").find((r) => r.endsWith(`\t${path}`) || r === path);
  return record?.slice(0, record.lastIndexOf("\t"));
}

Deno.test({
  name: "real git: attr.tree keeps a tree's '* -diff' from turning a text diff into binary",
  ignore: SKIP_REAL_GIT,
  fn: async () => {
    await withTempDir(async (root) => {
      const attrs = "* -diff\n";
      const [F, H] = await makeRemote(root, "org/handout", [
        { ".gitattributes": attrs, "a.txt": "one\n" },
        { ".gitattributes": attrs, "a.txt": "two\n" }
      ]);
      const job = `${root}/job.git`;
      const { ctx } = fileContext(root, root);
      await runGitChecked({ op: "init", gitDir: job }, ctx);
      for (const sha of [F, H]) {
        await runGitChecked({ op: "fetch", gitDir: job, repo: "org/handout", target: { kind: "sha", sha } }, ctx);
      }
      // HEAD resolves to a tree carrying the attribute, which a bare repo would otherwise read.
      await fixtureGit(["--git-dir", job, "update-ref", "refs/heads/main", H], { cwd: root });
      const ours = text(
        (await runGitChecked({ op: "diff-tree", gitDir: job, from: F, to: H, format: "numstat" }, ctx)).stdout
      );
      assertEquals(numstatFor(ours, "a.txt"), "1\t1");
      // The same command without attr.tree (plain git, test-only) reads the attribute.
      const raw = await fixtureGit(
        ["--git-dir", job, "diff-tree", "-r", "-z", "--no-renames", "--numstat", F, H, "--"],
        {
          cwd: root
        }
      );
      assertEquals(numstatFor(raw, "a.txt"), "-\t-", "control: without attr.tree the attribute should apply");
    });
  }
});

Deno.test({
  name: "real git: core.attributesFile keeps $HOME/.config/git/attributes out",
  ignore: SKIP_REAL_GIT,
  fn: async () => {
    await withTempDir(async (root) => {
      const [F, H] = await makeRemote(root, "org/handout", [{ "a.txt": "one\n" }, { "a.txt": "two\n" }]);
      const home = `${root}/home`;
      await Deno.mkdir(`${home}/.config/git`, { recursive: true });
      await Deno.writeTextFile(`${home}/.config/git/attributes`, "* -diff\n");
      const job = `${home}/job.git`;
      const { ctx } = fileContext(root, home);
      await runGitChecked({ op: "init", gitDir: job }, ctx);
      for (const sha of [F, H]) {
        await runGitChecked({ op: "fetch", gitDir: job, repo: "org/handout", target: { kind: "sha", sha } }, ctx);
      }
      const ours = text(
        (await runGitChecked({ op: "diff-tree", gitDir: job, from: F, to: H, format: "numstat" }, ctx)).stdout
      );
      assertEquals(numstatFor(ours, "a.txt"), "1\t1");
      // fixtureGit sets HOME to its cwd, so plain git reads that attributes file.
      const raw = await fixtureGit(["--git-dir", job, "diff-tree", "-r", "-z", "--numstat", F, H, "--"], { cwd: home });
      assertEquals(numstatFor(raw, "a.txt"), "-\t-", "control: without core.attributesFile the file should apply");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Spawn failures and the startup check
// ---------------------------------------------------------------------------------------------

Deno.test("a spawn that cannot start becomes a GitSyncError, not a raw Deno error", async () => {
  await withTempDir(async (dir) => {
    const missingBinary = fileContext(dir, dir, { testOnly: { gitBinary: `${dir}/no-such-git` } }).ctx;
    const e1 = await assertRejects(() => runGit({ op: "count-objects", gitDir: dir }, missingBinary), GitSyncError);
    assertEquals(e1.kind, "spawn_failed");
    assertEquals(e1.retryable, true);
    // init runs in HOME; a job directory removed under us is a missing cwd.
    const missingCwd = fileContext(dir, `${dir}/gone`, { testOnly: { gitBinary: "/bin/true" } }).ctx;
    const e2 = await assertRejects(
      () => runGit({ op: "init", gitDir: `${dir}/gone/job.git` }, missingCwd),
      GitSyncError
    );
    assertEquals(e2.kind, "spawn_failed");
  });
});

Deno.test({
  name: "real git: assertGitRuntime passes where children get their own process group",
  ignore: SKIP_REAL_GIT || SKIP_PROCESS_GROUPS,
  fn: async () => {
    await withTempDir(async (dir) => {
      const { ctx } = fileContext(dir, dir);
      const version = await assertGitRuntime(ctx);
      assert(version[0] >= 2);
    });
  }
});
