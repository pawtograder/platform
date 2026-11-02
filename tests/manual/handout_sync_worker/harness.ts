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
import { rpcTimeoutFor, runWorker, type WorkerConfig } from "../../../supabase/functions/handout-sync-worker/main.ts";
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
  workLimitBytes: num("HANDOUT_SYNC_WORK_LIMIT_BYTES", 0),
  workEvictPercent: 70,
  maxRepoKib: 2 * 1024 * 1024,
  maxMergeBytes: 8 * 1024 * 1024,
  metricsPort: num("HANDOUT_SYNC_METRICS_PORT", 55490),
  idlePollMs: 500,
  rpcTimeoutMs: rpcTimeoutFor(
    num("HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS", 120),
    num("HANDOUT_SYNC_HEARTBEAT_SECONDS", 45)
  ),
  deadlineSettleMs: num("WP5_DEADLINE_SETTLE_MS", 30_000)
};

/**
 * While `ctrl/hang-set-vt` (or `ctrl/hang-read`) exists, the worker's pgmq_public.set_vt (or
 * read) requests never answer; they end only when the caller's AbortSignal fires. While
 * `ctrl/slow-archive` exists, an archive's answer is held back for that many seconds.
 */
const hangingFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  for (const [rpc, flag] of [
    ["/rpc/set_vt", "hang-set-vt"],
    ["/rpc/read", "hang-read"]
  ] as const) {
    if (
      url.includes(rpc) &&
      (await Deno.lstat(`${ctrl}/${flag}`).then(
        () => true,
        () => false
      ))
    ) {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return await new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  }
  const response = await fetch(input, init);
  // `ctrl/slow-archive`: the archive lands, and its answer comes back seconds later.
  if (
    url.includes("/rpc/archive") &&
    (await Deno.lstat(`${ctrl}/slow-archive`).then(
      () => true,
      () => false
    ))
  ) {
    const seconds = Number(await Deno.readTextFile(`${ctrl}/slow-archive`));
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  return response;
};

const code = await runWorker(config, {
  gitDeps: harnessGitDeps(fixtureRoot, ctrl),
  remote: harnessRemote(fixtureRoot),
  fetch: hangingFetch
});
Deno.exit(code);
