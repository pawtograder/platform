# The Coder workspace: images/forgejo-runner's base and toolchain, so tests that pass here pass in the grader. Change both together.
ARG NODE_VERSION=22
# coderBootstrap.workspaces.codeServerVersion; at another version the template downloads that one on first start.
ARG CODE_SERVER_VERSION=4.143.1

FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM eclipse-temurin:21-jdk-noble
ARG CODE_SERVER_VERSION
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git git-lfs jq unzip zip xz-utils \
      python3 python3-pip python3-venv \
      maven \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/lib \
 && mv "/usr/local/lib/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}" /usr/local/lib/code-server \
 && ln -s ../lib/code-server/bin/code-server /usr/local/bin/code-server \
 && code-server --version

# The template mounts the home volume at /home/coder and runs as 1000:1000.
RUN usermod -l coder -d /home/coder -m ubuntu && groupmod -n coder ubuntu
USER 1000:1000
WORKDIR /home/coder
ENV HOME=/home/coder
