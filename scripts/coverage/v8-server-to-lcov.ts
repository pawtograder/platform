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

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import MCR from "monocart-coverage-reports";

const REPO_ROOT = process.cwd();
const COVERAGE_DIR = path.resolve(REPO_ROOT, "coverage");
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
    // URL.pathname keeps percent-encoded characters, so dynamic-route
    // segments like `[course_id]` arrive as `%5Bcourse_id%5D` and the
    // on-disk read misses. Decode to the real filename (mirrors the
    // client converter, v8-client-to-lcov.ts).
    filePath = decodeURIComponent(new URL(scriptUrl).pathname);
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
  if (raw.startsWith(".next/")) return null;
  if (raw.includes("/.next/")) return null;

  // Server-bundle source maps prefix paths with `webpack://@pawtograder/webapp/`.
  // monocart strips the `webpack://` scheme AND the leading `@`, so by the
  // time the callback fires we see `pawtograder/webapp/...`. Also accept
  // `@pawtograder/webapp/...` (some flows preserve the @) and `_N_E/...`
  // (Next's edge/middleware bundles). Function must be idempotent because
  // monocart calls it recursively with its own output.
  let s = raw;
  for (const prefix of ["@pawtograder/webapp/", "pawtograder/webapp/", "_N_E/"]) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  // Synthetic webpack module ids (?abc1, -abc1) or external markers.
  if (/^[-?]/.test(s)) return null;
  if (s.startsWith("external ") || s.includes("(external ")) return null;
  // Webpack runtime helpers (webpack/bootstrap, webpack/runtime/*).
  if (s.startsWith("webpack/")) return null;
  // Next.js internals (relative above repo root).
  if (s.startsWith("../")) return null;
  s = s.replace(/^\.\//, "");
  if (!s) return null;
  if (s.startsWith("(webpack)/")) return null;
  // After stripping, anything not matching a repo dir is uninteresting.
  return s;
}

async function main(): Promise<void> {
  // Glob both dump families and feed them to monocart together — it sums
  // counts per source file, so a function executed at build time (prerender)
  // and/or at request time ends up covered:
  //   server-cdp*.json  — runtime, written by instrumentation.ts on SIGUSR2.
  //   build-cdp*.json   — build time, written by build-cdp-hook.cjs. Captures
  //                       Server Components that are prerendered at
  //                       `next build` and served from cache at runtime (so
  //                       they never re-execute and are invisible to the
  //                       runtime dump alone).
  // Each Next process (primary server, render/static-gen workers) writes its
  // own PID-suffixed dump so concurrent writes don't trash each other.
  let files: string[];
  try {
    files = (await readdir(COVERAGE_DIR)).filter((f) => /^(server|build)-cdp(-\d+)?\.json$/.test(f));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    console.error(`[v8-server-to-lcov] no server-cdp*.json / build-cdp*.json under ${COVERAGE_DIR}`);
    return;
  }
  const entries: V8Entry[] = [];
  for (const f of files) {
    const fp = path.join(COVERAGE_DIR, f);
    try {
      const raw = await readFile(fp, "utf8");
      const payload: { result?: V8Entry[] } = JSON.parse(raw);
      const r = payload.result ?? [];
      entries.push(...r);
      console.error(`[v8-server-to-lcov] loaded ${r.length} entries from ${f}`);
    } catch (err) {
      console.error(`[v8-server-to-lcov] WARN: skipping ${f}:`, err);
    }
  }

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

  // Profiler.takePreciseCoverage returns URL + functions + ranges, but
  // NOT the script source — V8 holds the source in the isolate and the
  // inspector doesn't serialize it. We have to read both the .js text
  // and its .js.map from disk ourselves and attach them; otherwise
  // monocart has nothing to map V8 byte offsets against.
  let sourcesLoaded = 0;
  let mapsLoaded = 0;
  for (const entry of entries) {
    if (!entry.url) continue;
    let filePath: string | null = null;
    if (entry.url.startsWith("file://")) {
      filePath = new URL(entry.url).pathname;
    } else if (entry.url.startsWith("/")) {
      filePath = entry.url;
    }
    if (filePath && filePath.endsWith(".js")) {
      try {
        entry.source = await readFile(filePath, "utf8");
        sourcesLoaded++;
      } catch {
        // skip
      }
      const sourceMap = await loadServerSourceMap(entry.url);
      if (sourceMap) {
        entry.sourceMap = sourceMap;
        mapsLoaded++;
      }
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
    `[v8-server-to-lcov] entries=${entries.length} sources_loaded=${sourcesLoaded} maps_loaded=${mapsLoaded}`
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
