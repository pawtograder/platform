import * as Sentry from "@sentry/nextjs";
import { REQUEST_DATA_INCLUDE, scrubBreadcrumb, scrubErrorEvent } from "./lib/bugReport/sentryScrub";

// NEXT_PUBLIC_SENTRY_DSN replaced NEXT_PUBLIC_BUGSINK_DSN; the old name is read for one more release.
const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.NEXT_PUBLIC_BUGSINK_DSN;
if (!process.env.NEXT_PUBLIC_SENTRY_DSN && process.env.NEXT_PUBLIC_BUGSINK_DSN) {
  // eslint-disable-next-line no-console -- one-release deprecation notice
  console.warn("NEXT_PUBLIC_BUGSINK_DSN is deprecated and will stop working next release; set NEXT_PUBLIC_SENTRY_DSN");
}

Sentry.init({
  dsn: sentryDsn,
  release:
    process.env.SENTRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA ??
    process.env.npm_package_version,
  // environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV, This should probably be Deno or something
  // An array ADDS to the SDK's default integrations; it doesn't replace them. The edge defaults
  // (fetch and console breadcrumbs among them) leave RequestData out unless sendDefaultPii is on,
  // while the auto-wrapped middleware puts the whole request, session cookie included, where
  // RequestData reads it. It's added here restricted to the method and URL, and the `beforeSend`
  // scrub (lib/bugReport/sentryScrub.ts) is the second layer, as on the server.
  integrations: [Sentry.requestDataIntegration({ include: REQUEST_DATA_INCLUDE })],
  tracesSampleRate: 0,
  sendDefaultPii: false,
  beforeSend: scrubErrorEvent,
  beforeBreadcrumb: scrubBreadcrumb
});
