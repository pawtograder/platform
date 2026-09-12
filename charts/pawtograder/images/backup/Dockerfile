# Pawtograder backup image: supabase/postgres + a pinned `mc`.
#
# WHY THIS EXISTS. The backup and backup-verify CronJobs used to `apt-get
# install curl` and download `mc` from dl.min.io on EVERY run. On 2026-09-12
# that broke production: MinIO archived the open-source mc project and pulled
# every binary from dl.min.io, so the whole path started returning "410 Gone"
# — the pinned archive build and the rolling release URL alike. The nightly
# dump completed and then died installing its uploader, so nothing reached S3.
#
# Baking mc in moves that fetch from "every run, from a third party" to "once,
# at build time, into an image we control". It also removes a per-run MITM
# surface, and it means a backup no longer needs egress to anywhere but S3.
#
# The base image MUST stay pinned to the same tag as postgres.image /
# backup.image so pg_dump and pg_restore match the server they dump. Bump both
# together.
#
# Build context: repository root.
#   docker build -f charts/pawtograder/images/backup/Dockerfile -t <ref> .
FROM supabase/postgres:17.4.1.075

# Pinned by digest-equivalent checksum, not by trusting the host. Upstream is
# archived, so this URL is a frozen artifact: the GitHub release asset for the
# same RELEASE tag dl.min.io used to serve. The binary is byte-identical to
# what was previously pinned — verified against upstream's own .sha256sum.
# To move to a different build, change BOTH args together.
ARG MC_URL="https://github.com/minio/mc/releases/download/RELEASE.2025-08-13T08-35-41Z/mc.linux-amd64.RELEASE.2025-08-13T08-35-41Z"
ARG MC_SHA256="01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891"

# ca-certificates is a RUNTIME dependency, not just a build one: mc needs a
# trust store to talk HTTPS to the S3 endpoint. curl is left installed rather
# than purged — `apt-get purge --auto-remove curl` also takes libcurl, which
# the base image's own tooling links against.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSL "$MC_URL" -o /usr/local/bin/mc; \
    echo "$MC_SHA256  /usr/local/bin/mc" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/mc; \
    mc --version; \
    rm -rf /var/lib/apt/lists/*

ARG GIT_SHA=""
ARG VERSION=""
LABEL org.opencontainers.image.source="https://github.com/pawtograder/platform" \
      org.opencontainers.image.title="pawtograder-backup" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION"
