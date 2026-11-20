# No Docker-in-Docker in the namespace, so jobs run in this container; build for linux/amd64.
ARG RUNNER_VERSION=13.2.0
ARG NODE_VERSION=22

FROM data.forgejo.org/forgejo/runner:${RUNNER_VERSION} AS runner
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM eclipse-temurin:21-jdk-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git git-lfs jq unzip zip xz-utils \
      python3 python3-pip python3-venv \
      maven \
      dumb-init \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

COPY --from=runner /bin/forgejo-runner /usr/local/bin/forgejo-runner

RUN usermod -l runner -d /data -m ubuntu && groupmod -n runner ubuntu \
 && mkdir -p /data && chown runner:runner /data
USER 1000:1000
WORKDIR /data
ENV HOME=/data

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["forgejo-runner", "daemon", "--config", "/etc/forgejo-runner/config.yaml"]
