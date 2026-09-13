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
# WHY A REGISTRY PULL, NOT curl. The first version of this file fetched the
# GitHub release asset. That timed out (`curl: (28) SSL connection timeout`,
# after 313s) on the Khoury builder, which mirrors the Ubuntu archive but has
# unreliable egress to GitHub's release CDN — one build succeeded and the next
# failed. Copying from a registry uses the one network path that provably
# works there, since that is how every other image in this chart is built.
#
# quay.io still serves the archived project's images; docker.io/minio/mc and
# dl.min.io are both gone. The binary in this image is byte-identical to what
# was previously pinned, so MC_SHA256 is unchanged and still verified below —
# the registry is a transport, not a new trust anchor.
#
# The base image MUST stay pinned to the same tag as postgres.image /
# backup.image so pg_dump and pg_restore match the server they dump. Bump both
# together.
#
# Build context: repository root.
#   docker build -f charts/pawtograder/images/backup/Dockerfile -t <ref> .
# Digest-pinned, not just tag-pinned: a Quay tag is mutable, and MC_SHA256
# below would catch a retargeted tag by FAILING THE BUILD. Pinning the digest
# means upstream cannot break our build in the first place. Resolve a new one
# with: docker buildx imagetools inspect <ref> --format '{{.Manifest.Digest}}'
ARG MC_IMAGE="quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727"
FROM ${MC_IMAGE} AS mc

FROM supabase/postgres:17.4.1.075

# Unchanged from the dl.min.io pin: same release, same bytes. Verified below so
# a swapped upstream image cannot slip a different binary in.
ARG MC_SHA256="01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891"

COPY --from=mc /usr/bin/mc /usr/local/bin/mc

# ca-certificates is a RUNTIME dependency: mc needs a trust store to talk
# HTTPS to the S3 endpoint. It comes from the Ubuntu mirror, which is the
# reliable path on this builder. curl is no longer installed at all — nothing
# downloads anything any more.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
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
