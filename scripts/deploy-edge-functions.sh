#!/usr/bin/env bash
# Build the edge-functions image from THIS checkout and roll it out to a
# pawtograder environment (staging or a PR preview) — without a full
# release-images pipeline run. For fast iteration on supabase/functions/.
#
# It rebuilds charts/pawtograder/images/edge-functions/Dockerfile (the eszip
# bundle + demuxer main service), pushes a unique tag to ghcr, then patches every
# edge-functions Deployment via `kubectl set image` and waits for the rollouts.
# That is the request tier and, when edgeFunctions.workerTier is enabled, the
# background-worker tier: both run the same image, so patching one would leave the
# four pgmq workers on old code. Surgical in the sense that matters: it touches
# only the edge tiers — not web/migrations/db. The confirmation prompt lists every
# Deployment it will patch.
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

# --no-build deploys an existing tag; without --tag the default tag is freshly
# generated and won't exist in the registry, which would patch the Deployment to
# an unpullable image and take functions down. Require an explicit tag.
if [ "$do_build" -eq 0 ] && [ -z "$tag" ]; then
  echo "--no-build requires --tag <existing-image-tag>" >&2
  exit 2
fi

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

# Both edge tiers run the SAME image, so patching only the request tier would
# leave the four pgmq workers on the old code while the tool reported success --
# a half-updated fleet is worse than an un-updated one, because the symptom shows
# up as "my change did not take effect" for exactly the functions being debugged.
# The worker tier is optional (edgeFunctions.workerTier.enabled), so it is patched
# only when it actually exists.
#
# Resolved BEFORE the confirmation banner, deliberately: the banner is the safety
# mechanism for an interactive tool aimed at prod and previews, so it has to name
# every Deployment that is about to be patched, not just the first one.
#
# `--ignore-not-found -o name` rather than discarding the exit status. A bare
# `kubectl get ... >/dev/null 2>&1` conflates "the tier is disabled" with "I could
# not tell" -- an expired token, a wrong context, a `get`-scoped role or a
# transient API 5xx all took the else branch, printed a reassuring "worker tier
# disabled", patched one tier and reported success. That is the exact half-updated
# fleet this block exists to prevent, announced as a deliberate decision.
TARGETS="$DEPLOYMENT"
if worker_found="$(kubectl get "deploy/${DEPLOYMENT}-workers" -n "$NAMESPACE" \
    --ignore-not-found -o name 2>/dev/null)"; then
  if [ -n "$worker_found" ]; then
    TARGETS="$TARGETS ${DEPLOYMENT}-workers"
  else
    echo "==> no ${DEPLOYMENT}-workers Deployment in ${NAMESPACE} (worker tier disabled); patching the request tier only"
  fi
else
  echo "could not determine whether ${DEPLOYMENT}-workers exists in ${NAMESPACE} (kubectl get failed: RBAC, expired credentials, or an API error)." >&2
  echo "Refusing to guess: patching only the request tier here would silently leave the four pgmq workers on the old image." >&2
  exit 1
fi

cat <<EOF
Redeploy edge functions
  checkout    : ${REPO_ROOT} (HEAD ${SHA}${DIRTY})
  namespace   : ${NAMESPACE}
  deployments : ${TARGETS} (container ${CONTAINER})
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

# Patch every target first, THEN wait: the rollouts then progress concurrently in
# the cluster and the waits are max(), not sum().
for d in $TARGETS; do
  echo "==> kubectl set image ${d} ${CONTAINER}=${IMAGE_REF}"
  kubectl set image "deploy/${d}" "${CONTAINER}=${IMAGE_REF}" -n "$NAMESPACE"
done
# Every target is waited on even if an earlier one fails. Under `set -e` a failing
# `rollout status` used to abort here, so when the request tier timed out the
# worker tier was never waited on and never reported -- pgmq quietly stopped
# draining while the tool's last word was about the other tier. Both tiers are
# already patched by this point, so the operator needs the status of both.
rollout_failed=0
# Timeout is DERIVED per deployment, because a fixed one was wrong in both
# directions and the wrong direction that bit was "too short".
#
# It was --timeout=5m. The edge tier's terminationGracePeriodSeconds alone is
# 430s (7.2 min), so a single pod that used its full drain window outlasted the
# whole timeout -- and prod's own values log records a 24-replica request-tier
# deploy taking ~12 minutes. So the tool reported failure on rollouts that were
# healthy and still progressing, which is worse than waiting: both tiers have
# already been patched by this point, so a spurious failure invites someone to
# intervene in a deploy that was fine.
#
# The rollout is SERIAL, which is what makes it slow: the chart sets
# maxUnavailable: 0 with maxSurge: 1, so one new pod comes up Ready before one
# old pod is terminated, N times. Per replica the cost is a new pod reaching
# readiness (tcpSocket, initialDelay 5s + period 5s) plus an old pod draining
# (preStop 10s, then edge-runtime's --graceful-exit-timeout: ~0.3s when idle,
# up to 410s with a long request in flight, SIGKILL-backstopped at 430s).
#
# Budget 60s per replica against the ~30s/replica the 24-pod prod deploy actually
# measured -- 2x, so pods with real in-flight work to drain fit -- plus a fixed 5m
# for a cold image pull on a node that has never run this tag (the eszip image is
# large, and that cost is per node, not per replica). Floor of 10m so small
# deployments still tolerate one full drain window. Deliberately NOT sized to the
# theoretical worst case (24 x 430s = 172 min): a timeout should be longer than
# any healthy rollout, not longer than any conceivable one, or it stops being a
# signal at all.
for d in $TARGETS; do
  replicas="$(kubectl get "deploy/${d}" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "")"
  case "$replicas" in
    '' | *[!0-9]*) replicas=1 ;; # unreadable: fall back to the floor
  esac
  timeout=$((replicas * 60 + 300))
  [ "$timeout" -lt 600 ] && timeout=600
  echo "==> waiting for rollout: ${d} (${replicas} replicas, timeout ${timeout}s)"
  kubectl rollout status "deploy/${d}" -n "$NAMESPACE" --timeout="${timeout}s" || rollout_failed=1
done

echo
for d in $TARGETS; do
  echo "Done. ${d} in ${NAMESPACE} now runs ${IMAGE_REF}"
done
if [ "$rollout_failed" -ne 0 ]; then
  echo "One or more rollouts did not complete — see above. Both tiers were patched, so check every Deployment listed." >&2
  exit 1
fi
echo "Note: a later 'helm upgrade' / staging auto-deploy resets this to the chart's tag."
