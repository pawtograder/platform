/**
 * The per-pod handout cache (docs/handout-sync-git-worker.md §5, §5.1).
 *
 * One bare repo per template at `<root>/<owner>/<repo>.git`, holding depth-1 fetches of the
 * handout revisions jobs have asked for. Job repos reach it through `objects/info/alternates`, so
 * a 30 MB handout is downloaded once per pod and never copied per student.
 *
 * Only template objects ever enter a cache. Every write here is a `fetch` that names the template
 * remote and nothing else, so a student's objects cannot reach another student's push through it
 * (§8.3).
 */
import { GitUnfetchableError } from "./errors.ts";
import { type GitContext, runGit, runGitChecked } from "./runGit.ts";
import { validateLocalPath, validateRepoFullName, validateSha } from "./validate.ts";

/** What `ensureCommits` found for one requested SHA. */
export type CacheFetchOutcome = "present" | "fetched" | "unfetchable";

export interface EnsureCommitsResult {
  outcomes: Map<string, CacheFetchOutcome>;
  /** Lock files left by a killed git that were deleted before fetching. */
  staleLocksRemoved: string[];
}

export class TemplateCache {
  /** Tail of the per-template promise chain. Each holder of the lock appends to it. */
  #locks = new Map<string, Promise<void>>();
  /** Jobs currently reading a cache through their alternates. Eviction skips these. */
  #leases = new Map<string, number>();
  #lastUsed = new Map<string, number>();

  constructor(readonly root: string) {
    validateLocalPath(root, "template cache root");
  }

  /**
   * The cache directory for a template. GitHub names are case-insensitive, so the path is
   * lowercased: `Org/Handout` and `org/handout` are one repo and share one cache.
   */
  dirFor(templateRepo: string): string {
    const [owner, repo] = validateRepoFullName(templateRepo, "template repo").toLowerCase().split("/");
    return `${this.root}/${owner}/${repo}.git`;
  }

  /**
   * Runs `fn` while holding the in-process mutex for this template (§5.1). Fetches into one cache
   * dir must not overlap: two `fetch --depth=1` calls both take `shallow.lock`, and the loser
   * fails. Across pods nothing is shared, so in-process is enough.
   */
  async withLock<T>(templateRepo: string, fn: () => Promise<T>): Promise<T> {
    return await this.#withDirLock(this.dirFor(templateRepo), fn);
  }

