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
 && for i in 1 2 3; do npm ci && break || { echo "npm ci attempt $i failed; sleeping 10s"; sleep 10; }; done

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
ARG SENTRY_RELEASE=""
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
    SENTRY_RELEASE=$SENTRY_RELEASE \
    SUPABASE_URL=$SUPABASE_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=true

# Fail fast if critical build arg is missing
RUN test -n "$NEXT_PUBLIC_PAWTOGRADER_WEB_URL" \
    || (echo "ERROR: NEXT_PUBLIC_PAWTOGRADER_WEB_URL build arg is required" && exit 1)

RUN NODE_OPTIONS=--max-old-space-size=8000 npm run build

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
