/* eslint-disable @typescript-eslint/no-explicit-any */
// Must be imported FIRST in ds-entry.tsx. Some grading-closure deps reference
// the Node `process` global at module scope; esbuild defines process.env.NODE_ENV
// but not `process` itself. Shim it before those modules evaluate.
const g: any = globalThis as any;
if (!g.process) g.process = { env: { NODE_ENV: "development" }, browser: true, version: "", versions: {}, nextTick: (fn: any) => setTimeout(fn, 0) };
export {};
