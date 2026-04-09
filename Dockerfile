# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
COPY . .

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

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID=$NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID
ENV NEXT_PUBLIC_PAWTOGRADER_WEB_URL=$NEXT_PUBLIC_PAWTOGRADER_WEB_URL
ENV NEXT_PUBLIC_BUGSINK_DSN=$NEXT_PUBLIC_BUGSINK_DSN
ENV NEXT_PUBLIC_BUGSINK_HOST=$NEXT_PUBLIC_BUGSINK_HOST
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_UI_HOST=$NEXT_PUBLIC_POSTHOG_UI_HOST
ENV NEXT_PUBLIC_ENABLE_SIGNUPS=$NEXT_PUBLIC_ENABLE_SIGNUPS
ENV NEXT_PUBLIC_GIT_COMMIT_SHA=$NEXT_PUBLIC_GIT_COMMIT_SHA
ENV SENTRY_RELEASE=$SENTRY_RELEASE
ENV SUPABASE_URL=$SUPABASE_URL

RUN --mount=type=secret,id=supabase_service_role_key \
    SUPABASE_SERVICE_ROLE_KEY="$(cat /run/secrets/supabase_service_role_key)" npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/sentry.server.config.ts ./sentry.server.config.ts
COPY --from=builder /app/sentry.edge.config.ts ./sentry.edge.config.ts
COPY --from=builder /app/instrumentation.ts ./instrumentation.ts
COPY --from=builder /app/instrumentation-client.ts ./instrumentation-client.ts

CMD ["npm", "run", "start"]
