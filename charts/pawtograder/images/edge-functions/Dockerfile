# Edge-functions image for self-hosted Pawtograder.
#
# Build context: repository root.
#   docker build -f charts/pawtograder/images/edge-functions/Dockerfile -t <ref> .
FROM supabase/edge-runtime:v1.69.5

# Bake all 49 pawtograder edge functions into the image.
COPY supabase/functions /home/deno/functions

# Drop in the demux/main service that routes inbound requests by URL path.
COPY charts/pawtograder/images/edge-functions/main.ts /home/deno/functions/main/index.ts

# Light-touch labels so `docker inspect` can show provenance.
ARG GIT_SHA=""
ARG VERSION=""
LABEL org.opencontainers.image.source="https://github.com/pawtograder/platform" \
      org.opencontainers.image.title="pawtograder-edge-functions" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION"

EXPOSE 9000
