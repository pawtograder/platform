/**
 * Convert Chromium V8 coverage dumps (collected by Playwright's
 * `page.coverage.startJSCoverage()`) into lcov.
 *
 * Input layout (written by tests/global-setup.ts):
 *   coverage/client/<testId>.json   — { result: V8ScriptCoverage[] }
 *
 * Output:
 *   coverage/client.lcov
 *
 * Implementation uses `monocart-coverage-reports`, which is purpose-built
 * for Playwright + Next.js: it handles source-map resolution, webpack://
 * path translation, and per-test merging in one pipeline.
 *
 * Source maps are loaded from the local `.next/` build (which is
 * produced with `productionBrowserSourceMaps: true` when COVERAGE=1).
 * We don't fetch them via HTTP because Next has typically been shut
 * down by the time this script runs.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import MCR from "monocart-coverage-reports";

type Args = { input: string; output: string; baseURL: string };

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : def;
  };
  return {
    input: get("--input", "coverage/client"),
    output: get("--output", "coverage/client.lcov"),
    baseURL: get("--base-url", process.env.BASE_URL ?? "http://localhost:3001")
  };
}

type V8Entry = {
  url: string;
  scriptId?: string;
  source?: string;
  functions?: unknown[];
  sourceMap?: unknown;
};

const REPO_ROOT = process.cwd();

/**
 * Translate the URL the browser served the chunk from to the local
 * file path inside `.next/`. Returns null if it doesn't look like a
 * Next.js static asset we care about.
 *
 * Example:
 *   http://localhost:3001/_next/static/chunks/app/page-abc.js
 *     → <repo>/.next/static/chunks/app/page-abc.js
 */
function urlToLocalPath(entryUrl: string, baseURL: URL): string | null {
  let u: URL;
  try {
    u = new URL(entryUrl);
  } catch {
    return null;
  }
  if (u.origin !== baseURL.origin) return null;
  if (!u.pathname.startsWith("/_next/")) return null;
  // URL.pathname keeps percent-encoded characters (so `[course_id]`
  // arrives as `%5Bcourse_id%5D`). Decode so the path matches the
  // bracketed directory names Next.js writes to disk for dynamic
  // route segments. Without this, every dynamic-route page chunk
  // (assignments/[id], course/[course_id], etc.) silently fails to
  // load its source map.
  const decoded = decodeURIComponent(u.pathname);
  return path.join(REPO_ROOT, ".next", decoded.slice("/_next/".length));
}

