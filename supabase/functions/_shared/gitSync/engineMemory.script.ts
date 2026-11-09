/**
 * Entry point for the engine memory test (`enginePlan.test.ts`, "memory: …"). Run under
 * `/usr/bin/time -v`, with the fixture already built by the test process so its memory is not
 * counted.
 *
 * Usage: deno run --allow-read --allow-write --allow-run --allow-env engineMemory.script.ts <config.json>
 *
 * Prints one JSON line: `{ commit, pushed, peakRssMb }`. `peakRssMb` is this Deno process's own
 * peak RSS, sampled every 20 ms with `Deno.memoryUsage().rss`. What `time -v` reports is different:
 * the max of this process and the largest child it waited for, which here is often a git child.
 */
import { type SyncInput, withSyncJob } from "./engine.ts";
import { TemplateCache } from "./templateCache.ts";

interface Config {
  input: SyncInput;
  remotesDir: string;
  jobsDir: string;
  templatesDir: string;
}

const config: Config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
let peak = 0;
const sample = () => {
  peak = Math.max(peak, Deno.memoryUsage().rss);
};
const sampler = setInterval(sample, 20);
try {
  const result = await withSyncJob(
    {
      jobId: "memory",
      jobsDir: config.jobsDir,
      templateCache: new TemplateCache(config.templatesDir),
      remote: { protocol: "file", remoteUrlFor: (name) => `file://${config.remotesDir}/${name}.git` },
      identity: { name: "pawtograder-test[bot]", email: "1+pawtograder-test[bot]@users.noreply.github.com" },
      log: () => {},
      gitLog: () => {}
    },
    async (job) => {
      const plan = await job.plan(config.input);
      if (plan.kind !== "commit") throw new Error(`expected a commit plan, got ${plan.kind}`);
      const push = await job.push(plan, {
        confirmResetSafe: () => Promise.reject(new Error("unexpected reset"))
      });
      return { commit: plan.commit, pushed: push.pushed };
    }
  );
  sample();
  console.log(JSON.stringify({ ...result, peakRssMb: Math.round(peak / (1024 * 1024)) }));
} finally {
  clearInterval(sampler);
}
