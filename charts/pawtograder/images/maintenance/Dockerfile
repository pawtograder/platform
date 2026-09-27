# Pawtograder maintenance page image.
#
# A tiny static nginx server that returns HTTP 503 + Retry-After for every path
# while serving a styled "we'll be right back" body that matches the app's
# in-app error boundary. Used by the planned-maintenance runbook: the web-host
# ingress backend is repointed to this Service for the window, then back.
#
# Build context: repository root.
#   docker build -f charts/pawtograder/images/maintenance/Dockerfile -t <ref> .
#
# In the chart, templates/maintenance.yaml renders index.html through `tpl`
# (substituting maintenance.title/message/eta from values) and mounts that
# ConfigMap over the baked copies below.
FROM nginxinc/nginx-unprivileged:1.27-alpine

# Runs as uid 101 (nginx), listens on :8080 — no root, no extra config needed.
COPY charts/pawtograder/images/maintenance/nginx.conf /etc/nginx/conf.d/default.conf
COPY charts/pawtograder/maintenance/index.html /usr/share/nginx/html/index.html
# Bundled pixel-art background so the page renders fully offline. The chart's
# ConfigMap mounts index.html/default.conf over the copies above via subPath, so
# this PNG stays served from the image at /maintenance-mode.png.
COPY charts/pawtograder/maintenance/maintenance-mode.png /usr/share/nginx/html/maintenance-mode.png

ARG GIT_SHA=""
ARG VERSION=""
LABEL org.opencontainers.image.source="https://github.com/pawtograder/platform" \
      org.opencontainers.image.title="pawtograder-maintenance" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION"

EXPOSE 8080
