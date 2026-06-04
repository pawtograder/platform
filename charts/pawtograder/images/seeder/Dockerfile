# Pawtograder seeder image.
#
# Builds a runtime that can execute scripts/SeedDB.ts (the realistic
# faker-backed class generator) against a running preview cluster.
# Kept SEPARATE from the migrations image — that one's a 50MB
# postgres:17-alpine + bash, this is Node 22 + the full TypeScript source
# tree + node_modules, ~600MB. Conflating the two would balloon the
# migrations image (which runs on every helm upgrade) for no benefit.
#
# Build context: repository root.
#   docker build -f charts/pawtograder/images/seeder/Dockerfile -t <ref> .
#
# Run with:
#   PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD            postgres direct
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                   admin client
#   TEST_PASSWORD                                             password for seeded users
#   FIXED_INSTRUCTOR_EMAIL, FIXED_GRADER_EMAIL, FIXED_STUDENT_EMAIL
#                                                            optional deterministic users
#   SEED_TEMPLATE  (default: small)                          micro|small|medium|...
#
# Entrypoint: /usr/local/bin/run-seed
#   - waits for postgres
#   - waits for the supabase services to finish their own migrations
#     (auth.identities, storage.buckets.public, supabase_realtime
#     publication, realtime.messages) — same guard as migrations image
#   - skips if the demo class already exists (idempotent across helm
#     upgrades)
#   - runs npx tsx scripts/SeedDB.ts --template <SEED_TEMPLATE>

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 10000 \
 && npm config set fetch-retry-maxtimeout 60000 \
 && success=0 \
 && for i in 1 2 3; do \
      if npm ci --ignore-scripts; then success=1; break; fi; \
      echo "npm ci attempt $i failed; sleeping 10s"; \
      sleep 10; \
    done \
 && test "$success" -eq 1

FROM node:22-bookworm-slim AS runner
WORKDIR /app

# psql for the wait-for-postgres / wait-for-supabase-services probes
# in run-seed.sh. The Node script itself talks to Kong (REST/Auth API),
# not psql, but the readiness checks are cheaper via psql than spinning
# up a tsx process.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy node_modules from deps stage (avoids re-downloading + reuses the
# Docker layer cache when only TS sources change between builds).
# --chown=node:node so the built-in node UID can read them when we drop
# privileges below.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Source files SeedDB.ts walks transitively. Copy enough of the tree to
# resolve all imports — scripts/, tests/, utils/, supabase/ (the Database
# type), components/, libs/, etc. The image is for seeding so we don't
# care about excluding test fixtures.
COPY --chown=node:node tsconfig.json package.json package-lock.json ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node utils ./utils
COPY --chown=node:node supabase ./supabase
COPY --chown=node:node tests ./tests

# Entrypoint wrapper. Stays root-owned (mode 0755) so node can execute
# it but not modify it.
COPY charts/pawtograder/images/seeder/run-seed.sh /usr/local/bin/run-seed
RUN chmod 0755 /usr/local/bin/run-seed

ARG GIT_SHA=""
ARG VERSION=""
LABEL org.opencontainers.image.source="https://github.com/pawtograder/platform" \
      org.opencontainers.image.title="pawtograder-seeder" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION"

# WORKDIR created /app as root. The seeder runs as `node` (below) and writes
# transient files into its CWD at runtime — tsx's on-disk cache and a few
# demo-fixture/manifest helpers in scripts/. With a root-owned /app those
# writes fail ("Permission denied") and abort the whole seed, so make the
# working directory writable by the runtime user. Non-recursive: the copied
# contents are already --chown=node:node.
RUN chown node:node /app

# Drop privileges. The node:bookworm-slim base image ships a non-root
# `node` user (uid/gid 1000). The image is a short-lived post-install
# Job but defense-in-depth still applies.
USER node

ENTRYPOINT ["/usr/local/bin/run-seed"]
