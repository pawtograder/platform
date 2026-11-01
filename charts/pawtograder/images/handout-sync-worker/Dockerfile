# Handout sync worker image: plain Deno plus a pinned git, for the
# handout-sync-worker Deployment (docs/handout-sync-git-worker.md §3.1, §8.5).
#
# Build context: repository root.
#   docker build -f charts/pawtograder/images/handout-sync-worker/Dockerfile -t <ref> .
#
# This is NOT the edge-functions image. The worker is a long-running `deno run`
# process that spawns git, and edge-runtime can do neither: its isolates have no
# subprocess API and are killed at the 256 MiB cap that motivated the move.
#
# WHY ALPINE. The spec needs git >= 2.45 (`merge-file --object-id` needs 2.43;
# the hardening in §8.1 assumes `attr.tree`, 2.42). The options were:
#
#   Debian bookworm + backports  git 2.45 from backports, but Debian's `git`
#                                package hard-depends on perl and liberror-perl,
#                                so the image carries a full Perl interpreter
#                                that no code path here ever runs.
#   distroless + copied git      smallest on paper, but git-remote-https pulls in
#                                libcurl and its whole dependency tree by hand.
#                                With no package database, image scanners cannot
#                                see those libraries or report their CVEs, which
#                                defeats the "rebuild on every git security
#                                release" rule in §8.1.
#   git from pinned source       same scanner problem, plus a compiler toolchain
#                                in the build and a release process we own.
#   Alpine (chosen)              git's runtime deps are libcurl, expat, pcre2 and
#                                zlib; Perl lives in the separate git-perl
#                                subpackage and is not installed. apk's database
#                                stays in the image, so scanners see every
#                                package version.
#
# The base is Deno's own Alpine image, pinned by digest. It ships /tini, which
# runs as PID 1 below: the worker kills git on a deadline, git's own children
# (git-remote-https, pack-objects) can outlive it as orphans, and Deno as PID 1
# would never reap them. It also ships the glibc loader Deno needs on musl.
#
# Deno is pinned to the release `denoland/setup-deno` resolved `v2.x` to when
# this was written (.github/workflows/lint.yml runs the Deno tests on `v2.x`).
# CI floats and this image does not, so bump DENO_IMAGE when CI moves a minor.

ARG DENO_IMAGE=denoland/deno:alpine-2.9.8@sha256:75749604f68aea01d39bead15fd1c86343639e44eb8c58ab051da8a924799d01

# Two stages only so CI can read the resolved git version before the final
# build (see GIT_RESOLVED_VERSION below). `--target git` is everything up to and
# including the git install; the final stage continues from it unchanged.
FROM ${DENO_IMAGE} AS git

# A version FLOOR, not an exact package revision. Alpine keeps only the newest
# build of a package in a branch, so an exact pin (`git=2.54.0-r0`) stops
# resolving the day a security fix lands, and that would fail this image's
# build, and with it deploy-staging, for a reason unrelated to the change being
# shipped. With a floor, every build takes the newest git the pinned base's
# Alpine branch carries: a rebuild IS the git security update spec §8.1 asks
# for, and the base digest still bounds it to one Alpine branch. The cost is that
# two builds of one commit can carry different git patch releases, so the
# version actually installed is recorded in the image (/usr/share/pawtograder/
# git-version, and the org.pawtograder.git-version label when CI supplies it).
#
# 2.45 is what the engine's git invocations need (spec §3.1); `<3.0` keeps a
# future major, with its changed defaults, from arriving through a base bump
# unreviewed. The floor is also asserted against `git --version`, so a package
# that misreports its version cannot slip under it.
ARG GIT_MIN_VERSION=2.45.0

# Fixed, non-root, and not 1000 (the base image's `deno` user), so the UID in
# the chart's securityContext names this image's user and nothing else.
ARG WORKER_UID=10001

ENV DENO_DIR=/deno-dir \
    DENO_NO_UPDATE_CHECK=1 \
    DENO_NO_PROMPT=1 \
    HOME=/tmp

RUN set -eux; \
    apk add --no-cache "git>=${GIT_MIN_VERSION}" "git<3.0"; \
    have="$(git --version | awk '{print $3}')"; \
    lowest="$(printf '%s\n%s\n' "$GIT_MIN_VERSION" "$have" | sort -V | head -1)"; \
    if [ "$lowest" != "$GIT_MIN_VERSION" ]; then \
      echo "git $have is below the required $GIT_MIN_VERSION"; exit 1; \
    fi; \
    # git is the only thing the worker may run. Its helpers live in
    # /usr/libexec/git-core; everything git-shell or Perl/Tk-based is in other
    # subpackages that are not installed. Check that stays true.
    for p in perl git-perl git-gitk git-email git-daemon; do \
      if apk info -e "$p" >/dev/null; then echo "$p must not be installed"; exit 1; fi; \
    done; \
    echo "handout-sync:x:${WORKER_UID}:${WORKER_UID}:handout-sync:/tmp:/sbin/nologin" >> /etc/passwd; \
    echo "handout-sync:x:${WORKER_UID}:" >> /etc/group; \
    mkdir -p /usr/share/pawtograder; \
    apk list --installed git | awk '{print $1}' > /usr/share/pawtograder/git-version; \
    cat /usr/share/pawtograder/git-version

FROM git AS runtime

# The worker's entrypoint, relative to supabase/functions/. PLACEHOLDER until
# WP5 lands: handout-sync-worker/main.ts does not exist yet, and the build fails
# on purpose while it is missing (see the cache step below). release-images.yml
# skips this build until the file exists.
ARG WORKER_ENTRYPOINT=handout-sync-worker/main.ts

