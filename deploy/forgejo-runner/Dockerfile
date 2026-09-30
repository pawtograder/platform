# Forgejo Actions runner for host-mode jobs.
#
# The namespace can't run Docker-in-Docker, so jobs run directly inside this
# container (runner label `<name>:host`). Everything a grading workflow needs
# has to be baked in here: a JDK and Python for assignments, Node for
# JavaScript actions such as pawtograder/assignment-action, and git.
#
# Build and push (nodes are x86_64):
#   docker buildx build --platform linux/amd64 \
#     -t <registry>/forgejo-runner:<runner-version>-jdk21 --push deploy/forgejo-runner
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

# The base image ships an `ubuntu` user at uid 1000; reuse it as the runner.
RUN usermod -l runner -d /data -m ubuntu && groupmod -n runner ubuntu \
 && mkdir -p /data && chown runner:runner /data
USER 1000:1000
WORKDIR /data
ENV HOME=/data

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["forgejo-runner", "daemon", "--config", "/etc/forgejo-runner/config.yaml"]
