/**
 * The Sentry DSN the web app reports to, and the pieces of it the tunnel needs.
 *
 * `NEXT_PUBLIC_SENTRY_DSN` replaced `NEXT_PUBLIC_BUGSINK_DSN` when the backend moved from
 * Bugsink to self-hosted Sentry. The old name is still read for one release so a deployment
 * whose secrets have not been renamed keeps reporting; it logs a warning each time it is used.
 * Remove the fallback in the release after the rename.
 */

export type ParsedDsn = {
  /** "http:" or "https:" */
  protocol: string;
  /** Host and port, as `URL.host` gives them */
  host: string;
  /** Any path before the project ID, without a trailing slash ("" for a DSN at the root) */
  pathPrefix: string;
  projectId: string;
  publicKey: string;
};

/** Parses a Sentry DSN (`https://<key>@<host>[/<prefix>]/<project id>`). Returns null if it isn't one. */
export function parseDsn(dsn: string | undefined | null): ParsedDsn | null {
  if (!dsn) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const projectId = segments.pop();
  if (!projectId || !/^\d+$/.test(projectId)) return null;
  if (!url.username) return null;
  return {
    protocol: url.protocol,
    host: url.host,
    pathPrefix: segments.length > 0 ? `/${segments.join("/")}` : "",
    projectId,
    publicKey: url.username
  };
}

/** The envelope ingest URL for a parsed DSN. */
export function envelopeEndpoint(dsn: ParsedDsn): string {
  return `${dsn.protocol}//${dsn.host}${dsn.pathPrefix}/api/${dsn.projectId}/envelope/`;
}

let warnedAboutLegacyName = false;

/**
 * The configured web DSN: `NEXT_PUBLIC_SENTRY_DSN`, or the legacy `NEXT_PUBLIC_BUGSINK_DSN`
 * with a one-time console warning. Undefined when neither is set.
 */
export function configuredSentryDsn(): string | undefined {
  const current = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (current) return current;
  const legacy = process.env.NEXT_PUBLIC_BUGSINK_DSN;
  if (legacy) {
    if (!warnedAboutLegacyName) {
      warnedAboutLegacyName = true;
      // eslint-disable-next-line no-console -- one-release deprecation notice
      console.warn(
        "NEXT_PUBLIC_BUGSINK_DSN is deprecated and will stop working next release; set NEXT_PUBLIC_SENTRY_DSN"
      );
    }
    return legacy;
  }
  return undefined;
}
