# Pawtograder migrations image.
#
# Build context: repository root.
#   docker build -f charts/pawtograder/images/migrations/Dockerfile -t <ref> .
#
# Run with PGHOST/PGUSER/PGDATABASE/PGPASSWORD set; entrypoint will apply
# every supabase/migrations/*.sql file in order, tracked in the standard
# supabase_migrations.schema_migrations table.
FROM postgres:17-alpine

RUN apk add --no-cache bash

COPY supabase/migrations /migrations
COPY charts/pawtograder/images/migrations/migrate.sh /usr/local/bin/migrate
RUN chmod +x /usr/local/bin/migrate

ARG GIT_SHA=""
ARG VERSION=""
LABEL org.opencontainers.image.source="https://github.com/pawtograder/platform" \
      org.opencontainers.image.title="pawtograder-migrations" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION"

ENTRYPOINT ["/usr/local/bin/migrate"]
