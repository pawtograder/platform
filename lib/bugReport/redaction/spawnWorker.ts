/**
 * Starts the redaction worker. Its own module so Jest, which can't parse `import.meta`, never
 * loads it: `redactBuffer` imports it only where `Worker` exists.
 *
 * Webpack (and Turbopack) bundle `new Worker(new URL("./worker.ts", import.meta.url))` as a
 * separate same-origin chunk under `/_next/static/`, which the app's CSP allows through
 * `worker-src 'self' blob:` (utils/csp.ts).
 */
export function spawnRedactionWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "bug-report-redaction" });
}
