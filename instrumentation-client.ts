import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_BUGSINK_DSN,
  tunnel: "/api/tunnel",

  sendDefaultPii: true,
  release: "pawtograder-mvp",
  integrations: [],
  tracesSampleRate: 0
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
