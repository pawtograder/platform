/**
 * Video-mode driver: run the generated replay specs with A11Y_TASKS + A11Y_VIDEO
 * set, then ALWAYS collect the videos (the collector must run after the
 * playwright process exits — that boundary is what guarantees every .webm is
 * finalized). Exits with playwright's exit code so CI still fails on red specs.
 *
 * Usage: tsx tools/a11y-judge/videos/run.ts   (npm run a11y:tasks:video)
 */
import { spawnSync } from "child_process";
import path from "path";

const runId = process.env.A11Y_VIDEO_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");

const playwright = spawnSync(
  "npx",
  ["playwright", "test", "tests/e2e/a11y-tasks", "--project=chromium", "--workers=1"],
  {
    stdio: "inherit",
    env: { ...process.env, A11Y_TASKS: "1", A11Y_VIDEO: "1" }
  }
);

const collect = spawnSync("npx", ["tsx", path.join(__dirname, "collect.ts")], {
  stdio: "inherit",
  env: { ...process.env, A11Y_VIDEO_RUN_ID: runId }
});

process.exit(playwright.status ?? collect.status ?? 1);
