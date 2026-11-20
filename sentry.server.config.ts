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
  release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.npm_package_version,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  // An array ADDS to the SDK's default integrations; it doesn't replace them. The defaults include
  // RequestData, which copies the session cookie, every header, and the query string onto error
  // events unless told otherwise. An integration passed here replaces the default of the same name.
  integrations: [Sentry.requestDataIntegration({ include: REQUEST_DATA_INCLUDE })],
  tracesSampleRate: 0,
  sendDefaultPii: false,
  beforeSend: scrubErrorEvent,
  beforeBreadcrumb: scrubBreadcrumb
});
