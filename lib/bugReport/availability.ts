import { getClient } from "@sentry/nextjs";
import { useSyncExternalStore } from "react";
import { configuredSentryDsn, parseDsn } from "./sentryDsn";

/**
 * Whether this deployment can send bug reports. Reports go to Sentry, and a deployment
 * without a DSN (local dev, a self-hosted install without Sentry) has nowhere to send them,
 * so the entry points fall back to the GitHub issue link they had before the report dialog.
 */

/** Where to file a bug by hand when this deployment can't send reports. */
export const GITHUB_BUG_REPORT_URL =
  "https://github.com/pawtograder/platform/issues/new?labels=bug&template=bug_report.md";

/**
 * True when a browser Sentry client with a DSN exists. Always false on the server, where
 * `getClient()` would return the server SDK's client. `instrumentation-client.ts` runs before
 * any app code, so the answer is settled by the time a component first renders.
 */
export function bugReportingAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(getClient()?.getDsn());
}

/**
 * The server's guess at `bugReportingAvailable()`, from the DSN baked into the build. It
 * matches the browser unless the SDK rejected the DSN or failed to start.
 */
function serverSnapshot(): boolean {
  return parseDsn(configuredSentryDsn()) !== null;
}

const subscribe = () => () => {};

/**
 * `bugReportingAvailable()` for rendering. Server rendering and hydration use the build's
 * DSN, so a normal deployment renders the report entry points from the first paint; if the
 * browser disagrees, React re-renders after hydration instead of reporting a mismatch.
 */
export function useBugReportingAvailable(): boolean {
  return useSyncExternalStore(subscribe, bugReportingAvailable, serverSnapshot);
}
