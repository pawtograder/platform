#!/usr/bin/env bash
# Configure OpenBao so preview CI can mint SHORT-LIVED Kubernetes credentials
# from a GitHub Actions OIDC token, instead of holding a static kubeconfig.
#
# Idempotent: re-running updates in place. Run with a BAO_TOKEN that can write
# sys/auth, sys/mounts, and the two mount paths.
#
#   BAO_ADDR=https://bao.work.ripley.cloud BAO_TOKEN=... \
#     ./scripts/setup-openbao-preview-oidc.sh
#
# Companion runbook, including the cluster-side RBAC that OpenBao's own
# ServiceAccount needs and the admission policy that bounds namespace names:
#   docs/operations/preview-oidc-cluster-credentials.md
set -euo pipefail

REPO="${REPO:-pawtograder/platform}"
BASE_REF="${BASE_REF:-refs/heads/staging}"
WORKFLOW="${WORKFLOW:-.github/workflows/preview.yml}"
CI_NS="${CI_NS:-pawtograder-preview-ci}"
PREVIEW_LABEL_KEY="${PREVIEW_LABEL_KEY:-pawtograder.net/preview}"
TOKEN_MAX_TTL="${TOKEN_MAX_TTL:-60m}"

CLI=bao
command -v bao >/dev/null 2>&1 || CLI=vault
command -v "$CLI" >/dev/null 2>&1 || { echo "need the bao (or vault) CLI" >&2; exit 1; }
: "${BAO_ADDR:?set BAO_ADDR}"
: "${BAO_TOKEN:?set BAO_TOKEN}"
export BAO_ADDR BAO_TOKEN VAULT_ADDR="${BAO_ADDR}" VAULT_TOKEN="${BAO_TOKEN}"

# The audience the workflow requests and the role verifies. Deliberately the
# Bao address rather than the GitHub default (the repo URL), which every
# workflow in the repo would share.
AUDIENCE="${AUDIENCE:-$BAO_ADDR}"

echo "==> enable jwt auth"
$CLI auth enable jwt 2>/dev/null || echo "    (already enabled)"
$CLI write auth/jwt/config \
  oidc_discovery_url="https://token.actions.githubusercontent.com" \
  bound_issuer="https://token.actions.githubusercontent.com"

echo "==> enable kubernetes secrets engine"
$CLI secrets enable kubernetes 2>/dev/null || echo "    (already enabled)"
# No arguments: OpenBao uses its own in-cluster ServiceAccount and the
# pod's CA/host. Pass kubernetes_host / kubernetes_ca_cert only if Bao runs
# outside the target cluster.
$CLI write -f kubernetes/config

# ---------------------------------------------------------------------------
# JWT auth roles. One per job shape, each bound as tightly as its claims allow.
#
# job_workflow_ref pins BOTH the workflow file and the ref it is read from.
# Under pull_request_target the workflow always comes from the base branch, so
# a fork cannot introduce a workflow that satisfies this — the claim binding
# and the in-repo trust gate reinforce each other.
# ---------------------------------------------------------------------------
jwt_role() {
  local name="$1" policy="$2" extra="$3"
  # shellcheck disable=SC2086
  $CLI write "auth/jwt/role/${name}" \
    role_type="jwt" \
    user_claim="job_workflow_ref" \
    bound_audiences="${AUDIENCE}" \
    bound_claims_type="string" \
    bound_claims="repository=${REPO},job_workflow_ref=${REPO}/${WORKFLOW}@${BASE_REF}${extra}" \
    token_policies="${policy}" \
    token_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" token_num_uses=0
}

# The deploy-path roles additionally require environment=preview. GitHub only
# emits that claim when the job declares `environment:`, so this is what makes
# the environment declaration load-bearing rather than cosmetic.
echo "==> jwt roles"
jwt_role preview-provision preview-provision ",environment=preview"
jwt_role preview-read      preview-read      ",environment=preview"
jwt_role preview-deploy    preview-deploy    ",environment=preview"
# teardown has NO environment claim: the destroy job deliberately declares no
# environment, so that it can never be blocked by a future required-reviewer
# rule. Binding environment here would break teardown and leak namespaces.
jwt_role preview-teardown  preview-teardown  ""

echo "==> policies"
for r in provision read deploy teardown; do
  $CLI policy write "preview-${r}" - <<EOF
path "kubernetes/creds/preview-${r}" {
  capabilities = ["update"]
}
EOF
done

# ---------------------------------------------------------------------------
# Kubernetes secrets engine roles.
#
# allowed_kubernetes_namespaces does NOT accept a "pawtograder-preview-*" glob,
# and "*" would mean every namespace including prod. So per-PR namespaces are
# matched by LABEL: the secrets job labels each namespace on creation and these
# roles select on it.
# ---------------------------------------------------------------------------
echo "==> kubernetes roles"

# read: the narrowest. A namespaced Role granting `get` on Secrets, nothing
# else. Used by build-web (which builds untrusted PR code) and the Bao publish.
$CLI write kubernetes/roles/preview-read \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=Role \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]'

# deploy: helm needs broad verbs, but only INSIDE the preview namespace.
$CLI write kubernetes/roles/preview-deploy \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=Role \
  token_default_ttl="50m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='rules:
- apiGroups: ["", "apps", "batch", "networking.k8s.io", "policy", "autoscaling", "monitoring.coreos.com"]
  resources: ["*"]
  verbs: ["*"]'

# provision / teardown: these need CLUSTER-scoped verbs (create and delete
# Namespace), which RBAC cannot restrict by name prefix. The name bound is
# enforced by a ValidatingAdmissionPolicy instead — see the runbook. Their
# ServiceAccount is created in $CI_NS because it cannot live in a namespace it
# is about to create or has just deleted.
$CLI write kubernetes/roles/preview-provision \
  allowed_kubernetes_namespaces="${CI_NS}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "create", "patch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "create", "update", "patch"]'

$CLI write kubernetes/roles/preview-teardown \
  allowed_kubernetes_namespaces="${CI_NS}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "delete"]
- apiGroups: [""]
  resources: ["persistentvolumeclaims", "secrets", "configmaps", "pods", "services"]
  verbs: ["get", "list", "delete"]
- apiGroups: ["apps", "batch"]
  resources: ["*"]
  verbs: ["get", "list", "delete"]'

cat <<EOF

Done. Next:
  1. Apply the cluster-side RBAC for OpenBao's own ServiceAccount and the
     namespace-name admission policy:
       docs/operations/preview-oidc-cluster-credentials.md
  2. Verify a role end to end BEFORE switching CI over (that doc's §Verify).
  3. Flip the switch:
       gh variable set PREVIEW_CLUSTER_AUTH --body oidc --repo ${REPO}
  4. Once a preview is green on OIDC, delete the static credentials:
       gh secret delete KUBECONFIG_BASE64 --repo ${REPO}
       gh secret delete BAO_PUBLISHER_ROLE_ID --repo ${REPO}
       gh secret delete BAO_PUBLISHER_SECRET_ID --repo ${REPO}
EOF
