import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_BUGSINK_DSN,
  sendDefaultPii: true,
  release: "pawtograder-mvp",
  integrations: [],
  tracesSampleRate: 0
});
