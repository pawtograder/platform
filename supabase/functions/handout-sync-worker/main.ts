/**
 * The handout-sync worker (docs/handout-sync-git-worker.md §3, §3.1).
 *
 * A long-running `deno run` process, not an edge function: it reads `sync_repo_to_handout`
 * messages from the `handout_sync` queue and runs each through the edge worker's own
 * `processEnvelope`, with `queue_name: "handout_sync"`, which is what sends the handler down the
 * git path (`syncRepositoryToHandoutGit`). Row bookkeeping, retries and the DLQ stay in
 * `processEnvelope`; this file owns only what a long-lived process adds around it:
 *
 * - Concurrency: at most `HANDOUT_SYNC_CONCURRENCY` jobs at once. The loop reads only as many
 *   messages as it has free slots.
 * - The heartbeat: while a job runs, `pgmq_public.set_vt` pushes its message's visibility timeout
 *   out every `HANDOUT_SYNC_HEARTBEAT_SECONDS`. A pod that dies stops renewing, so its messages
 *   are visible again within one `HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS`. A renewal that returns
 *   no row means the message is gone (archived elsewhere, or cancelled by an assignment delete),
 *   and the job is aborted and fenced.
 * - The deadline: each job gets an `AbortController` that fires after
 *   `HANDOUT_SYNC_JOB_DEADLINE_SECONDS`. The engine hands its signal to every git child, so firing
 *   it kills them, and the job fails as retryable through `processEnvelope`'s ordinary error path.
 * - SIGTERM (§3.1): stop reading, wait up to `HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS` for running
 *   jobs, then fence and abort the rest and exit without archiving them. Their messages come back
 *   after one visibility timeout, and a re-run from scratch converges (§6.1).
 * - Shadow copies (`envelope.shadow`, build plan S2) never reach `processEnvelope`. They run the
 *   plan only, with read-only tokens, and record the prediction in `handout_sync_shadow_results`.
 * - `/healthz` on `HANDOUT_SYNC_METRICS_PORT`: whether the poll loop is still turning, not whether
 *   any job is making progress, so a 14-minute push is not "unhealthy". `/metrics` on the same
 *   port: the `pawtograder_handout_sync_*` series listed in `metrics.ts`.
 *
 * FENCING. `processEnvelope` cannot be cancelled, and its error path requeues and archives. A job
 * this process gives up on (shutdown, a lost message, a job that outlives its deadline) must
 * not do either, or a message the spec says comes back after one VT would be archived instead.
 * So every job gets its own Supabase client whose fetch refuses all requests once the job is
 * fenced. Fencing comes before the abort, so the error path that the abort triggers finds the
 * database closed to it.
 */
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { GitHubAsyncEnvelope, SyncRepoToHandoutArgs } from "../_shared/GitHubAsyncTypes.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { sweepStaleJobDirs } from "../_shared/gitSync/engine.ts";
import { assertGitRuntime, type RemoteConfig } from "../_shared/gitSync/runGit.ts";
import {
  configureHandoutSyncGit,
  DEFAULT_MAX_REPO_KIB,
  type GitSyncDeps,
  HANDOUT_SYNC_QUEUE,
  planRepositoryToHandoutGit,
  type ShadowPrediction
} from "../_shared/gitSync/syncEntry.ts";
import { directorySizeBytes, TemplateCache } from "../_shared/gitSync/templateCache.ts";
import { archiveMessage, processEnvelope } from "../github-async-worker/index.ts";
import { WorkerMetrics } from "./metrics.ts";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface WorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** `HANDOUT_SYNC_CONCURRENCY`: jobs in flight at once. */
  concurrency: number;
  /** `HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS`: the VT a read sets and every renewal resets. */
  visibilityTimeoutSeconds: number;
  /** `HANDOUT_SYNC_HEARTBEAT_SECONDS`: how often a running job's VT is renewed. */
  heartbeatSeconds: number;
  /** `HANDOUT_SYNC_JOB_DEADLINE_SECONDS`: when a job's git children are killed. */
  jobDeadlineSeconds: number;
  /** `HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS`: how long SIGTERM waits for running jobs. */
  shutdownGraceSeconds: number;
  /** `HANDOUT_SYNC_MAX_READ_COUNT`: a message read more often than this goes to the DLQ. */
  maxReadCount: number;
  /** `HANDOUT_SYNC_WORK_DIR`: holds `jobs/` and `templates/`. */
  workDir: string;
  /** `HANDOUT_SYNC_WORK_LIMIT_BYTES`: the emptyDir's sizeLimit, for cache eviction. 0 = never evict. */
  workLimitBytes: number;
  /** `HANDOUT_SYNC_WORK_EVICT_PERCENT`: evict cached templates above this share of the limit (§5.1). */
  workEvictPercent: number;
  /** `HANDOUT_SYNC_MAX_REPO_KIB` (§8.4). */
  maxRepoKib: number;
  /** `HANDOUT_SYNC_MAX_MERGE_BYTES` (§5.5). */
  maxMergeBytes: number;
  /** `HANDOUT_SYNC_METRICS_PORT`: `/healthz` and `/metrics`. */
  metricsPort: number;
  /** How long the loop sleeps when the queue is empty or every slot is busy. Not an env knob. */
  idlePollMs: number;
}

