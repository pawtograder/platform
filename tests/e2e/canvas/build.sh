#!/usr/bin/env bash
# =============================================================================
# Build the Canvas LMS e2e image from source.
#
# What it does:
#   1. Shallow-clones instructure/canvas-lms at the PINNED ref into $CANVAS_SRC
#      (skipped if already present at the right commit).
#   2. Stages the e2e config files (tests/e2e/canvas/config/*) into the checkout
#      as ./e2e-config/ so the Dockerfile can COPY them.
#   3. Builds the image using tests/e2e/canvas/Dockerfile with the checkout as
#      the build context.
#
# This is a LONG build (~45+ min): Ruby gems + yarn install + asset compile.
# Run it in the background and tail $BUILD_LOG.
#
# Usage:  tests/e2e/canvas/build.sh
# Env overrides:
#   CANVAS_SRC   where to clone (default /home/researcher/canvas-build/canvas-lms)
#   IMAGE        image tag (default ghcr.io/pawtograder/canvas-lms-e2e:2026-05-20.143)
#   BUILD_LOG    build log path (default /home/researcher/canvas-build/build.log)
# =============================================================================
set -euo pipefail

# --- PINNED Canvas version --------------------------------------------------
CANVAS_TAG="release/2026-05-20.143"
CANVAS_COMMIT="2e2b4a46d08e32667d4845f7b78e1214250345d3"
CANVAS_REPO="https://github.com/instructure/canvas-lms.git"

# --- Paths / names ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANVAS_SRC="${CANVAS_SRC:-/home/researcher/canvas-build/canvas-lms}"
IMAGE="${IMAGE:-ghcr.io/pawtograder/canvas-lms-e2e:2026-05-20.143}"
IMAGE_LATEST="ghcr.io/pawtograder/canvas-lms-e2e:latest"
BUILD_LOG="${BUILD_LOG:-/home/researcher/canvas-build/build.log}"

echo "==> Canvas e2e image build"
echo "    tag      : $CANVAS_TAG ($CANVAS_COMMIT)"
echo "    src      : $CANVAS_SRC"
echo "    image    : $IMAGE"

# --- 1. Clone (idempotent) --------------------------------------------------
if [ -d "$CANVAS_SRC/.git" ] && \
   [ "$(git -C "$CANVAS_SRC" rev-parse HEAD 2>/dev/null)" = "$CANVAS_COMMIT" ]; then
  echo "==> Canvas source already at pinned commit, reusing."
else
  echo "==> Cloning Canvas $CANVAS_TAG ..."
  rm -rf "$CANVAS_SRC"
  git clone --depth 1 --branch "$CANVAS_TAG" "$CANVAS_REPO" "$CANVAS_SRC"
fi
GOT="$(git -C "$CANVAS_SRC" rev-parse HEAD)"
[ "$GOT" = "$CANVAS_COMMIT" ] || { echo "ERROR: checkout commit $GOT != pinned $CANVAS_COMMIT"; exit 1; }

# --- 2. Stage e2e config into the build context -----------------------------
echo "==> Staging e2e config files into build context"
rm -rf "$CANVAS_SRC/e2e-config"
mkdir -p "$CANVAS_SRC/e2e-config"
cp "$SCRIPT_DIR"/config/*.yml "$CANVAS_SRC/e2e-config/"

# --- 3. Build ---------------------------------------------------------------
echo "==> Building image (logging to $BUILD_LOG)"
DOCKER_BUILDKIT=1 docker build \
  -f "$SCRIPT_DIR/Dockerfile" \
  -t "$IMAGE" \
  -t "$IMAGE_LATEST" \
  "$CANVAS_SRC" 2>&1 | tee "$BUILD_LOG"

echo "==> Build complete: $IMAGE"
docker images "$IMAGE"
