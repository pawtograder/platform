/**
 * prom-client must never reach the client bundle.
 *
 * lib/metrics.ts pulls prom-client in with `await import("prom-client")` behind
 * an isNode() guard. The guard is a RUNTIME check and the bundle split is a
 * BUILD-TIME decision webpack makes from the import graph alone, so the guard
 * does not prevent the shipping — it only makes it silent. The moment anything
 * under a "use client" boundary imports the metrics helpers, every visitor
 * downloads a Node process-metrics library.
 *
 * This is a real and easy regression: instrumenting invokeEdgeFunction in
 * lib/edgeFunctions.ts would have caused it, because most of that module's
 * importers are "use client".
 *
 * There are two guards and they catch different things:
 *
 *   - scripts/check-prom-client-bundle.sh greps .next/static/chunks after a
 *     production build. That is the ground truth, and it needs a build.
 *   - this test walks the import graph statically, so it runs on every PR in
 *     milliseconds and names the exact edge that broke the invariant rather
 *     than pointing at a minified chunk hash.
 *
 * Neither replaces the other. Keep both.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";

const ROOT = resolve(__dirname, "..", "..");

// Directories that end up in the Next.js compilation. Tests, scripts, edge
// functions (Deno) and the chart are all outside it.
const SOURCE_DIRS = ["app", "lib", "components", "hooks", "utils"];

// The server-only modules whose importers must all stay server-side.
const SEEDS = ["lib/metrics.ts", "lib/routeMetrics.ts"];

const SOURCE_RE = /\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_RE.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Resolve an import specifier to a repo-relative source file, or null. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // a package, not our source

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return relative(ROOT, candidate);
    } catch {
      /* not this one */
    }
  }
  return null;
}

// Deliberately regexes and not a real parser: they over-approximate (a
// specifier inside a comment still counts), and over-approximating is the safe
// direction for a guard trying to prove an edge does NOT exist.
//
// The one thing that must NOT be over-approximated is `import type`. A
// type-only import is erased before bundling and creates no bundle edge, so
// counting it would make this test fail on things that are correct — e.g.
// hooks/useCourseController.tsx does `import type { CourseControllerInitialData }
// from "@/lib/ssrUtils"`, which is fine and must stay fine.
const STATIC_IMPORT_RE = /\b(?:import|export)\b(\s+type\b)?([^;]*?)\bfrom\s*["']([^"']+)["']/g;
const OTHER_IMPORT_RE = /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function valueImportSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(STATIC_IMPORT_RE)) {
    if (m[1]) continue; // `import type ... from` / `export type ... from`
    out.push(m[3]);
  }
  for (const m of src.matchAll(OTHER_IMPORT_RE)) out.push(m[1]);
  return out;
}

describe("prom-client stays out of the client bundle", () => {
  const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));

  // target (repo-relative) -> files that import it
  const importers = new Map<string, Set<string>>();
  const isClientModule = new Map<string, boolean>();

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = relative(ROOT, file);
    isClientModule.set(rel, /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src));
    for (const spec of valueImportSpecifiers(src)) {
      const target = resolveSpecifier(file, spec);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target)!.add(rel);
    }
  }

  it("has actually found the source tree (guards against the walk silently matching nothing)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(importers.get("lib/metrics.ts")?.size ?? 0).toBeGreaterThan(0);
  });

  it.each(SEEDS)('no "use client" module transitively imports %s', (seed) => {
    // BFS over importers, recording the chain so a failure names the edge.
    const chains = new Map<string, string[]>([[seed, [seed]]]);
    const queue = [seed];
    const offenders: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const importer of importers.get(current) ?? []) {
        if (chains.has(importer)) continue;
        const chain = [...chains.get(current)!, importer];
        chains.set(importer, chain);
        if (isClientModule.get(importer)) {
          // A "use client" file is the boundary: everything it pulls in is in
          // the client graph, so stop here and report rather than walking on.
          offenders.push([...chain].reverse().join("\n    imported by "));
          continue;
        }
        queue.push(importer);
      }
    }

    expect(offenders).toEqual([]);
  });
});
