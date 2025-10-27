import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_UI_HOST,
    defaults: "2025-05-24"
  });
} else {
  console.error("NEXT_PUBLIC_POSTHOG_KEY is not set, posthog will not be initialized");
}
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_BUGSINK_DSN,
  tunnel: "/api/tunnel",
  release:
    process.env.SENTRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA ??
    process.env.npm_package_version,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  integrations: [], // bugsink does not support any integrations
  tracesSampleRate: 0,
  sendClientReports: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  beforeSend(event) {
    if (event.exception && event.exception.values) {
      for (const exception of event.exception.values) {
        if (exception.type === "AbortError" && exception.value === "The operation was aborted.") {
          return null; // Discard the event
        }
        if (exception.type === "TypeError" && exception.value?.includes("Failed to fetch")) {
          return null; // Discard network errors
        }
      }
    }
    return event; // Send other events
  }
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
