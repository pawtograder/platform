#!/usr/bin/env bash
# Wipe and redeploy the pawtograder-staging Helm release.
#
# Staging is treated as disposable: this uninstalls the release, drops the
# Postgres PVC, then reinstalls from charts/pawtograder with the canonical
# values-staging.yaml overlay. ExternalSecrets, basic-auth secret, and S3
# creds in the namespace are left in place (they're independent of the
# release lifecycle).
#
# Usage:
#   KUBECONFIG=/path/to/kubeconfig scripts/redeploy-staging.sh
#   scripts/redeploy-staging.sh --yes   # skip the confirmation prompt
#
# Requires: kubectl, helm. Assumes you're already logged into OpenBao
# and the ExternalSecrets in pawtograder-staging can resolve.
set -euo pipefail

NAMESPACE="${NAMESPACE:-pawtograder-staging}"
RELEASE="${RELEASE:-pawtograder}"
PVC="${PVC:-data-pawtograder-postgres-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${REPO_ROOT}/charts/pawtograder"
VALUES_FILE="${CHART_DIR}/examples/values-staging.yaml"

auto_yes=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) auto_yes=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "missing kubectl" >&2; exit 1; }
command -v helm    >/dev/null || { echo "missing helm"    >&2; exit 1; }
[ -f "$VALUES_FILE" ] || { echo "values file not found: $VALUES_FILE" >&2; exit 1; }

CONTEXT="$(kubectl config current-context 2>/dev/null || echo '<none>')"

cat <<EOF
About to redeploy pawtograder staging — DESTRUCTIVE.

  kubectl context : ${CONTEXT}
  namespace       : ${NAMESPACE}
  release         : ${RELEASE}
  values          : ${VALUES_FILE#${REPO_ROOT}/}

Steps:
  1. helm uninstall ${RELEASE} -n ${NAMESPACE}   (if present)
  2. kubectl delete pvc ${PVC} -n ${NAMESPACE}   (Postgres data wipe)
  3. wait for pods + PVC to drain
  4. helm upgrade --install ${RELEASE} -n ${NAMESPACE} -f values-staging.yaml
EOF

if [ "$auto_yes" -ne 1 ]; then
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi

if ! kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  echo "namespace ${NAMESPACE} does not exist; creating"
  kubectl create namespace "$NAMESPACE"
fi

echo
echo "==> helm uninstall ${RELEASE} -n ${NAMESPACE}"
if helm status "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
  helm uninstall "$RELEASE" -n "$NAMESPACE" --wait
else
  echo "  (no existing release)"
fi

echo
echo "==> deleting Postgres PVC ${PVC}"
if kubectl get pvc "$PVC" -n "$NAMESPACE" >/dev/null 2>&1; then
  kubectl delete pvc "$PVC" -n "$NAMESPACE" --wait=true
else
  echo "  (no PVC found — fresh namespace?)"
fi

echo
echo "==> waiting for any straggler pods to terminate"
# Pods left behind by Job/StatefulSet finalizers can block the next install.
# `--for=delete --all` blocks until none remain; cap at 2m.
kubectl wait --for=delete pod --all -n "$NAMESPACE" --timeout=120s 2>/dev/null || true

echo
echo "==> helm upgrade --install ${RELEASE}"
helm upgrade --install "$RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$VALUES_FILE" \
  --wait \
  --timeout 15m

echo
echo "==> release deployed. Recent state:"
kubectl get pods -n "$NAMESPACE"
echo
echo "Studio:  https://studio.staging.pawtograder.net"
echo "App:     https://staging.pawtograder.net"
echo "API:     https://api.staging.pawtograder.net"
echo
echo "Tail logs:"
echo "  kubectl -n ${NAMESPACE} logs -l app.kubernetes.io/instance=${RELEASE} --tail=200 -f"
