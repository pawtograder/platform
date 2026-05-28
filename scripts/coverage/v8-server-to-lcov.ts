/**
 * Convert a Node Inspector `Profiler.takePreciseCoverage` dump (written
 * by `instrumentation.ts` when SIGUSR2 is received) into lcov.
 *
 * Why this exists: see the long-form note in `instrumentation.ts`.
 * Short version: `NODE_V8_COVERAGE` misses Next 15's vm-loaded Server
 * Component bundles; the Inspector path doesn't, because it runs
 * inside the same V8 isolate via `node:inspector`.
 *
 * Input: `coverage/server-cdp.json` — { result: V8ScriptCoverage[] }
 * Output: `coverage/server.lcov`
 *
 * Source paths in server-bundle sourcemaps look like
 * `webpack://@pawtograder/webapp/./app/(auth-pages)/sign-in/page.tsx`.
 * We strip the `webpack://<pkg>/./` prefix to land at `app/...`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import MCR from "monocart-coverage-reports";

const REPO_ROOT = process.cwd();
const INPUT = path.resolve(REPO_ROOT, "coverage", "server-cdp.json");
const OUTPUT = path.resolve(REPO_ROOT, "coverage", "server.lcov");

type V8Entry = {
  url: string;
  scriptId?: string;
  source?: string;
  functions?: unknown[];
  sourceMap?: unknown;
};

/**
 * Try to load the on-disk source map sibling for a server bundle.
 * Returns null if we can't find one — monocart will then fall back
 * to whatever sourceMappingURL is embedded in the script source.
 */
async function loadServerSourceMap(scriptUrl: string): Promise<unknown | null> {
  // Server-side script URLs come through as `file:///.../.next/server/...`
  // or sometimes as bare paths. Normalize.
  let filePath: string | null = null;
  if (scriptUrl.startsWith("file://")) {
    filePath = new URL(scriptUrl).pathname;
  } else if (scriptUrl.startsWith("/")) {
    filePath = scriptUrl;
  } else if (scriptUrl.includes("/.next/server/")) {
    const idx = scriptUrl.indexOf("/.next/server/");
    filePath = path.join(REPO_ROOT, scriptUrl.slice(idx + 1));
  } else {
    return null;
  }
  if (!filePath.endsWith(".js")) return null;
  try {
    const raw = await readFile(`${filePath}.map`, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize the paths monocart hands us into repo-relative paths.
 *
 * Server-bundle sourcemap sources look like:
 *   "@pawtograder/webapp/./app/(auth-pages)/sign-in/page.tsx"  → repo source
 *   "@pawtograder/webapp/./lib/foo.ts"                          → repo source
 *   "@pawtograder/webapp/../../src/...""                        → Next internal
 *   "@pawtograder/webapp/?abc1"                                 → synthetic
 *   "node_modules/..."                                          → drop
 *   "node:foo"                                                  → drop
 *   "file:///abs/path/...next/server/..."                       → drop (dist file)
 *
 * The function is called recursively by monocart with its own output,
 * so it must be idempotent.
 */
function normalizeSourcePath(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith("node:")) return null;
  if (raw.includes("/node_modules/") || raw.startsWith("node_modules/")) return null;
  if (raw.startsWith("file://")) return null;
  if (raw.includes("/.next/")) return null;

  // Strip the webpack package-name prefix Next uses for the server
  // bundle (`@pawtograder/webapp/`) when present.
  let s = raw.startsWith("@pawtograder/webapp/") ? raw.slice("@pawtograder/webapp/".length) : raw;
  // Synthetic webpack module ids (?abc1, -abc1) or external markers.
  if (/^[-?]/.test(s)) return null;
  if (s.startsWith("external ") || s.includes("(external ")) return null;
  // Next.js internals (relative above repo root).
  if (s.startsWith("../")) return null;
  s = s.replace(/^\.\//, "");
  if (!s) return null;
  if (s.startsWith("(webpack)/")) return null;
  return s;
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(INPUT, "utf8");
  } catch {
    console.error(`[v8-server-to-lcov] no input at ${INPUT} — was instrumentation.ts active?`);
    return;
  }
  let payload: { result?: V8Entry[] };
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`[v8-server-to-lcov] malformed input:`, err);
    process.exit(1);
  }
  const entries = payload.result ?? [];

  const mcr = (MCR as unknown as (opts: unknown) => unknown)({
    name: "next-server",
    outputDir: path.dirname(OUTPUT),
    reports: [["lcovonly", { file: path.basename(OUTPUT) }]],
    clean: false,
    cleanCache: true,
    logging: "warn",
    entryFilter: (entry: { url?: string }) => {
      if (!entry.url) return false;
      // Only care about our compiled server bundles and source-loaded
      // app modules. Drop node internals, node_modules, evals.
      if (entry.url.startsWith("node:")) return false;
      if (entry.url.includes("/node_modules/")) return false;
      // Anonymous eval entries from internal builds — drop them.
      if (entry.url === "" || entry.url.startsWith("evalmachine")) return false;
      return true;
    },
    sourceFilter: (sourcePath: string) => {
      if (!sourcePath) return false;
      if (sourcePath.startsWith("app/")) return true;
      if (sourcePath.startsWith("components/")) return true;
      if (sourcePath.startsWith("hooks/")) return true;
      if (sourcePath.startsWith("lib/")) return true;
      if (sourcePath.startsWith("utils/")) return true;
      return false;
    },
    sourcePath: (filePath: string) => {
      const norm = normalizeSourcePath(filePath);
      return norm ?? filePath;
    }
  }) as { add: (entries: unknown) => Promise<unknown>; generate: () => Promise<unknown> };

  let mapsLoaded = 0;
  let mapsAttempted = 0;
  // Pre-attach disk source maps where we can find them. monocart will
  // also try the embedded sourceMappingURL comment in `entry.source` as
  // a fallback, but server bundles are loaded by Node directly so the
  // comment points at a relative `.map` next to the .js, which monocart
  // can't resolve on its own (no HTTP fetcher for file paths).
  for (const entry of entries) {
    if (!entry.url || !entry.source) continue;
    mapsAttempted++;
    const sourceMap = await loadServerSourceMap(entry.url);
    if (sourceMap) {
      entry.sourceMap = sourceMap;
      mapsLoaded++;
    }
  }

  // Ensure URLs are file:// for monocart's resolver. Some entries
  // come through as bare paths.
  for (const entry of entries) {
    if (entry.url && !entry.url.includes("://") && entry.url.startsWith("/")) {
      entry.url = pathToFileURL(entry.url).href;
    }
  }

  if (entries.length === 0) {
    console.error("[v8-server-to-lcov] empty result array — nothing to do");
    return;
  }

  await mcr.add(entries);
  const summary = (await mcr.generate()) as { summary?: { lines?: { pct?: number } } };

  console.error(
    `[v8-server-to-lcov] entries=${entries.length} maps_attempted=${mapsAttempted} maps_loaded=${mapsLoaded}`
  );
  const pct = summary?.summary?.lines?.pct;
  if (typeof pct === "number") {
    console.error(`[v8-server-to-lcov] line coverage: ${pct.toFixed(2)}%`);
  }
}

main().catch((err) => {
  console.error("[v8-server-to-lcov] FAILED:", err);
  process.exit(1);
});
