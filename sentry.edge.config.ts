import * as Sentry from "@sentry/nextjs";

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
  integrations: [], // the defaults were never on under Bugsink; enabling them is a separate change
  tracesSampleRate: 0
});