ENV WORKER_ENTRYPOINT=${WORKER_ENTRYPOINT}

# Only the module graph processEnvelope() reaches: the import map, _shared/, the
# async worker it lives in, and the new worker directory. Copying all of
# supabase/functions would put ~50 unrelated entrypoints in the image.
COPY supabase/functions/deno.json /app/functions/deno.json
COPY supabase/functions/_shared /app/functions/_shared
COPY supabase/functions/github-async-worker /app/functions/github-async-worker
# The `[r]` glob keeps COPY from failing while the directory is absent, so the
# explicit check below can say why instead.
COPY supabase/functions/handout-sync-worke[r] /app/functions/handout-sync-worker

# Vendor every remote module (jsr:, npm:, https://esm.sh) into DENO_DIR at build
# time and record a lockfile. At runtime `--cached-only --frozen` refuses any
# fetch and any graph that differs from this one, so the pod needs no egress to
# module registries and cannot pick up a moved `@2` tag between restarts.
#
# The repository has no deno.lock (the edge image even deletes one if present),
# so this lock pins what THIS build resolved, not what the repo intended. That
# is still the property that matters at runtime: every pod of one image runs
# the same graph.
RUN set -eux; \
    if [ ! -f "/app/functions/${WORKER_ENTRYPOINT}" ]; then \
      echo "supabase/functions/${WORKER_ENTRYPOINT} does not exist."; \
      echo "This image runs the handout-sync worker (WP5). Build it once that file is merged."; \
      exit 1; \
    fi; \
    deno cache --lock=/app/deno.lock "/app/functions/${WORKER_ENTRYPOINT}"; \
    chmod -R a+rX /app /deno-dir

# Strip the tools the worker never runs. busybox is the shell and every
# coreutil; apk is the package manager. git needs neither for anything the
# engine does: fetch, push and the plumbing commands exec their helpers
# directly, and the paths that do go through /bin/sh (hooks, aliases, pagers,
# shell-form credential helpers) are disabled by runGit() anyway (spec §8.1).
# Removing the shell turns any of those into an exec failure instead of a
# command, which is the direction we want.
#
# The apk database (/lib/apk/db) stays so scanners can still read package
# versions. Every command calls /bin/busybox by full path because the loop
# deletes the applet symlinks (rm, sh, ...) it would otherwise be running.
RUN ["/bin/busybox", "sh", "-c", "set -eu; b=/bin/busybox; $b rm -f /usr/local/bin/docker-entrypoint.sh /sbin/apk /usr/bin/ssl_client; for l in $($b --list-full); do if [ -L \"/$l\" ]; then $b rm -f \"/$l\"; fi; done; $b rm -f /bin/sh /bin/busybox"]

# Sanity checks that need no shell: git and deno both run as the worker user.
ARG WORKER_UID=10001
USER ${WORKER_UID}:${WORKER_UID}
RUN ["git", "--version"]
RUN ["deno", "--version"]

WORKDIR /work

# Light-touch labels so `docker inspect` can show provenance.
# GIT_RESOLVED_VERSION is the apk package (`git-2.54.0-r0`) that the `git` stage
# installed. A Dockerfile cannot copy a RUN's output into a LABEL, so
# release-images.yml builds `--target git` first, reads the file, and passes it
# in; this final build reuses that cached layer, so the label describes the git
# actually in the image. Declared down here so it never busts the install layer's
# cache. A local build without it gets "unrecorded"; the file is authoritative.
ARG GIT_SHA=""
ARG VERSION=""
ARG GIT_RESOLVED_VERSION="unrecorded"
LABEL org.opencontainers.image.source="https://github.com/pawtograder/platform" \
      org.opencontainers.image.title="pawtograder-handout-sync-worker" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION" \
      org.pawtograder.git-version="$GIT_RESOLVED_VERSION"

# Metrics and /healthz. The chart's handoutSyncWorker.metricsPort must match.
EXPOSE 9464

# Permissions, flag by flag (no -A):
#   --allow-net            Kong (PostgREST), Redis, api.github.com, github.com and
#                          the Sentry DSN host. Not narrowed by host here because
#                          the Kong and Redis hosts depend on the release and the
#                          Redis host lives in a Secret; the pod's egress policy
#                          is the enforcement point (spec §8.5). Also binds the
#                          metrics port.
#   --allow-env            processEnvelope's dependencies read their own variables
#                          (Sentry, octokit, supabase-js) and an allowlist here
#                          would turn a library upgrade into a startup crash. The
#                          chart is what limits WHICH variables exist: the pod gets
#                          only the keys the worker reads, not the edge Secret.
#   --allow-run=git        the only subprocess. runGit() spawns with clearEnv.
#   --allow-read/-write    /work (template cache and per-job bare repos) and /tmp.
#                          Module loading from /app and DENO_DIR needs no grant.
#   --allow-sys=hostname   Sentry tags events with the host name.
#   --cached-only --frozen no module fetch at runtime; see the cache step above.
#   --no-code-cache        the root filesystem is read-only, so V8's code cache
#                          under DENO_DIR cannot be written.
# WP5 may need to adjust these. Keep the list explicit when it does.
ENTRYPOINT ["/tini", "--", "deno", "run", \
  "--cached-only", "--frozen", "--lock=/app/deno.lock", "--no-code-cache", \
  "--allow-net", \
  "--allow-env", \
  "--allow-run=git", \
  "--allow-read=/work,/tmp", \
  "--allow-write=/work,/tmp", \
  "--allow-sys=hostname"]
CMD ["/app/functions/handout-sync-worker/main.ts"]
