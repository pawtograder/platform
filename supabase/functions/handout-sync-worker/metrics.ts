/**
 * The handout-sync worker's `/metrics` (build plan WP5): Prometheus text exposition, written by
 * hand like `metrics/index.ts`, so the worker carries no metrics library.
 *
 * Every series is `pawtograder_handout_sync_*`. The chart reads two of them today:
 * `pawtograder_handout_sync_work_bytes` and `pawtograder_handout_sync_work_limit_bytes`, divided
 * per pod by PawtograderHandoutSyncWorkDiskHigh. The queue series for `handout_sync` (depth,
 * oldest message) are NOT here: the metrics edge function reports them for every queue, so they
 * exist even when the worker runs 0 replicas.
 *
 * Series:
 *
 * | name | type | labels |
 * |---|---|---|
 * | `pawtograder_handout_sync_up` | gauge | |
 * | `pawtograder_handout_sync_draining` | gauge | |
 * | `pawtograder_handout_sync_concurrency` | gauge | |
 * | `pawtograder_handout_sync_jobs_in_flight` | gauge | |
 * | `pawtograder_handout_sync_poll_loop_last_tick_timestamp_seconds` | gauge | |
 * | `pawtograder_handout_sync_jobs_total` | counter | `kind` (sync, shadow), `outcome` |
 * | `pawtograder_handout_sync_job_duration_seconds` | histogram | `kind` |
 * | `pawtograder_handout_sync_heartbeats_total` | counter | `result` (ok, error, lost) |
 * | `pawtograder_handout_sync_git_calls_total` | counter | `op`, `result` (ok, failed, killed) |
 * | `pawtograder_handout_sync_git_duration_seconds` | histogram | `op` |
 * | `pawtograder_handout_sync_work_bytes` | gauge | |
 * | `pawtograder_handout_sync_work_limit_bytes` | gauge | |
 *
 * `outcome` is `ok` (archived), `failed` (processEnvelope returned false: requeued, dead-lettered
 * or left for redelivery), `recorded` (a shadow prediction), `error` (the job threw), or
 * `aborted_deadline`, `aborted_lost`, `aborted_shutdown` when the worker aborted it.
 */
import type { GitLogEntry } from "../_shared/gitSync/runGit.ts";

const JOB_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 900, 1800];
const GIT_BUCKETS = [0.05, 0.25, 1, 5, 15, 60, 300, 600];

class Histogram {
  readonly #series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(readonly buckets: number[]) {}

  observe(labels: string, value: number): void {
    let s = this.#series.get(labels);
    if (!s) this.#series.set(labels, (s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]++;
    });
    s.sum += value;
    s.count++;
  }

  render(name: string): string[] {
    const out: string[] = [];
    for (const [labels, s] of this.#series) {
      const sep = labels ? `${labels},` : "";
      this.buckets.forEach((b, i) => out.push(`${name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
      out.push(`${name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(`${name}_sum${labels ? `{${labels}}` : ""} ${s.sum}`);
      out.push(`${name}_count${labels ? `{${labels}}` : ""} ${s.count}`);
    }
    return out;
  }
}

class Counter {
  readonly #series = new Map<string, number>();
  inc(labels: string, by = 1): void {
    this.#series.set(labels, (this.#series.get(labels) ?? 0) + by);
  }
  render(name: string): string[] {
    return [...this.#series].map(([labels, v]) => `${name}${labels ? `{${labels}}` : ""} ${v}`);
  }
}

function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export type JobKind = "sync" | "shadow";

/** The point-in-time values `/metrics` reads from the worker at each scrape. */
export interface WorkerGauges {
  draining: boolean;
  concurrency: number;
  inFlight: number;
  lastTickMs: number;
  workBytes: number | null;
  workLimitBytes: number;
}

export class WorkerMetrics {
  readonly #jobs = new Counter();
  readonly #jobDuration = new Histogram(JOB_BUCKETS);
  readonly #heartbeats = new Counter();
  readonly #gitCalls = new Counter();
  readonly #gitDuration = new Histogram(GIT_BUCKETS);

  jobFinished(kind: JobKind, outcome: string, seconds: number): void {
    this.#jobs.inc(`kind="${kind}",outcome="${label(outcome)}"`);
    this.#jobDuration.observe(`kind="${kind}"`, seconds);
  }

  heartbeat(result: "ok" | "error" | "lost"): void {
    this.#heartbeats.inc(`result="${result}"`);
  }

  gitCall(entry: GitLogEntry): void {
    const result = entry.killedBy !== null ? "killed" : entry.code === 0 && entry.signal === null ? "ok" : "failed";
    this.#gitCalls.inc(`op="${label(entry.op)}",result="${result}"`);
    this.#gitDuration.observe(`op="${label(entry.op)}"`, entry.durationMs / 1000);
  }

  render(g: WorkerGauges): string {
    const lines: string[] = [];
    const block = (name: string, type: string, help: string, body: string[]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...body);
    };
    const p = "pawtograder_handout_sync";
    block(`${p}_up`, "gauge", "1 while the worker process serves metrics", [`${p}_up 1`]);
    block(`${p}_draining`, "gauge", "1 after SIGTERM: no further reads", [`${p}_draining ${g.draining ? 1 : 0}`]);
    block(`${p}_concurrency`, "gauge", "Job slots (HANDOUT_SYNC_CONCURRENCY)", [`${p}_concurrency ${g.concurrency}`]);
    block(`${p}_jobs_in_flight`, "gauge", "Jobs holding a slot", [`${p}_jobs_in_flight ${g.inFlight}`]);
    block(
      `${p}_poll_loop_last_tick_timestamp_seconds`,
      "gauge",
      "When the poll loop last turned (what /healthz checks)",
      [`${p}_poll_loop_last_tick_timestamp_seconds ${Math.floor(g.lastTickMs / 1000)}`]
    );
    block(`${p}_jobs_total`, "counter", "Jobs finished, by kind and outcome", this.#jobs.render(`${p}_jobs_total`));
    block(
      `${p}_job_duration_seconds`,
      "histogram",
      "Wall time from read to release, by kind",
      this.#jobDuration.render(`${p}_job_duration_seconds`)
    );
    block(
      `${p}_heartbeats_total`,
      "counter",
      "Visibility-timeout renewals, by result",
      this.#heartbeats.render(`${p}_heartbeats_total`)
    );
    block(
      `${p}_git_calls_total`,
      "counter",
      "git children run, by subcommand and result",
      this.#gitCalls.render(`${p}_git_calls_total`)
    );
    block(
      `${p}_git_duration_seconds`,
      "histogram",
      "git child wall time, by subcommand",
      this.#gitDuration.render(`${p}_git_duration_seconds`)
    );
    if (g.workBytes !== null) {
      block(`${p}_work_bytes`, "gauge", "Bytes under HANDOUT_SYNC_WORK_DIR (template cache and job repos)", [
        `${p}_work_bytes ${g.workBytes}`
      ]);
    }
    if (g.workLimitBytes > 0) {
      block(`${p}_work_limit_bytes`, "gauge", "The /work emptyDir sizeLimit (HANDOUT_SYNC_WORK_LIMIT_BYTES)", [
        `${p}_work_limit_bytes ${g.workLimitBytes}`
      ]);
    }
    return lines.join("\n") + "\n";
  }
}
