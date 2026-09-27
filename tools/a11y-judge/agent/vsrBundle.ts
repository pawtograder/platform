/**
 * Builds the injectable IIFE bundle of @guidepup/virtual-screen-reader.
 *
 * The bundle is injected with page.addInitScript so it (a) evades the app CSP
 * (init scripts are delivered over CDP, not <script> tags) and (b) re-installs
 * automatically on every full navigation. addInitScript evaluates the source
 * inside a function scope, so the IIFE's top-level `var` is not a window
 * global — the explicit `window.<global> =` export line is load-bearing.
 */
import type { BuildOptions } from "esbuild";

export const VSR_GLOBAL = "__pawtograderVSR";

/** Pure config builder (unit-testable without invoking esbuild). */
export function vsrBuildOptions(entryPoint: string): BuildOptions & { write: false } {
  return {
    entryPoints: [entryPoint],
    bundle: true,
    format: "iife",
    globalName: VSR_GLOBAL,
    platform: "browser",
    write: false,
    logLevel: "silent"
  };
}

export function exportGlobalSuffix(globalName: string): string {
  return `\n;window.${globalName} = ${globalName};`;
}

let cached: string | null = null;

/** IIFE source of the virtual screen reader, built once per process. */
export function getVsrBundleSource(): string {
  if (cached === null) {
    // Lazy import: esbuild refuses to load under Jest's jsdom environment, and
    // unit tests only need the pure config builders above.
    const { buildSync } = require("esbuild") as typeof import("esbuild");
    const result = buildSync(vsrBuildOptions(require.resolve("@guidepup/virtual-screen-reader")));
    cached = result.outputFiles[0].text + exportGlobalSuffix(VSR_GLOBAL);
  }
  return cached;
}
