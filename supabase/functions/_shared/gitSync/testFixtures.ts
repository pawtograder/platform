/**
 * Hermetic fixtures for the engine tests (docs/handout-sync-git-worker.md §9.1).
 *
 * Builds bare repos reached over `file://`, standing in for GitHub: a handout template and any
 * number of student repos, each commit made from a snapshot of paths to contents with plumbing,
 * so modes, symlinks, submodule entries, binary bytes and paths that are not valid UTF-8 can all
 * be expressed. Remotes serve any SHA they hold, as GitHub does (protocol v2 does not check
 * reachability, and `uploadpack.allowReachableSHA1InWant` covers v0). A SHA the remote no longer
 * has is refused with `not our ref`, which is how a rewritten-and-collected revision looks: build
 * it with `commit`, leave it unreferenced, and `gc`.
 *
 * Test scaffolding only. It spawns the system git directly, with a clean environment, to build
 * remotes and to inspect them afterwards. Nothing in the engine imports it, and the engine itself
 * runs git only through `runGit()`.
 *
 * Fixture roots live under `.test-tmp/` at the repo root (gitignored; override with
 * `GITSYNC_TEST_TMPDIR`), because the snap-packaged Deno can read neither `/tmp` nor `~/.cache`.
 */
import type { SyncJobContext } from "./engine.ts";
import type { GitLogEntry, RemoteConfig } from "./runGit.ts";
import { TemplateCache } from "./templateCache.ts";

export const TEST_ROOT =
  Deno.env.get("GITSYNC_TEST_TMPDIR") ?? new URL("../../../../.test-tmp/gitsync-engine", import.meta.url).pathname;

/**
 * True when the cases that need real git must be skipped: only when spawning `git` fails with
 * `NotFound` (the snap Deno runs in a mount namespace without the host's git), and never when `CI`
 * is set. Any other spawn error propagates and fails the file.
 */
export async function shouldSkipRealGit(file: string): Promise<boolean> {
  if (Deno.env.get("CI")) return false;
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null", stderr: "null" }).output();
    return false;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  console.error(
    [
      "",
      `!!! ${file}: \`git\` is not visible to this Deno (spawn failed with NotFound; the snap Deno does this).`,
      "!!! SKIPPED: every case that runs real git (each is listed as ignored below).",
      "!!! These cases are NOT covered by this run. Use a non-snap Deno, or set CI=1 to make the skip a failure.",
      ""
    ].join("\n")
  );
  return true;
}

export interface FixtureGitResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** The fixed identity and date every fixture commit uses unless a test overrides the date. */
export const FIXTURE_DATE = "1700000000 +0000";

/** Runs the system git for fixture setup, with an environment that ignores the developer's config. */
export async function fixtureGit(
  args: string[],
  opts: { cwd: string; stdin?: string | Uint8Array; allowFail?: boolean; env?: Record<string, string> }
): Promise<FixtureGitResult> {
  const child = new Deno.Command("git", {
    args,
    cwd: opts.cwd,
    clearEnv: true,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: opts.cwd,
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: FIXTURE_DATE,
      GIT_COMMITTER_DATE: FIXTURE_DATE,
      ...opts.env
    },
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped"
  }).spawn();
  if (opts.stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin);
    await w.close();
  }
  const out = await child.output();
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success && !opts.allowFail) {
    throw new Error(`fixture git ${args.join(" ")} failed (${out.code}): ${stderr}`);
  }
  return { code: out.code, stdout: out.stdout, stderr };
}

/** Trimmed stdout as text. */
export function text(r: FixtureGitResult): string {
  return new TextDecoder().decode(r.stdout).trim();
}

export type BlobFileMode = "100644" | "100755" | "120000";

/**
 * One path in a snapshot. A bare string or byte array is a regular file. `fromFile` hashes a file
 * already on disk, so a large fixture never has to be held in memory.
 */
export type FileSpec =
  | string
  | Uint8Array
  | { content: string | Uint8Array; mode?: BlobFileMode }
  | { fromFile: string; mode?: BlobFileMode }
  | { gitlink: string };

/** Paths to contents. Paths are UTF-8 strings; `rawPaths` on `commit` covers the other kind. */
export type Snapshot = Record<string, FileSpec>;

export interface RawPathFile {
  pathBytes: Uint8Array;
  content: string | Uint8Array;
  mode?: BlobFileMode;
}