/**
 * How long a job may keep its slot after its deadline fired. The abort kills git children at
 * once; this bounds the REST and database calls that run after them. Past it, the job is fenced
 * and its slot is freed, and its message comes back after one VT. The heartbeat keeps running
 * until then, so a job holds its message for at most the §3.1 deadline plus this.
 */
export const DEADLINE_SETTLE_MS = 30_000;

/**
 * After SIGTERM's grace, how long to wait for aborted jobs to reap their git children: runGit's
 * 2 s SIGTERM-to-SIGKILL escalation, its 2 s pipe drain, and the fenced error path's refused
 * writes. Spec §3.1's budget: HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS (240) + this (15) stays under
 * terminationGracePeriodSeconds (300), so the kubelet's SIGKILL lands after the cleanup, not in it.
 */
export const SHUTDOWN_ABORT_SETTLE_MS = 15_000;

/** How stale the `/work` size on `/metrics` may get. Two scrapes at the chart's 30 s interval. */
const WORK_BYTES_REFRESH_MS = 60_000;

/** `/healthz` fails once the loop has not turned for this long. */
const HEALTH_STALE_MS = 60_000;

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) {
    // Fail at startup: a pod that runs with a setting it did not ask for is harder to notice
    // than one that crashloops.
    throw new Error(`${name}=${JSON.stringify(raw)} must be an integer >= ${min}`);
  }
  return n;
}

/** Reads the environment the chart sets (charts/pawtograder/templates/handout-sync-worker.yaml). */
export function configFromEnv(): WorkerConfig {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return validateConfig({
    supabaseUrl,
    serviceRoleKey,
    concurrency: intFromEnv("HANDOUT_SYNC_CONCURRENCY", 2, 1),
    visibilityTimeoutSeconds: intFromEnv("HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS", 120, 1),
    heartbeatSeconds: intFromEnv("HANDOUT_SYNC_HEARTBEAT_SECONDS", 45, 1),
    jobDeadlineSeconds: intFromEnv("HANDOUT_SYNC_JOB_DEADLINE_SECONDS", 900, 1),
    shutdownGraceSeconds: intFromEnv("HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS", 240, 0),
    maxReadCount: intFromEnv("HANDOUT_SYNC_MAX_READ_COUNT", 5, 1),
    workDir: Deno.env.get("HANDOUT_SYNC_WORK_DIR") || "/work",
    workLimitBytes: intFromEnv("HANDOUT_SYNC_WORK_LIMIT_BYTES", 0, 0),
    workEvictPercent: intFromEnv("HANDOUT_SYNC_WORK_EVICT_PERCENT", 70, 1),
    maxRepoKib: intFromEnv("HANDOUT_SYNC_MAX_REPO_KIB", DEFAULT_MAX_REPO_KIB, 1),
    maxMergeBytes: intFromEnv("HANDOUT_SYNC_MAX_MERGE_BYTES", 8 * 1024 * 1024, 1),
    metricsPort: intFromEnv("HANDOUT_SYNC_METRICS_PORT", 9464, 1),
    idlePollMs: 5_000
  });
}

/**
 * The one coherence rule the worker cannot run without. The chart enforces the stricter
 * `2 * heartbeat <= VT`; here a renewal must at least come before the VT it renews lapses.
 */
