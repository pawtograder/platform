/* eslint-disable no-console */
/**
 * Bundles the CLI into a single runnable file for publishing.
 *
 * The source lives at the repo root in `cli/` (shared with `npm run cli` and the
 * unit tests), so nothing is moved or duplicated for packaging. esbuild does two
 * jobs here that plain `tsc` cannot:
 *
 *   - resolves the `@/cli/*` tsconfig path alias, which Node has no knowledge of
 *     at runtime
 *   - inlines our own modules into one file, so the published package has no
 *     internal file layout to keep stable
 *
 * The three runtime dependencies stay external. Inlining them is tempting for a
 * zero-dependency install, but yargs pulls in y18n, which loads locale JSON from
 * disk relative to __dirname — bundling that yields subtly broken help output.
 */

import { build } from "esbuild";
import { chmod, copyFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliSrc = resolve(repoRoot, "cli");

const pkg = JSON.parse(await readFile(resolve(here, "package.json"), "utf8"));
const outfile = resolve(here, "dist/pawtograder.js");

await build({
  entryPoints: [resolve(cliSrc, "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // Keep declared dependencies (and node builtins) as runtime requires.
  packages: "external",
  alias: {
    "@/cli": cliSrc
  },
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version)
  },
  banner: {
    js: "#!/usr/bin/env node"
  },
  legalComments: "none",
  logLevel: "info"
});

// npm sets the bin bit on install, but a locally built file should be runnable
// directly too (and `npm pack` preserves the mode).
await chmod(outfile, 0o755);

// The package declares GPL-3.0-only, but npm packs only the package directory, so the
// repo-root LICENSE was outside the tarball and every release shipped the license terms
// nowhere. Copied at build time rather than duplicated in git, so the two cannot drift.
await copyFile(resolve(repoRoot, "LICENSE"), resolve(here, "LICENSE"));

console.log(`built ${outfile} (v${pkg.version})`);
