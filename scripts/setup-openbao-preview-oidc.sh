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
# Every base ref a preview may legitimately run from. preview.yml has no
# base-branch filter and workflow_dispatch can select any branch, so pinning a
# single ref made previews and teardowns from anything but staging fail at
# auth/jwt/login. bound_claims accepts a list; any one may match.
BASE_REFS="${BASE_REFS:-refs/heads/staging refs/heads/main}"
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
  local name="$1" policy="$2" env_claim="$3" refs_json="" r
  for r in $BASE_REFS; do
    refs_json="${refs_json:+${refs_json},}\"${REPO}/${WORKFLOW}@${r}\""
  done
  # bound_claims as JSON so job_workflow_ref can be a LIST and the environment
  # claim can be omitted entirely for the teardown role.
  local claims="{\"repository\":\"${REPO}\",\"job_workflow_ref\":[${refs_json}]"
  [ -n "$env_claim" ] && claims="${claims},\"environment\":\"${env_claim}\""
  claims="${claims}}"
  $CLI write "auth/jwt/role/${name}" \
    role_type="jwt" \
    user_claim="job_workflow_ref" \
    bound_audiences="${AUDIENCE}" \
    bound_claims_type="string" \
    bound_claims="${claims}" \
    token_policies="${policy}" \
    token_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" token_num_uses=0
}

# Each tier binds a DIFFERENT environment claim, and that is what actually
# enforces the privilege split. The role name is chosen by the caller at
# login, so if every role bound the same claims, build-web — which runs
# untrusted PR code — could simply log in as preview-deploy. GitHub emits the
# environment claim per job, so distinct environments make the separation real.
echo "==> jwt roles"
jwt_role preview-provision preview-provision preview-provision
jwt_role preview-read      preview-read      preview-build
jwt_role preview-publish   preview-publish   preview-publish
jwt_role preview-deploy    preview-deploy    preview-deploy
jwt_role preview-teardown  preview-teardown  preview-teardown

echo "==> policies"
for r in read publish deploy teardown; do
  $CLI policy write "preview-${r}" - <<EOF
path "kubernetes/creds/preview-${r}" {
  capabilities = ["update"]
}
EOF
done
# provision mints two credentials: a cluster-scoped one that may only create
# Namespaces, and a namespaced one that may write Secrets into the namespace it
# just created. Split because a ClusterRole carrying the Secret rule would
# grant Secret access in EVERY namespace, production included — the admission
# policy below only bounds Namespace names, not Secret reach.
$CLI policy write preview-provision - <<EOF
path "kubernetes/creds/preview-provision" {
  capabilities = ["update"]
}
path "kubernetes/creds/preview-provision-secrets" {
  capabilities = ["update"]
}
EOF

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
# else. Used by build-web, which builds untrusted PR code.
$CLI write kubernetes/roles/preview-read \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=Role \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='{"rules":[{"apiGroups":[""],"resources":["secrets"],"verbs":["get"]}]}'

# publish: identical grant to preview-read, but a separate role so the
# publish-e2e-bundle job can keep its own `environment: preview-publish`
# claim. Sharing preview-read would not work: each jwt role binds exactly one
# environment value, so a job declaring preview-publish is rejected at
# auth/jwt/login by the role bound to preview-build.
$CLI write kubernetes/roles/preview-publish \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=Role \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='{"rules":[{"apiGroups":[""],"resources":["secrets"],"verbs":["get"]}]}'

# deploy: helm needs broad verbs, but only INSIDE the preview namespace.
$CLI write kubernetes/roles/preview-deploy \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=Role \
  token_default_ttl="50m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='{"rules":[{"apiGroups":["","apps","batch","networking.k8s.io","policy","autoscaling","monitoring.coreos.com","external-secrets.io"],"resources":["*"],"verbs":["*"]}]}'

# provision / teardown: these need CLUSTER-scoped verbs (create and delete
# Namespace), which RBAC cannot restrict by name prefix. The name bound is
# enforced by a ValidatingAdmissionPolicy instead — see the runbook. Their
# ServiceAccount is created in $CI_NS because it cannot live in a namespace it
# is about to create or has just deleted.
$CLI write kubernetes/roles/preview-provision \
  allowed_kubernetes_namespaces="${CI_NS}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='{"rules":[{"apiGroups":[""],"resources":["namespaces"],"verbs":["get","create","patch"]}]}'

# Namespaced counterpart to preview-provision: writes the chart's Secrets into
# one labeled preview namespace and can reach no other.
$CLI write kubernetes/roles/preview-provision-secrets \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=Role \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='{"rules":[{"apiGroups":[""],"resources":["secrets"],"verbs":["get","create","update","patch"]}]}'

$CLI write kubernetes/roles/preview-teardown \
  allowed_kubernetes_namespaces="${CI_NS}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  generated_role_rules='{"rules":[{"apiGroups":[""],"resources":["namespaces"],"verbs":["get","delete"]},{"apiGroups":[""],"resources":["persistentvolumeclaims","secrets","configmaps","pods","services"],"verbs":["get","list","delete"]},{"apiGroups":["apps","batch"],"resources":["*"],"verbs":["get","list","delete"]}]}'

cat <<EOF

Done. Next:
  1. Apply the cluster-side RBAC for OpenBao's own ServiceAccount and the
     namespace-name admission policy:
       docs/operations/preview-oidc-cluster-credentials.md
  2. Verify a role end to end BEFORE switching CI over (that doc's §Verify).
  3. Flip the switch:
       gh variable set PREVIEW_CLUSTER_AUTH --body oidc --repo ${REPO}
  4. Do NOT delete KUBECONFIG_BASE64 or BAO_PUBLISHER_ROLE_ID /
     BAO_PUBLISHER_SECRET_ID. Only preview.yml's CLUSTER credential moved to
     OIDC: release-images.yml's deploy-staging still requires the kubeconfig,
     KUBECONFIG_BASE64 is the rollback path, and both KV operations still log
     in with the AppRole. See the runbook's "What this retires".
EOF
