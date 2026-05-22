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
 * Per-file coverage is merged across all tests by URL (relative to BASE_URL).
 * V8-emitted source-mapped files are resolved against the on-disk source so
 * lcov line numbers point at the .ts/.tsx source, not the compiled chunk.
 *
 * Usage:
 *   npx tsx scripts/coverage/v8-client-to-lcov.ts
 *     [--input coverage/client] [--output coverage/client.lcov]
 *     [--base-url http://localhost:3001]
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import v8toIstanbul from "v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

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

type V8Entry = { url: string; scriptId: string; source?: string; functions: unknown[] };

async function main() {
  const args = parseArgs();
  const inputDir = path.resolve(process.cwd(), args.input);
  const repoRoot = process.cwd();
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

  const map = libCoverage.createCoverageMap({});

  let entriesSeen = 0;
  let entriesUsable = 0;

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
      if (!entry.url || !entry.source) continue;
      // We only care about scripts served from the app — drop browser
      // internals, devtools, and third-party origins.
      let entryUrl: URL;
      try {
        entryUrl = new URL(entry.url);
      } catch {
        continue;
      }
      if (entryUrl.origin !== baseURL.origin) continue;
      if (!entryUrl.pathname.startsWith("/_next/")) continue;

      try {
        const converter = v8toIstanbul(
          entry.url,
          0,
          {
            // Provide the script source inline; v8-to-istanbul will consume
            // the source-map URL from inside the source to resolve back to
            // the original .ts/.tsx files.
            source: entry.source
          },
          (filepath: string) => {
            // Filter source files: keep app code, drop node_modules + webpack
            // runtime + RSC payloads.
            const norm = filepath.replace(/^file:\/\//, "");
            if (norm.includes("/node_modules/")) return true;
            if (norm.includes("/webpack/")) return true;
            if (!norm.startsWith(repoRoot)) return true;
            return false;
          }
        );
        await converter.load();
        converter.applyCoverage(entry.functions as never);
        const istanbulData = converter.toIstanbul();
        map.merge(istanbulData);
        converter.destroy();
        entriesUsable++;
      } catch (err) {
        // Common: V8 entry's sourcemap can't be found. That's fine — we
        // just lose that script. Don't spam on every one.
        if (process.env.COVERAGE_DEBUG === "1") {
          console.warn(`[v8-client-to-lcov] convert failed for ${entry.url}:`, err);
        }
      }
    }
  }

  console.error(
    `[v8-client-to-lcov] dumps=${files.length} entries_seen=${entriesSeen} entries_usable=${entriesUsable} files_with_coverage=${map.files().length}`
  );

  const context = libReport.createContext({
    dir: path.dirname(path.resolve(process.cwd(), args.output)),
    coverageMap: map
  });
  const reporter = reports.create("lcovonly", { file: path.basename(args.output) });
  reporter.execute(context);
  console.error(`[v8-client-to-lcov] wrote ${args.output}`);
}

main().catch((err) => {
  console.error("[v8-client-to-lcov] FAILED:", err);
  process.exit(1);
});
