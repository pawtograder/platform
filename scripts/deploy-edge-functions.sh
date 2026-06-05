#!/usr/bin/env bash
# Build the edge-functions image from THIS checkout and roll it out to a
# pawtograder environment (staging or a PR preview) — without a full
# release-images pipeline run. For fast iteration on supabase/functions/.
#
# It rebuilds charts/pawtograder/images/edge-functions/Dockerfile (the eszip
# bundle + demuxer main service), pushes a unique tag to ghcr, then patches the
# `functions` Deployment via `kubectl set image` and waits for the rollout.
# Surgical: it touches ONLY the functions Deployment — not web/migrations/db.
#
# Usage:
#   scripts/deploy-edge-functions.sh                    # -> staging
#   scripts/deploy-edge-functions.sh --preview 815      # -> pawtograder-preview-pr-815
#   scripts/deploy-edge-functions.sh --namespace pawtograder-staging
#   scripts/deploy-edge-functions.sh --tag mytag --no-build   # deploy an existing tag
#   scripts/deploy-edge-functions.sh --repo /path/to/checkout # build a different checkout
#   scripts/deploy-edge-functions.sh -y                 # skip confirmation
#
# Caveat: this is a live patch of the Deployment, NOT a Helm release. The next
# `helm upgrade` (including staging auto-deploy on push) resets the image to the
# chart's edgeFunctions.image.tag. Use it to iterate; land real changes via the
# branch + release-images pipeline.
#
# Requires: docker (logged in to ghcr, or a gh token so it can log in), kubectl,
# git. Assumes KUBECONFIG points at the cluster.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cluster-env.sh
. "${SCRIPT_DIR}/lib/cluster-env.sh"

REGISTRY="ghcr.io"
IMAGE_REPO="ghcr.io/pawtograder/edge-functions"
DEPLOYMENT="pawtograder-functions"
CONTAINER="functions"

env="" preview="" namespace="" tag="" repo="" do_build=1 auto_yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env)          env="$2"; shift 2 ;;
    --preview)      preview="$2"; shift 2 ;;
    --namespace|-n) namespace="$2"; shift 2 ;;
    --tag)          tag="$2"; shift 2 ;;
    --repo|-C)      repo="$2"; shift 2 ;;
    --no-build)     do_build=0; shift ;;
    -y|--yes)       auto_yes=1; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

require docker; require kubectl; require git
NAMESPACE="$(resolve_namespace "$env" "$preview" "$namespace")"

# Repo root to build from (the "given checkout"): --repo, else this script's repo.
REPO_ROOT="${repo:-$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel)}"
DOCKERFILE="${REPO_ROOT}/charts/pawtograder/images/edge-functions/Dockerfile"
[ -f "$DOCKERFILE" ] || { echo "not a pawtograder checkout: ${REPO_ROOT}" >&2; exit 1; }

SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""; git -C "$REPO_ROOT" diff --quiet 2>/dev/null || DIRTY="-dirty"
# Default tag is unique per run. The Deployment's imagePullPolicy is
# IfNotPresent, so a brand-new tag is what actually forces nodes to pull the
# rebuilt image. Slug the namespace so preview tags stay readable.
SLUG="$(printf '%s' "$NAMESPACE" | sed 's/^pawtograder-//; s/[^a-zA-Z0-9]/-/g')"
STAMP="$(date -u +%Y%m%d%H%M%S)"
TAG="${tag:-${SLUG}-fns-${SHA}${DIRTY}-${STAMP}}"
IMAGE_REF="${IMAGE_REPO}:${TAG}"

assert_namespace "$NAMESPACE"
kubectl get deploy "$DEPLOYMENT" -n "$NAMESPACE" >/dev/null 2>&1 \
  || { echo "deployment ${DEPLOYMENT} not found in ${NAMESPACE} — is the env deployed?" >&2; exit 1; }

cat <<EOF
Redeploy edge functions
  checkout    : ${REPO_ROOT} (HEAD ${SHA}${DIRTY})
  namespace   : ${NAMESPACE}
  deployment  : ${DEPLOYMENT} (container ${CONTAINER})
  image       : ${IMAGE_REF}
  build       : $([ "$do_build" -eq 1 ] && echo yes || echo 'no (reuse existing tag)')
EOF
if [ "$auto_yes" -ne 1 ]; then
  read -r -p "Proceed? [y/N] " r
  case "$r" in [yY]|[yY][eE][sS]) ;; *) echo aborted; exit 1 ;; esac
fi

if [ "$do_build" -eq 1 ]; then
  # Make sure we can push to ghcr. Non-interactive: if a gh token is around,
  # use it; otherwise rely on an existing docker login and let push surface a
  # clear error if there isn't one.
  if command -v gh >/dev/null 2>&1; then
    gh auth token 2>/dev/null \
      | docker login "$REGISTRY" -u "$(gh api user --jq .login 2>/dev/null || echo x)" --password-stdin >/dev/null 2>&1 || true
  fi
  echo "==> docker build (eszip bundle) — this takes a few minutes…"
  docker build \
    -f "$DOCKERFILE" \
    -t "$IMAGE_REF" \
    --build-arg GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" \
    --build-arg VERSION="$TAG" \
    "$REPO_ROOT"
  echo "==> docker push ${IMAGE_REF}"
  docker push "$IMAGE_REF"
fi

echo "==> kubectl set image ${DEPLOYMENT} ${CONTAINER}=${IMAGE_REF}"
kubectl set image "deploy/${DEPLOYMENT}" "${CONTAINER}=${IMAGE_REF}" -n "$NAMESPACE"
echo "==> waiting for rollout…"
kubectl rollout status "deploy/${DEPLOYMENT}" -n "$NAMESPACE" --timeout=5m

echo
echo "Done. ${DEPLOYMENT} in ${NAMESPACE} now runs ${IMAGE_REF}"
echo "Note: a later 'helm upgrade' / staging auto-deploy resets this to the chart's tag."