export function validateConfig(config: WorkerConfig): WorkerConfig {
  if (config.heartbeatSeconds >= config.visibilityTimeoutSeconds) {
    throw new Error(
      `HANDOUT_SYNC_HEARTBEAT_SECONDS (${config.heartbeatSeconds}) must be below ` +
        `HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS (${config.visibilityTimeoutSeconds}), or a running ` +
        `job's message becomes visible before its first renewal`
    );
  }
  return config;
}

// ---------------------------------------------------------------------------------------------
// Queue rows
// ---------------------------------------------------------------------------------------------

/**
 * One `pgmq.message_record`, as `pgmq_public.read` and `pgmq_public.set_vt` return it. The
 * generated types give both functions `unknown[]` (a setof composite), so this is the row type
 * the worker reads them as.
 */
export interface PgmqMessageRecord<T = unknown> {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: T;
}

type Envelope = GitHubAsyncEnvelope & { original_enqueued_at?: string };

// ---------------------------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------------------------

/** Why a job's AbortController fired. */
export type AbortReason = "deadline" | "lost" | "shutdown";

/** One structured worker event. Never carries credentials or file content. */
export type WorkerEvent = { msg: string } & Record<string, unknown>;

/** Test seams. The production entry point (`import.meta.main` below) never sets any of these. */
export interface WorkerTestHooks {
  /** Replaces parts of the git path's REST and database edges (`configureHandoutSyncGit`). */
  gitDeps?: Partial<GitSyncDeps>;
  /** `file://` remotes instead of GitHub. */
  remote?: RemoteConfig;
}

class RunningJob {
  readonly controller = new AbortController();
  fenced = false;
  abortReason: AbortReason | null = null;
  readonly #stopHeartbeat = new AbortController();
  /** Resolves when the job no longer holds a slot: it settled, or it was given up on. */
  readonly released: Promise<void>;
  #release!: () => void;
  /** Resolves when `processEnvelope` (or the shadow plan) has returned. */
  settled: Promise<void> = Promise.resolve();