  async #withDirLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.#locks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Drop the entry once nobody is queued behind us, so the map does not grow per template.
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  /**
   * Marks a template's cache as in use by one job, so eviction leaves it alone while the job's
   * alternates point at it. Returns the release function.
   */
  acquire(templateRepo: string): () => void {
    const key = this.dirFor(templateRepo);
    this.#leases.set(key, (this.#leases.get(key) ?? 0) + 1);
    this.#lastUsed.set(key, Date.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.#leases.get(key) ?? 1) - 1;
      if (n <= 0) this.#leases.delete(key);
      else this.#leases.set(key, n);
      this.#lastUsed.set(key, Date.now());
    };
  }

  /**
   * Makes each SHA available as a commit in the template's cache, fetching depth 1 from the
   * template remote where it is missing (§5.1):
   *
   *   git -C $TCACHE cat-file -e $SHA^{commit} || git -C $TCACHE fetch --depth=1 --no-tags $T_URL $SHA
   *
   * A SHA the remote will not serve is reported as `unfetchable`, not thrown: whether that is
   * degraded (`F`) or retryable (`H`) is the engine's call. Any other failure throws.
   *
   * `ctx.home` must exist; the cache is created under the lock if it does not.
   */
  async ensureCommits(templateRepo: string, shas: readonly string[], ctx: GitContext): Promise<EnsureCommitsResult> {
    const gitDir = this.dirFor(templateRepo);
    for (const sha of shas) validateSha(sha, "template sha");
    return await this.withLock(templateRepo, async () => {
      this.#lastUsed.set(gitDir, Date.now());
      const outcomes = new Map<string, CacheFetchOutcome>();
      const staleLocksRemoved: string[] = [];
      if (!(await isInitialized(gitDir))) {
        await Deno.mkdir(gitDir, { recursive: true });
        // Re-running init over a half-made directory from a killed init is harmless.
        await runGitChecked({ op: "init", gitDir }, ctx);
      }
      let cleaned = false;
      for (const sha of shas) {
        if (outcomes.has(sha)) continue;
        const exists = await runGit({ op: "cat-file", gitDir, object: sha, mode: "exists", peel: "commit" }, ctx);
        if (exists.code === 0 && exists.signal === null) {
          outcomes.set(sha, "present");
          continue;
        }
        // This mutex is the only writer of the cache, and we hold it, so any lock file in the
        // directory now was left by a git that was killed mid-fetch (a SIGKILL at the job
        // deadline gives git no chance to remove `shallow.lock`). Left in place, every later
        // fetch into this template fails until the pod restarts.
        if (!cleaned) {
          staleLocksRemoved.push(...(await removeStaleLocks(gitDir)));
          cleaned = true;
        }
        try {
          await runGitChecked({ op: "fetch", gitDir, repo: templateRepo, target: { kind: "sha", sha }, depth: 1 }, ctx);
          outcomes.set(sha, "fetched");
        } catch (e) {
          if (e instanceof GitUnfetchableError) {
            outcomes.set(sha, "unfetchable");
            continue;
          }
          throw e;
        }
      }
      return { outcomes, staleLocksRemoved };
    });
  }

  /**
   * Removes least recently used caches until the work volume is under `highWaterFraction` of
   * `sizeLimitBytes` (§5.1: 70 % of the emptyDir's `sizeLimit`). A cache with a live lease is
   * skipped, since a running job reads it through its alternates. Returns the evicted dirs.
   *
   * `usageBytes` measures the whole volume (jobs and caches), because that is what the kubelet
   * compares against `sizeLimit`.
   */
  async evictToFit(opts: {
    sizeLimitBytes: number;
    highWaterFraction?: number;
    usageBytes: () => Promise<number>;
  }): Promise<string[]> {
    const target = opts.sizeLimitBytes * (opts.highWaterFraction ?? 0.7);
    let usage = await opts.usageBytes();
    if (usage <= target) return [];
    const evicted: string[] = [];
    for (const dir of await this.#byLeastRecentlyUsed()) {
      if (usage <= target) break;
      if (await this.#evictIfIdle(dir)) {
        evicted.push(dir);
        usage = await opts.usageBytes();
      }
    }
    return evicted;
  }

  /**
   * Removes every cache no job is using. The response to `ENOSPC` (§7): the next attempt
   * re-fetches what it needs into the space this frees.
   */
  async evictAllIdle(): Promise<string[]> {
    const evicted: string[] = [];
    for (const dir of await this.#byLeastRecentlyUsed()) {
      if (await this.#evictIfIdle(dir)) evicted.push(dir);
    }
    return evicted;
  }

  async #evictIfIdle(dir: string): Promise<boolean> {
    return await this.#withDirLock(dir, async () => {
      if (this.#leases.has(dir)) return false;
      await Deno.remove(dir, { recursive: true }).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
      this.#lastUsed.delete(dir);
      return true;
    });
  }

  async #byLeastRecentlyUsed(): Promise<string[]> {
    const dirs: Array<{ dir: string; used: number }> = [];
    for (const owner of await listDir(this.root)) {
      if (!owner.isDirectory) continue;
      for (const repo of await listDir(`${this.root}/${owner.name}`)) {
        if (!repo.isDirectory || !repo.name.endsWith(".git")) continue;
        const dir = `${this.root}/${owner.name}/${repo.name}`;
        // After a restart nothing is in memory, and the directory's mtime is the best guess.
        const used = this.#lastUsed.get(dir) ?? (await Deno.stat(dir)).mtime?.getTime() ?? 0;
        dirs.push({ dir, used });
      }
    }
    return dirs.sort((a, b) => a.used - b.used).map((d) => d.dir);
  }
}

async function listDir(dir: string): Promise<Deno.DirEntry[]> {
  try {
    return await Array.fromAsync(Deno.readDir(dir));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}

async function isInitialized(gitDir: string): Promise<boolean> {
  try {
    await Deno.stat(`${gitDir}/HEAD`);
    await Deno.stat(`${gitDir}/objects`);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/** Loose-object fan-out directories. They hold only objects, never locks, and there can be 256. */
const LOOSE_OBJECT_DIR_RE = /^objects\/[0-9a-f]{2}$/;

/**
 * Deletes every `*.lock` file under a git dir and returns their paths relative to it. Only safe
 * while holding the cache mutex, which is what makes every lock found here stale.
 */
export async function removeStaleLocks(gitDir: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await listDir(rel ? `${gitDir}/${rel}` : gitDir)) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (!LOOSE_OBJECT_DIR_RE.test(child)) await walk(child);
      } else if (entry.name.endsWith(".lock")) {
        await Deno.remove(`${gitDir}/${child}`).catch((e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        });
        removed.push(child);
      }
    }
  };
  await walk("");
  return removed;
}

/**
 * Total size in bytes of the regular files under `dir`, without following symlinks. Used to
 * measure the work volume for `evictToFit`, since Deno has no `statfs`.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await listDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) total += await directorySizeBytes(path);
    else if (entry.isFile) {
      try {
        total += (await Deno.lstat(path)).size;
      } catch (e) {
        // Removed between the listing and the stat, by a job finishing.
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  }
  return total;
}