export interface CommitOptions {
  parents?: string[];
  /** Committer and author date, `<unix seconds> <+|-HHMM>`. Defaults to `FIXTURE_DATE`. */
  date?: string;
  message?: string;
  /** Extra entries whose paths are arbitrary bytes. */
  rawPaths?: RawPathFile[];
  author?: { name: string; email: string };
}

/** A bare repo standing in for one GitHub repo. */
export class FixtureRepo {
  #tmpCounter = 0;

  constructor(
    readonly fixture: GitFixture,
    readonly fullName: string,
    readonly gitDir: string
  ) {}

  git(args: string[], opts: { stdin?: string | Uint8Array; allowFail?: boolean; env?: Record<string, string> } = {}) {
    return fixtureGit(["--git-dir", this.gitDir, ...args], { cwd: this.fixture.root, ...opts });
  }

  /** Writes a blob and returns its id. */
  async writeBlob(content: string | Uint8Array): Promise<string> {
    return text(await this.git(["hash-object", "-w", "--no-filters", "--stdin"], { stdin: content }));
  }

  async #blobFromFile(path: string): Promise<string> {
    return text(await this.git(["hash-object", "-w", "--no-filters", "--", path]));
  }

  /** Builds a commit from a snapshot, without moving any ref. Returns its SHA. */
  async commit(snapshot: Snapshot, opts: CommitOptions = {}): Promise<string> {
    const encoder = new TextEncoder();
    const records: Uint8Array[] = [];
    const record = (mode: string, oid: string, path: Uint8Array) => {
      records.push(encoder.encode(`${mode} ${oid}\t`), path, new Uint8Array([0]));
    };
    for (const [path, spec] of Object.entries(snapshot)) {
      const pathBytes = encoder.encode(path);
      if (typeof spec === "string" || spec instanceof Uint8Array) {
        record("100644", await this.writeBlob(spec), pathBytes);
      } else if ("gitlink" in spec) {
        record("160000", spec.gitlink, pathBytes);
      } else if ("fromFile" in spec) {
        record(spec.mode ?? "100644", await this.#blobFromFile(spec.fromFile), pathBytes);
      } else {
        record(spec.mode ?? "100644", await this.writeBlob(spec.content), pathBytes);
      }
    }
    for (const raw of opts.rawPaths ?? []) {
      record(raw.mode ?? "100644", await this.writeBlob(raw.content), raw.pathBytes);
    }
    const index = `${this.fixture.root}/fixture-index-${crypto.randomUUID()}-${this.#tmpCounter++}`;
    try {
      const env = { GIT_INDEX_FILE: index };
      const total = records.reduce((n, r) => n + r.length, 0);
      const stdin = new Uint8Array(total);
      let offset = 0;
      for (const r of records) {
        stdin.set(r, offset);
        offset += r.length;
      }
      // An empty snapshot is a valid commit of the empty tree.
      await this.git(["update-index", "-z", "--add", "--index-info"], { stdin, env });
      const tree = text(await this.git(["write-tree"], { env }));
      const date = opts.date ?? FIXTURE_DATE;
      const author = opts.author ?? { name: "Fixture", email: "fixture@example.com" };
      const parents = (opts.parents ?? []).flatMap((p) => ["-p", p]);
      return text(
        await this.git(["commit-tree", tree, ...parents, "-F", "-"], {
          stdin: opts.message ?? "fixture commit\n",
          env: {
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name,
            GIT_COMMITTER_EMAIL: author.email
          }
        })
      );
    } finally {
      await Deno.remove(index).catch(() => {});
    }
  }

  /**
   * Commits a snapshot on top of `branch` (or as a root commit if it does not exist) and moves the
   * branch to it. Returns the new SHA.
   */
  async commitOn(branch: string, snapshot: Snapshot, opts: Omit<CommitOptions, "parents"> = {}): Promise<string> {
    const tip = await this.ref(`refs/heads/${branch}`);
    const sha = await this.commit(snapshot, { ...opts, parents: tip ? [tip] : [] });
    await this.setRef(`refs/heads/${branch}`, sha);
    return sha;
  }

  async setRef(ref: string, sha: string): Promise<void> {
    await this.git(["update-ref", ref, sha]);
  }

  async deleteRef(ref: string): Promise<void> {
    await this.git(["update-ref", "-d", ref]);
  }

  /** The SHA a ref points at, or null. */
  async ref(ref: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", ref], { allowFail: true });
    return r.code === 0 ? text(r) : null;
  }

  /** The tree of a commit. */
  async treeOf(commit: string): Promise<string> {
    return text(await this.git(["rev-parse", `${commit}^{tree}`]));
  }

  async hasObject(oid: string): Promise<boolean> {
    return (await this.git(["cat-file", "-e", oid], { allowFail: true })).code === 0;
  }

  /** Every object id in the repo's store, reachable or not. */
  async allObjects(): Promise<Set<string>> {
    const out = text(await this.git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]));
    return new Set(out ? out.split("\n") : []);
  }

  /** Every object reachable from any ref. */
  async reachableObjects(): Promise<Set<string>> {
    const out = text(await this.git(["rev-list", "--objects", "--all", "--no-object-names"]));
    return new Set(out ? out.split("\n") : []);
  }

  /** Removes unreachable objects, as GitHub's GC eventually does after a force-push. */
  async gc(): Promise<void> {
    await this.git(["reflog", "expire", "--expire=now", "--all"]);
    await this.git(["gc", "--prune=now", "--quiet"]);
  }
}