  constructor(readonly message: PgmqMessageRecord<Envelope>) {
    this.released = new Promise((resolve) => (this.#release = resolve));
  }

  get heartbeatSignal(): AbortSignal {
    return this.#stopHeartbeat.signal;
  }

  stopHeartbeat(): void {
    this.#stopHeartbeat.abort();
  }

  /** Closes this job's database client. Always before `abort`, see the file comment. */
  fence(): void {
    this.fenced = true;
  }

  abort(reason: AbortReason): void {
    if (this.controller.signal.aborted) return;
    this.abortReason = reason;
    this.controller.abort(new Error(`handout sync job ${this.message.msg_id} aborted: ${reason}`));
  }

  release(): void {
    this.stopHeartbeat();
    this.#release();
  }
}

/** Sleeps `ms`, or less if `signal` fires first. Never rejects. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class HandoutSyncWorker {
  readonly #config: WorkerConfig;
  readonly #admin: SupabaseClient<Database>;
  readonly #templateCache: TemplateCache;
  readonly #jobsDir: string;
  readonly #scope: Sentry.Scope;
  readonly #jobs = new Map<number, RunningJob>();
  readonly #stop = new AbortController();
  #wake = new AbortController();
  #lastTickMs = 0;
  #started = false;
  #evicting = false;
  readonly metrics = new WorkerMetrics();
  #workBytes: number | null = null;
  #workBytesAtMs = 0;

  constructor(
    config: WorkerConfig,
    private readonly testOnly: WorkerTestHooks = {}
  ) {
    this.#config = validateConfig(config);
    this.#admin = this.#client(() => false);
    this.#jobsDir = `${config.workDir}/jobs`;
    this.#templateCache = new TemplateCache(`${config.workDir}/templates`);
    this.#scope = new Sentry.Scope();
    this.#scope.setTag("function", "handout_sync_worker");
    this.#scope.setTag("queue_name", HANDOUT_SYNC_QUEUE);
  }

  /** A service-role client whose every request is refused once `fenced()` is true. */
  #client(fenced: () => boolean): SupabaseClient<Database> {
    const fencedFetch: typeof fetch = (input, init) =>
      fenced()
        ? Promise.reject(new Error("handout-sync-worker: this job is fenced; its database writes are refused"))
        : fetch(input, init);
    return createClient<Database>(this.#config.supabaseUrl, this.#config.serviceRoleKey, {
      auth: REQUEST_SCOPED_AUTH_OPTIONS,
      global: { fetch: fencedFetch }
    });
  }

  #log(event: WorkerEvent): void {
    console.log(JSON.stringify({ component: "handout-sync-worker", ...event }));
  }

  /**
   * `/metrics`. The size of `/work` is a directory walk, so it is refreshed in the background at
   * most every WORK_BYTES_REFRESH_MS and the scrape reports the last value; it is absent until the
   * first walk finishes.
   */
  renderMetrics(): string {
    if (Date.now() - this.#workBytesAtMs > WORK_BYTES_REFRESH_MS) {
      this.#workBytesAtMs = Date.now();
      directorySizeBytes(this.#config.workDir).then(
        (bytes) => (this.#workBytes = bytes),
        (e) => this.#log({ msg: "work dir size failed", error: e instanceof Error ? e.message : String(e) })
      );
    }
    return this.metrics.render({
      draining: this.#stop.signal.aborted,
      concurrency: this.#config.concurrency,
      inFlight: this.#jobs.size,
      lastTickMs: this.#lastTickMs,
      workBytes: this.#workBytes,
      workLimitBytes: this.#config.workLimitBytes
    });
  }

  /** `/healthz`: started, not stopping, and the loop has turned recently. */
  healthy(): { ok: boolean; reason: string } {
    if (!this.#started) return { ok: false, reason: "starting" };
    if (this.#stop.signal.aborted) return { ok: false, reason: "shutting down" };
    const age = Date.now() - this.#lastTickMs;
    const limit = Math.max(HEALTH_STALE_MS, 6 * this.#config.idlePollMs);
    if (age > limit) return { ok: false, reason: `poll loop last turned ${Math.round(age / 1000)}s ago` };
    return { ok: true, reason: `ok, ${this.#jobs.size}/${this.#config.concurrency} jobs` };
  }

  /** Starts SIGTERM's drain. Idempotent. */
  stop(): void {
    if (this.#stop.signal.aborted) return;
    this.#log({ msg: "stop requested; no further reads", in_flight: this.#jobs.size });
    this.#stop.abort();
  }

  /** Startup (§3.1, §8.6): git runtime checks, stale job dirs, the git path's runtime. */
  async start(): Promise<void> {
    await Deno.mkdir(this.#jobsDir, { recursive: true });
    await Deno.mkdir(`${this.#config.workDir}/templates`, { recursive: true });
    const version = await assertGitRuntime({ home: this.#jobsDir });
    const swept = await sweepStaleJobDirs(this.#jobsDir);
    configureHandoutSyncGit(
      {
        jobsDir: this.#jobsDir,
        templateCache: this.#templateCache,
        remote: this.testOnly.remote,
        maxMergeBytes: this.#config.maxMergeBytes,
        maxRepoKib: this.#config.maxRepoKib,
        signalFor: (jobId) => this.#jobs.get(Number(jobId))?.controller.signal,
        // runGit's own line per call, plus the per-op counters on /metrics.
        gitLog: (entry) => {
          this.metrics.gitCall(entry);
          console.log(JSON.stringify({ msg: "git", ...entry }));
        }
      },
      { testOnly: this.testOnly.gitDeps ? { deps: this.testOnly.gitDeps } : undefined }
    );
    this.#log({
      msg: "started",
      git_version: version.join("."),
      swept_job_dirs: swept.length,
      concurrency: this.#config.concurrency,
      visibility_timeout_s: this.#config.visibilityTimeoutSeconds,
      heartbeat_s: this.#config.heartbeatSeconds,
      job_deadline_s: this.#config.jobDeadlineSeconds,
      shutdown_grace_s: this.#config.shutdownGraceSeconds,
      max_read_count: this.#config.maxReadCount
    });
    this.#lastTickMs = Date.now();
    this.#started = true;
  }

  /** The poll loop, then the drain. Returns when every job has settled or been given up on. */
  async run(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      this.#lastTickMs = Date.now();
      const free = this.#config.concurrency - this.#jobs.size;
      let read = 0;
      if (free > 0) {
        try {
          read = await this.#readAndStart(free);
        } catch (e) {
          this.#log({ msg: "queue read failed", error: e instanceof Error ? e.message : String(e) });
          Sentry.captureException(e, this.#scope);
        }
      }
      // A full read means more may be waiting; anything else waits for a slot, the idle interval
      // or SIGTERM, whichever is first.
      if (read > 0 && read === free) continue;
      this.#wake = new AbortController();
      await sleep(this.#config.idlePollMs, AbortSignal.any([this.#wake.signal, this.#stop.signal]));
    }
    await this.#drain();
  }

  async #readAndStart(free: number): Promise<number> {
    const { data, error } = await this.#admin.schema("pgmq_public").rpc("read", {
      queue_name: HANDOUT_SYNC_QUEUE,
      sleep_seconds: this.#config.visibilityTimeoutSeconds,
      n: free
    });
    if (error) throw error;
    const messages = (data ?? []) as unknown as PgmqMessageRecord<Envelope>[];
    for (const message of messages) {
      // A SIGTERM that landed during the read: this message was claimed but will not run. It
      // comes back after one VT, exactly like one aborted by the drain.
      if (this.#stop.signal.aborted) {
        this.#log({ msg: "read after stop; leaving message for redelivery", msg_id: message.msg_id });
        continue;
      }
      this.#startJob(message);
    }
    return messages.length;
  }

  #startJob(message: PgmqMessageRecord<Envelope>): void {
    const job = new RunningJob(message);
    this.#jobs.set(message.msg_id, job);
    const shadow = message.message?.shadow === true;
    this.#log({ msg: "job started", msg_id: message.msg_id, read_ct: message.read_ct, shadow });

    const deadline = setTimeout(() => {
      this.#log({ msg: "job deadline reached; killing its git children", msg_id: message.msg_id });
      job.abort("deadline");
      // The abort reaches git, not REST or the database. If the job is still here once those have
      // had DEADLINE_SETTLE_MS, give the slot back and let the message redeliver.
      setTimeout(() => {
        if (!this.#jobs.has(message.msg_id) || this.#jobs.get(message.msg_id) !== job) return;
        this.#log({ msg: "job did not settle after its deadline; fencing it", msg_id: message.msg_id });
        job.fence();
        this.#releaseJob(job);
      }, DEADLINE_SETTLE_MS);
    }, this.#config.jobDeadlineSeconds * 1000);

    this.#heartbeat(job).catch((e) => {
      this.#log({
        msg: "heartbeat loop failed",
        msg_id: message.msg_id,
        error: e instanceof Error ? e.message : String(e)
      });
    });
    const client = this.#client(() => job.fenced);
    const scope = this.#scope.clone();
    scope.setTag("msg_id", String(message.msg_id));
    scope.setTag("read_ct", String(message.read_ct));
    const startedAt = performance.now();
    job.settled = (shadow ? this.#runShadow(job, client, scope) : this.#runEnvelope(job, client, scope))
      .catch((e): string => {
        this.#log({ msg: "job threw", msg_id: message.msg_id, error: e instanceof Error ? e.message : String(e) });
        Sentry.captureException(e, scope);
        return "error";
      })
      .then((outcome) => {
        const seconds = (performance.now() - startedAt) / 1000;
        this.metrics.jobFinished(
          shadow ? "shadow" : "sync",
          job.abortReason ? `aborted_${job.abortReason}` : outcome,
          seconds
        );
      })
      .finally(() => {
        clearTimeout(deadline);
        this.#releaseJob(job);
      });
  }

  #releaseJob(job: RunningJob): void {
    if (this.#jobs.get(job.message.msg_id) === job) this.#jobs.delete(job.message.msg_id);
    job.release();
    this.#wake.abort();
    void this.#evictIfNeeded();
  }

  /**
   * Renews the job's VT every heartbeat until the job releases its slot. A renewal that returns
   * no row means the message left the queue under us: abort the job and fence it, since whoever
   * removed the message owns what happens next. A failed renewal is only logged; the next one may
   * land, and if none does the message becomes visible, which the row guards tolerate (§6.4).
   */
  async #heartbeat(job: RunningJob): Promise<void> {
    const msgId = job.message.msg_id;
    while (!job.heartbeatSignal.aborted) {
      await sleep(this.#config.heartbeatSeconds * 1000, job.heartbeatSignal);
      if (job.heartbeatSignal.aborted) return;
      const { data, error } = await this.#admin.schema("pgmq_public").rpc("set_vt", {
        queue_name: HANDOUT_SYNC_QUEUE,
        message_id: msgId,
        vt_offset_seconds: this.#config.visibilityTimeoutSeconds
      });
      if (job.heartbeatSignal.aborted) return;
      if (error) {
        this.metrics.heartbeat("error");
        this.#log({ msg: "heartbeat failed", msg_id: msgId, error: error.message });
        continue;
      }
      const rows = (data ?? []) as unknown as PgmqMessageRecord[];
      if (rows.length === 0) {
        this.metrics.heartbeat("lost");
        this.#log({ msg: "message no longer in the queue; aborting its job", msg_id: msgId });
        job.fence();
        job.abort("lost");
        job.stopHeartbeat();
        return;
      }
      this.metrics.heartbeat("ok");
      this.#log({ msg: "heartbeat", msg_id: msgId, vt: rows[0].vt });
    }
  }

  /** Returns the job's `outcome` label for `/metrics`. */
  async #runEnvelope(job: RunningJob, client: SupabaseClient<Database>, scope: Sentry.Scope): Promise<string> {
    const { message } = job;
    const envelope = message.message;
    const ok = await processEnvelope(
      client,
      envelope,
      {
        msg_id: message.msg_id,
        // The job's first enqueue, as the edge worker passes it (processOneQueueMessage).
        enqueued_at: envelope?.original_enqueued_at ?? message.enqueued_at,
        read_ct: message.read_ct,
        queue_name: HANDOUT_SYNC_QUEUE,
        max_read_ct: this.#config.maxReadCount
      },
      scope
    );
    this.#log({ msg: "job finished", msg_id: message.msg_id, ok, fenced: job.fenced, aborted: job.abortReason });
    // `false` means processEnvelope already requeued, dead-lettered or left the message; only
    // `true` is ours to archive. A fenced client refuses the archive anyway.
    if (ok && !job.fenced) await archiveMessage(client, message.msg_id, scope, HANDOUT_SYNC_QUEUE);
    return ok ? "ok" : "failed";
  }

  /**
   * A shadow copy (build plan S2): plan only, record, archive. Recorded once per message
   * (`on conflict (msg_id) do nothing`), so a redelivery after a crash between the insert and the
   * archive adds no second row. A failed plan is recorded as the prediction's error and archived,
   * not retried: shadow runs observe the REST path and must not pile up behind it.
   */
  async #runShadow(job: RunningJob, client: SupabaseClient<Database>, scope: Sentry.Scope): Promise<string> {
    const { message } = job;
    const envelope = message.message;
    const args = envelope.args as SyncRepoToHandoutArgs;
    scope.setTag("shadow", "true");
    let prediction: ShadowPrediction;
    if (envelope.method !== "sync_repo_to_handout") {
      prediction = shadowError(`a shadow copy of ${envelope.method} has nothing to predict`);
    } else if (args.sync_strategy === "fork_merge_upstream") {
      // The REST job merges the fork's upstream through GitHub and opens no template PR, so there
      // is no git-built tree to compare it with.
      prediction = shadowError("skipped: fork_merge_upstream");
    } else if (message.read_ct > this.#config.maxReadCount) {
      prediction = shadowError(
        `read ${message.read_ct} times without finishing (cap ${this.#config.maxReadCount}); the worker was ` +
          `killed mid-plan each time`
      );
    } else {
      prediction = await planRepositoryToHandoutGit({
        repositoryFullName: args.repository_full_name,
        templateRepo: args.template_repo,
        fromSha: args.from_sha ?? null,
        toSha: args.to_sha,
        syncedRepoSha: args.synced_repo_sha ?? null,
        adminSupabase: client,
        repositoryId: args.repository_id,
        retryCount: envelope.retry_count ?? 0,
        jobId: String(message.msg_id),
        scope
      });
    }
    const { error } = await client.from("handout_sync_shadow_results").upsert(
      {
        msg_id: message.msg_id,
        repository_id: args.repository_id,
        to_sha: args.to_sha,
        from_sha: args.from_sha ?? null,
        synced_repo_sha: args.synced_repo_sha ?? null,
        ...prediction
      },
      { onConflict: "msg_id", ignoreDuplicates: true }
    );
    // Not archived: the message redelivers and the insert is tried again.
    if (error) throw error;
    this.#log({ msg: "shadow recorded", msg_id: message.msg_id, error: prediction.error });
    if (!job.fenced) await archiveMessage(client, message.msg_id, scope, HANDOUT_SYNC_QUEUE);
    return "recorded";
  }

  /**
   * SIGTERM (§3.1): no more reads (the loop has exited), up to the grace for running jobs, then
   * fence, abort and wait for the git children to be reaped. Fenced jobs archive nothing.
   */
  async #drain(): Promise<void> {
    const running = [...this.#jobs.values()];
    this.#log({ msg: "draining", in_flight: running.length, grace_s: this.#config.shutdownGraceSeconds });
    if (running.length > 0) {
      await Promise.race([
        Promise.all(running.map((j) => j.released)),
        sleep(this.#config.shutdownGraceSeconds * 1000)
      ]);
    }
    const left = [...this.#jobs.values()];
    for (const job of left) {
      this.#log({ msg: "shutdown grace over; aborting job without archiving it", msg_id: job.message.msg_id });
      job.fence();
      job.stopHeartbeat();
      job.abort("shutdown");
    }
    if (left.length > 0) {
      await Promise.race([Promise.all(left.map((j) => j.settled)), sleep(SHUTDOWN_ABORT_SETTLE_MS)]);
    }
    this.#log({ msg: "drained", aborted: left.length });
  }

  /** LRU eviction of cached templates above the configured share of `/work` (§5.1). */
  async #evictIfNeeded(): Promise<void> {
    if (this.#config.workLimitBytes <= 0 || this.#evicting) return;
    this.#evicting = true;
    try {
      const evicted = await this.#templateCache.evictToFit({
        sizeLimitBytes: this.#config.workLimitBytes,
        highWaterFraction: this.#config.workEvictPercent / 100,
        usageBytes: () => directorySizeBytes(this.#config.workDir)
      });
      if (evicted.length > 0) this.#log({ msg: "template cache evicted", evicted: evicted.length });
    } catch (e) {
      this.#log({ msg: "template cache eviction failed", error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.#evicting = false;
    }
  }
}

