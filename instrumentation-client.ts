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
    // Check for plain objects captured as exceptions (e.g., Supabase PostgrestError)
    // When Sentry.captureException() receives a plain object like {code, details, hint, message},
    // it creates a synthetic exception with the original data in event.extra.__serialized__
    const serialized = event.extra?.__serialized__ as { message?: string; details?: string; code?: string } | undefined;
    if (serialized) {
      const serializedMessage = serialized.message || "";
      const serializedDetails = serialized.details || "";
      const serializedCode = serialized.code || "";

      // Filter JWT expired errors (PGRST303) - these are expected when sessions expire
      if (serializedCode === "PGRST303" || serializedMessage.includes("JWT expired")) {
        return null;
      }

      // Check serialized message and details for network/abort errors
      if (serializedMessage.includes("Failed to fetch") || serializedDetails.includes("Failed to fetch")) {
        return null;
      }
      if (serializedMessage.includes("Load failed") || serializedDetails.includes("Load failed")) {
        return null; // Safari's variant of "Failed to fetch"
      }
      if (
        serializedMessage.includes("NetworkError when attempting to fetch") ||
        serializedDetails.includes("NetworkError when attempting to fetch")
      ) {
        return null;
      }
      if (
        serializedMessage.includes("The operation was aborted") ||
        serializedDetails.includes("The operation was aborted")
      ) {
        return null;
      }
      if (serializedMessage.includes("Fetch is aborted") || serializedDetails.includes("Fetch is aborted")) {
        return null;
      }
      if (serializedMessage.includes("Loading chunk") || serializedDetails.includes("Loading chunk")) {
        return null; // ChunkLoadError
      }
    }

    if (event.exception && event.exception.values) {
      for (const exception of event.exception.values) {
        if (exception.type === "AbortError" && exception.value === "The operation was aborted.") {
          return null; // Discard the event
        }
        if (exception.type === "AbortError" && exception.value?.includes("Fetch is aborted")) {
          return null; // Discard fetch abort errors
        }
        if (exception.type === "TypeError" && exception.value?.includes("Failed to fetch")) {
          return null; // Discard network errors
        }
        if (exception.type === "TypeError" && exception.value?.includes("Load failed")) {
          return null; // Discard network errors (Safari variant)
        }
        if (exception.type === "TypeError" && exception.value?.includes("NetworkError when attempting to fetch")) {
          return null; // Discard network errors
        }
        if (
          exception.type === "ChunkLoadError" &&
          exception.value?.includes("Loading chunk") &&
          exception.value?.includes("failed")
        ) {
          return null; // Discard chunk load errors
        }
        if ("message" in exception) {
          const message = exception.message as string;
          if (message.includes("Failed to fetch")) {
            return null; // Discard network errors
          }
          if (message.includes("Load failed")) {
            return null; // Discard network errors (Safari variant)
          }
          if (message.includes("NetworkError when attempting to fetch")) {
            return null; // Discard network errors
          }
          if (message.includes("Fetch is aborted")) {
            return null; // Discard fetch abort errors
          }
          if (message.includes("The operation was aborted")) {
            return null; // Discard abort errors
          }
        }
      }
    }
    return event; // Send other events
  }
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