/** One test's world: a root directory holding remotes, the template cache and job dirs. */
export class GitFixture {
  readonly remotesDir: string;
  readonly jobsDir: string;
  readonly templatesDir: string;

  private constructor(readonly root: string) {
    this.remotesDir = `${root}/remotes`;
    this.jobsDir = `${root}/jobs`;
    this.templatesDir = `${root}/templates`;
  }

  static async create(prefix = "engine-"): Promise<GitFixture> {
    await Deno.mkdir(TEST_ROOT, { recursive: true });
    return new GitFixture(await Deno.makeTempDir({ dir: TEST_ROOT, prefix }));
  }

  /** Runs `fn` with a fresh fixture and removes it afterwards. */
  static async with(fn: (fx: GitFixture) => Promise<void>, prefix?: string): Promise<void> {
    const fx = await GitFixture.create(prefix);
    try {
      await fn(fx);
    } finally {
      await Deno.remove(fx.root, { recursive: true });
    }
  }

  remotePath(fullName: string): string {
    return `${this.remotesDir}/${fullName}.git`;
  }

  /**
   * Creates an empty bare remote. `defaultBranch` sets where HEAD points, which matters only for
   * the no-`main` case.
   */
  async createRepo(fullName: string, opts: { defaultBranch?: string } = {}): Promise<FixtureRepo> {
    const gitDir = this.remotePath(fullName);
    await Deno.mkdir(gitDir, { recursive: true });
    await fixtureGit(["init", "-q", "--bare", "-b", opts.defaultBranch ?? "main", gitDir], { cwd: this.root });
    await fixtureGit(["--git-dir", gitDir, "config", "uploadpack.allowReachableSHA1InWant", "true"], {
      cwd: this.root
    });
    return new FixtureRepo(this, fullName, gitDir);
  }

  remote(): RemoteConfig {
    return { protocol: "file", remoteUrlFor: (name) => `file://${this.remotePath(name)}` };
  }

  /**
   * A job context against this fixture's remotes. Each call gets its own job id unless one is
   * given; pass the same `templateCache` to share a cache (and its mutex) between jobs.
   */
  jobContext(
    overrides: Partial<SyncJobContext> = {}
  ): SyncJobContext & { gitLogs: GitLogEntry[]; spawns: string[][]; events: Array<Record<string, unknown>> } {
    const gitLogs: GitLogEntry[] = [];
    const spawns: string[][] = [];
    const events: Array<Record<string, unknown>> = [];
    return {
      jobId: `job-${crypto.randomUUID().slice(0, 8)}`,
      jobsDir: this.jobsDir,
      templateCache: new TemplateCache(this.templatesDir),
      remote: this.remote(),
      identity: { name: "pawtograder-test[bot]", email: "1+pawtograder-test[bot]@users.noreply.github.com" },
      gitLog: (e) => gitLogs.push(e),
      log: (e) => events.push(e),
      ...overrides,
      testOnly: {
        ...overrides.testOnly,
        git: { onSpawn: (argv) => spawns.push([...argv]), ...overrides.testOnly?.git }
      },
      gitLogs,
      spawns,
      events
    };
  }
}

/**
 * Lists everything under a directory, relative to it, directories marked with a trailing `/`.
 * Used to assert a job repo is nothing but bare-repo layout.
 */
export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(rel ? `${dir}/${rel}` : dir)) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        out.push(`${child}/`);
        await walk(child);
      } else out.push(child);
    }
  };
  await walk("");
  return out.sort();
}