function shadowError(error: string): ShadowPrediction {
  return { predicted_tree: null, predicted_commit_parent: null, unresolved: null, error };
}

// ---------------------------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------------------------

/**
 * Runs the worker until SIGTERM or SIGINT has drained it, serving `/healthz` meanwhile. Returns
 * the process exit code. Tests call this with `testOnly`; the entry point below never does.
 */
export async function runWorker(config: WorkerConfig, testOnly: WorkerTestHooks = {}): Promise<number> {
  const worker = new HandoutSyncWorker(config, testOnly);
  const onSignal = () => worker.stop();
  Deno.addSignalListener("SIGTERM", onSignal);
  Deno.addSignalListener("SIGINT", onSignal);
  const server = Deno.serve({ port: config.metricsPort, hostname: "0.0.0.0", onListen: () => {} }, (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz") {
      const { ok, reason } = worker.healthy();
      return new Response(`${reason}\n`, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
    }
    if (pathname === "/metrics") {
      // Prometheus sends Accept-Encoding: gzip. Deno.serve did not compress this response on its
      // own (measured, Deno 2.9.5), so it is done here, with Content-Encoding set to match. A
      // body labelled gzip that is not, or the reverse, fails the scrape with "gzip: invalid
      // header" while curl, which does not ask for gzip, sees nothing wrong.
      const body = worker.renderMetrics();
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
        Vary: "Accept-Encoding"
      };
      if (/\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "")) {
        const gzipped = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
        return new Response(gzipped, { headers: { ...headers, "Content-Encoding": "gzip" } });
      }
      return new Response(body, { headers });
    }
    return new Response("not found\n", { status: 404 });
  });
  try {
    await worker.start();
    await worker.run();
    return 0;
  } finally {
    Deno.removeSignalListener("SIGTERM", onSignal);
    Deno.removeSignalListener("SIGINT", onSignal);
    await server.shutdown();
  }
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await runWorker(configFromEnv());
  } catch (e) {
    console.error("handout-sync-worker failed:", e instanceof Error ? e.message : String(e));
    Sentry.captureException(e);
  }
  await Sentry.flush(2000);
  // Supabase and Redis clients hold timers and sockets that would keep the process alive.
  Deno.exit(code);
}
