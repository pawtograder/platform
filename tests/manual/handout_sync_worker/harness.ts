/**
 * Starts the real handout-sync worker (`supabase/functions/handout-sync-worker/main.ts`) as a
 * separate process for `worker.scratch.test.ts`, with GitHub replaced: git talks to `file://`
 * bare repos under `WP5_FIXTURE_ROOT/remotes`, and the REST calls the git path makes go to the
 * stub in `stubs.ts`. Everything else is production code against the scratch stack.
 *
 * Test-only. It reaches the worker through `runWorker(config, testOnly)`; the worker's own entry
 * point never passes `testOnly`, so none of this is reachable from the image.
 *
 * Run with `--allow-net` limited to loopback, so any request that was meant to reach GitHub fails
 * with a permission error instead of leaving the machine.
 */
import { runWorker, type WorkerConfig } from "../../../supabase/functions/handout-sync-worker/main.ts";
import { harnessGitDeps, harnessRemote } from "./stubs.ts";

const env = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`harness: ${name} is required`);
  return v;
};
const num = (name: string, fallback: number): number => Number(Deno.env.get(name) ?? fallback);

const fixtureRoot = env("WP5_FIXTURE_ROOT");
const ctrl = env("WP5_CTRL_DIR");

const config: WorkerConfig = {
  supabaseUrl: env("SUPABASE_URL"),
  serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  concurrency: num("HANDOUT_SYNC_CONCURRENCY", 2),
  visibilityTimeoutSeconds: num("HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS", 120),
  heartbeatSeconds: num("HANDOUT_SYNC_HEARTBEAT_SECONDS", 45),
  jobDeadlineSeconds: num("HANDOUT_SYNC_JOB_DEADLINE_SECONDS", 900),
  shutdownGraceSeconds: num("HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS", 240),
  maxReadCount: num("HANDOUT_SYNC_MAX_READ_COUNT", 5),
  workDir: `${fixtureRoot}/work`,
  workLimitBytes: 0,
  workEvictPercent: 70,
  maxRepoKib: 2 * 1024 * 1024,
  maxMergeBytes: 8 * 1024 * 1024,
  metricsPort: num("HANDOUT_SYNC_METRICS_PORT", 55490),
  idlePollMs: 500
};

const code = await runWorker(config, {
  gitDeps: harnessGitDeps(fixtureRoot, ctrl),
  remote: harnessRemote(fixtureRoot)
});
Deno.exit(code);