async function loadSourceMap(jsPath: string): Promise<unknown | null> {
  const mapPath = `${jsPath}.map`;
  try {
    const raw = await readFile(mapPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Translate the paths monocart hands us into repo-relative paths.
 *
 * Monocart pre-strips `webpack://` from source-map URLs, so what we
 * receive looks like:
 *   "_N_E/./app/page.tsx"               → repo source file
 *   "_N_E/./components/X.tsx"           → repo source file
 *   "_N_E/?abc1"                        → synthetic webpack module (drop)
 *   "_N_E/-abc1"                        → synthetic (drop)
 *   "_N_E/../../src/client/foo.ts"      → Next.js internal (drop)
 *   "_N_E/./node_modules/..."           → vendored (drop)
 *   "localhost-3001/_next/static/..."   → dist file URL (drop; not source)
 *   "app/page.tsx"                      → already-normalized (pass through)
 *
 * Returns null for paths to drop entirely.
 */
function normalizeSourcePath(raw: string): string | null {
  // Dist files come through as `<host>-<port>/_next/...`.
  if (/^[a-z0-9.-]+\/_next\//i.test(raw)) return null;
  // Monocart re-invokes sourcePath with the result of a previous call,
  // so this function must be idempotent. Strip ONLY the known Next.js
  // webpack package-name prefix (literal `_N_E/`); anything else is
  // assumed to already be repo-relative.
  let s = raw.startsWith("_N_E/") ? raw.slice("_N_E/".length) : raw;
  // Synthetic webpack module ids like `?abc1` or `-abc1`.
  if (/^[-?]/.test(s)) return null;
  // Next.js internal sources (relative paths above repo root).
  if (s.startsWith("../")) return null;
  // Strip a leading `./`
  s = s.replace(/^\.\//, "");
  if (!s) return null;
  // Drop node_modules and webpack runtime.
  if (s.startsWith("node_modules/") || s.includes("/node_modules/")) return null;
  if (s.startsWith("(webpack)/")) return null;
  return s;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const inputDir = path.resolve(REPO_ROOT, args.input);
  const baseURL = new URL(args.baseURL);

  let files: string[];
  try {
    files = (await readdir(inputDir)).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`[v8-client-to-lcov] no input dir at ${inputDir} — nothing to do`);
    return;
  }
  if (files.length === 0) {
    console.error(`[v8-client-to-lcov] no JSON dumps in ${inputDir} — nothing to do`);
    return;
  }

  // monocart's `add()` accepts raw V8 entries. We pre-attach source
  // maps from disk because Next is no longer running and monocart's
  // default HTTP fetch would fail.
  const outputDir = path.dirname(path.resolve(REPO_ROOT, args.output));
  const outputFileName = path.basename(args.output);

  const mcr = (MCR as unknown as (opts: unknown) => unknown)({
    name: "next-client",
    outputDir,
    reports: [["lcovonly", { file: outputFileName }]],
    // CRITICAL: monocart's `clean` option defaults to TRUE and wipes
    // the entire outputDir before generating reports. Our outputDir is
    // `coverage/`, which by this point contains edge.lcov, server.lcov,
    // postgres.lcov (or .pg-ready) — all written by earlier steps in
    // collect.sh. Without this flag, monocart silently deletes them.
    clean: false,
    cleanCache: true,
    logging: "warn",
    entryFilter: (entry: { url?: string }) => {
      if (!entry.url) return false;
      try {
        const u = new URL(entry.url);
        if (u.origin !== baseURL.origin) return false;
        return u.pathname.startsWith("/_next/");
      } catch {
        return false;
      }
    },
    sourceFilter: (sourcePath: string) => {
      // After our `sourcePath` callback returns a repo-relative path,
      // restrict to the application code paths Codecov cares about.
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

  let entriesSeen = 0;
  let entriesUsable = 0;
  let mapsLoaded = 0;

  for (const name of files) {
    const raw = await readFile(path.join(inputDir, name), "utf8");
    let payload: { result?: V8Entry[] };
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      console.warn(`[v8-client-to-lcov] skipping malformed ${name}:`, err);
      continue;
    }
    const result = payload.result ?? [];

    for (const entry of result) {
      entriesSeen++;
      if (!entry.url) continue;

      const localPath = urlToLocalPath(entry.url, baseURL);
      if (!localPath) continue;

      // The per-test dumps no longer include `source` (we strip it
      // at write time to keep ~13 GB off the CI runner's disk).
      // Load the .js and .js.map from .next/ here instead.
      if (!entry.source) {
        try {
          entry.source = await readFile(localPath, "utf8");
        } catch {
          continue;
        }
      }
      const sourceMap = await loadSourceMap(localPath);
      if (sourceMap) {
        entry.sourceMap = sourceMap;
        mapsLoaded++;
      }
      entriesUsable++;
    }

    if (result.length > 0) {
      await mcr.add(result);
    }
  }

  const summary = (await mcr.generate()) as { summary?: { lines?: { pct?: number } } };

  console.error(
    `[v8-client-to-lcov] dumps=${files.length} entries_seen=${entriesSeen} entries_usable=${entriesUsable} sourcemaps_loaded=${mapsLoaded}`
  );
  const pct = summary?.summary?.lines?.pct;
  if (typeof pct === "number") {
    console.error(`[v8-client-to-lcov] line coverage: ${pct.toFixed(2)}%`);
  }
}

main().catch((err) => {
  console.error("[v8-client-to-lcov] FAILED:", err);
  process.exit(1);
});
