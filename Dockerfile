FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Retry npm ci to absorb transient download flakes — particularly the
# `supabase` dev-dep's postinstall script, which fetches the supabase CLI
# tarball from github.com/releases and occasionally truncates mid-stream
# (Z_DATA_ERROR: incorrect header check). The retries here cover both
# npm's own fetcher (npm config) and the postinstall scripts (outer loop).
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 10000 \
 && npm config set fetch-retry-maxtimeout 60000 \
 && success=0 \
 && for i in 1 2 3; do \
      if npm ci; then success=1; break; fi; \
      echo "npm ci attempt $i failed; sleeping 10s"; \
      sleep 10; \
    done \
 && test "$success" -eq 1

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time args that Next.js inlines into the client bundle
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ARG NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID=""
ARG NEXT_PUBLIC_PAWTOGRADER_WEB_URL=""
ARG NEXT_PUBLIC_BUGSINK_DSN=""
ARG NEXT_PUBLIC_BUGSINK_HOST=""
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ARG NEXT_PUBLIC_POSTHOG_HOST=""
ARG NEXT_PUBLIC_POSTHOG_UI_HOST=""
ARG NEXT_PUBLIC_ENABLE_SIGNUPS=""
ARG NEXT_PUBLIC_GIT_COMMIT_SHA=""
# A/B deployment channels (see utils/channels.ts). PAWTOGRADER_CHANNEL identifies
# the build's channel ("" => stable). CHANNEL_HOST_SUFFIX enables per-course
# host-redirect routing in middleware and also derives the cross-channel auth
# cookie scope (".<suffix>"). Both empty by default => routing disabled.
ARG NEXT_PUBLIC_PAWTOGRADER_CHANNEL=""
ARG NEXT_PUBLIC_CHANNEL_HOST_SUFFIX=""
ARG SENTRY_RELEASE=""
# Source map upload target. Set SENTRY_URL to a self-hosted Bugsink base URL to
# upload there instead of sentry.io; leave empty to skip upload entirely. The
# auth token is NOT an ARG — it arrives as a BuildKit secret below.
ARG SENTRY_URL=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ARG SUPABASE_URL=""

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID=$NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID \
    NEXT_PUBLIC_PAWTOGRADER_WEB_URL=$NEXT_PUBLIC_PAWTOGRADER_WEB_URL \
    NEXT_PUBLIC_BUGSINK_DSN=$NEXT_PUBLIC_BUGSINK_DSN \
    NEXT_PUBLIC_BUGSINK_HOST=$NEXT_PUBLIC_BUGSINK_HOST \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_POSTHOG_UI_HOST=$NEXT_PUBLIC_POSTHOG_UI_HOST \
    NEXT_PUBLIC_ENABLE_SIGNUPS=$NEXT_PUBLIC_ENABLE_SIGNUPS \
    NEXT_PUBLIC_GIT_COMMIT_SHA=$NEXT_PUBLIC_GIT_COMMIT_SHA \
    NEXT_PUBLIC_PAWTOGRADER_CHANNEL=$NEXT_PUBLIC_PAWTOGRADER_CHANNEL \
    NEXT_PUBLIC_CHANNEL_HOST_SUFFIX=$NEXT_PUBLIC_CHANNEL_HOST_SUFFIX \
    SENTRY_RELEASE=$SENTRY_RELEASE \
    SENTRY_URL=$SENTRY_URL \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_PROJECT=$SENTRY_PROJECT \
    SUPABASE_URL=$SUPABASE_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=true

# Fail fast if critical build arg is missing
RUN test -n "$NEXT_PUBLIC_PAWTOGRADER_WEB_URL" \
    || (echo "ERROR: NEXT_PUBLIC_PAWTOGRADER_WEB_URL build arg is required" && exit 1)

# The Sentry auth token is a BuildKit secret, not an ARG, so it never lands in
# an image layer or `docker history`. The mount is optional: without a token the
# bundler plugin still emits and injects debug IDs, it just skips the upload.
# Empty ARGs are unset rather than exported as "" — the plugin only falls back to
# sentry.io when SENTRY_URL is nullish, and "" would be treated as a real URL.
RUN --mount=type=secret,id=sentry_auth_token \
    set -eu; \
    [ -n "${SENTRY_URL:-}" ] || unset SENTRY_URL; \
    [ -n "${SENTRY_ORG:-}" ] || unset SENTRY_ORG; \
    [ -n "${SENTRY_PROJECT:-}" ] || unset SENTRY_PROJECT; \
    if [ -s /run/secrets/sentry_auth_token ]; then \
      SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
      export SENTRY_AUTH_TOKEN; \
      echo "sentry: uploading source maps to ${SENTRY_URL:-sentry.io} (project ${SENTRY_PROJECT:-pawtograder-web})"; \
    else \
      echo "sentry: no auth token supplied, skipping source map upload"; \
    fi; \
    NODE_OPTIONS=--max-old-space-size=8000 npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1

# Non-root user for security
RUN groupadd --system --gid 1001 appgroup \
    && useradd --system --uid 1001 --gid appgroup appuser

# Copy standalone server + static assets + public files
COPY --from=builder --chown=appuser:appgroup /app/.next/standalone ./
COPY --from=builder --chown=appuser:appgroup /app/.next/static ./.next/static
COPY --from=builder --chown=appuser:appgroup /app/public ./public

USER appuser
EXPOSE 3000
CMD ["node", "server.js"]
