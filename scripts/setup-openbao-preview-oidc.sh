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
# Every base ref a preview may legitimately run from. Pinning a single ref made
# previews and teardowns from anything but staging fail at auth/jwt/login;
# bound_claims accepts a list, and any one may match.
#
# This list is one half of a pair. preview.yml filters pull_request_target to
# the same branches, and — because GitHub has no branch filter for
# workflow_dispatch — its `meta` job refuses a dispatch from any other ref when
# PREVIEW_CLUSTER_AUTH=oidc. Widening this list without widening those, or the
# reverse, is what produces a run that gets all the way to auth/jwt/login and
# is rejected on a claim mismatch that names no ref.
BASE_REFS="${BASE_REFS:-refs/heads/staging refs/heads/main}"
WORKFLOW="${WORKFLOW:-.github/workflows/preview.yml}"
CI_NS="${CI_NS:-pawtograder-preview-ci}"
PREVIEW_LABEL_KEY="${PREVIEW_LABEL_KEY:-pawtograder.net/preview}"
TOKEN_MAX_TTL="${TOKEN_MAX_TTL:-60m}"

CLI=bao
command -v bao >/dev/null 2>&1 || CLI=vault
command -v "$CLI" >/dev/null 2>&1 || { echo "need the bao (or vault) CLI" >&2; exit 1; }
# Used to inspect an existing mount's config before deciding whether it is
# safe to overwrite. Checked up front so a missing jq is not discovered
# halfway through, with some mounts already written.
command -v jq >/dev/null 2>&1 || { echo "need jq (used to inspect existing mount config)" >&2; exit 1; }
: "${BAO_ADDR:?set BAO_ADDR}"
: "${BAO_TOKEN:?set BAO_TOKEN}"
export BAO_ADDR BAO_TOKEN VAULT_ADDR="${BAO_ADDR}" VAULT_TOKEN="${BAO_TOKEN}"

# The audience the workflow requests and the role verifies. Deliberately the
# Bao address rather than the GitHub default (the repo URL), which every
# workflow in the repo would share.
AUDIENCE="${AUDIENCE:-$BAO_ADDR}"

# `|| echo "(already enabled)"` swallowed EVERY failure, not just the
# already-enabled one — a permission denial, an unreachable server, or "path is
# already in use" by a DIFFERENT consumer all printed the same reassuring line,
# and the `write ... /config` immediately after then repointed that mount at
# our issuer. This OpenBao is shared (the KV layout is kv/apps/pawtograder/...,
# one app among several), so `jwt/` and `kubernetes/` are not presumptively
# ours. Distinguish the benign case from the rest.
# Returns 0 when it CREATED the mount, 1 when one was already there. Any
# other failure exits. The caller must handle the 1 — detecting that a mount
# already belongs to someone and then configuring it anyway is the bug this
# function was added to prevent.
enable_mount() { # $1 = auth|secrets, $2 = type
  local kind="$1" type="$2" out
  if out=$($CLI "$kind" enable "$type" 2>&1); then
    echo "    enabled ${type} at ${type}/"
    return 0
  fi
  if printf '%s' "$out" | grep -qiE 'path is already in use|already in use'; then
    return 1
  fi
  echo "ERROR: could not enable ${kind} mount '${type}': ${out}" >&2
  exit 1
}

GH_ISSUER="https://token.actions.githubusercontent.com"

echo "==> enable jwt auth"
# The pre-existing case is NOT automatically ours. This OpenBao is shared (the
# KV layout is kv/apps/pawtograder/..., one app among several), so writing
# `auth/jwt/config` unconditionally would repoint another consumer's JWT mount
# at our issuer and invalidate every role on it. Configure the mount only when
# we created it, or when it already points where we would point it anyway.
configure_jwt() {
  $CLI write auth/jwt/config \
    oidc_discovery_url="$GH_ISSUER" \
    bound_issuer="$GH_ISSUER"
}

# Read a mount's config, distinguishing three outcomes that must not be
# conflated: configured / genuinely absent / COULD NOT READ. The last one is
# reachable with a legitimate setup token — update without read is a normal
# policy — and the previous `2>/dev/null || true` turned it into "absent",
# which then rewrote a mount this script had just detected was not ours.
# Fail closed: an unreadable mount aborts.
read_mount_config() { # $1 = path, prints JSON on stdout
  local path="$1" out
  if out=$($CLI read -format=json "$path" 2>&1); then
    printf '%s' "$out"
    return 0
  fi
  if printf '%s' "$out" | grep -qiE 'no value found|No value found at'; then
    printf '{"data":{}}'
    return 0
  fi
  echo "ERROR: could not read ${path}: ${out}" >&2
  echo "       Refusing to guess whether this mount is configured. Grant the" >&2
  echo "       setup token read on ${path}, or give this setup its own mount." >&2
  exit 1
}

if enable_mount auth jwt; then
  configure_jwt
else
  jwt_cfg=$(read_mount_config auth/jwt/config)
  # bound_issuer is OPTIONAL in OpenBao's JWT auth config, so its absence is
  # not evidence the mount is free: another consumer may have configured
  # only oidc_discovery_url, jwks_url or jwt_validation_pubkeys. Treat ANY
  # issuer or key source as "this belongs to someone".
  existing_issuer=$(printf '%s' "$jwt_cfg" | jq -r '.data.bound_issuer // empty')
  existing_sources=$(printf '%s' "$jwt_cfg" | jq -r '
    [ .data.oidc_discovery_url,
      .data.jwks_url,
      ((.data.jwt_validation_pubkeys // []) | join(",")) ]
    | map(select(. != null and . != "")) | join(" ")')
  if [ -z "$existing_issuer" ] && [ -z "$existing_sources" ]; then
    echo "    (jwt/ exists but is unconfigured — configuring it for GitHub Actions)"
    configure_jwt
  elif [ "$existing_issuer" = "$GH_ISSUER" ] || [ "$existing_sources" = "$GH_ISSUER" ]; then
    echo "    (jwt/ already points at GitHub Actions — leaving its config alone)"
  else
    cat >&2 <<ERR
ERROR: auth/jwt/ on this OpenBao is already configured by another consumer:
         bound_issuer: ${existing_issuer:-(none)}
         key sources:  ${existing_sources:-(none)}
       Writing our config there would repoint that mount and invalidate every
       role on it. Give this setup its own mount instead:
         ${CLI} auth enable -path=jwt-preview jwt
       and change 'auth/jwt/login' in
       .github/actions/cluster-credentials/action.yml to 'auth/jwt-preview/login'
       (the mount path is hard-coded there; both must move together).
ERR
    exit 1
  fi
fi

echo "==> enable kubernetes secrets engine"
# Same shape, and the stakes are the same: `write -f kubernetes/config` takes
# no arguments, so on an existing mount it RESETS kubernetes_host,
# kubernetes_ca_cert and service_account_jwt to the in-cluster defaults —
# blanking another app's engine target.
#
# No arguments: OpenBao uses its own in-cluster ServiceAccount and the
# pod's CA/host. Pass kubernetes_host / kubernetes_ca_cert only if Bao runs
# outside the target cluster.
if enable_mount secrets kubernetes; then
  $CLI write -f kubernetes/config
else
  # Same three-way distinction as the jwt mount: `$CLI read ... 2>&1` with the
  # result discarded treated a DENIED read as "unconfigured" and then ran
  # `write -f`, which takes no arguments and so resets kubernetes_host,
  # kubernetes_ca_cert and service_account_jwt to the in-cluster defaults —
  # blanking another app's engine target.
  k8s_cfg=$(read_mount_config kubernetes/config)
  k8s_host=$(printf '%s' "$k8s_cfg" | jq -r '.data.kubernetes_host // empty')
  if [ -z "$k8s_host" ]; then
    echo "    (kubernetes/ exists but is unconfigured — configuring it)"
    $CLI write -f kubernetes/config
  else
    echo "    (kubernetes/ already configured for ${k8s_host} — leaving its config alone)"
    echo "    NOTE: if that mount belongs to another app, give this setup its own"
    echo "          (${CLI} secrets enable -path=kubernetes-preview kubernetes) and"
    echo "          update the 'kubernetes/creds/' paths in action.yml and the"
    echo "          policies below to match."
  fi
fi

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
  # token_ttl must be >= the longest `ttl:` any job asks the credential action
  # for (deploy requests 50m), NOT the 20m it used to be. A dynamic-secret
  # lease is a child of the token that created it: when this token expires its
  # lease is revoked with it, OpenBao deletes the generated ServiceAccount, and
  # the 50m Kubernetes token stops working the moment the 20m Bao token does.
  # The action logs in once per job and never renews, so this is a hard
  # ceiling. The symptom is a mid-apply `Unauthorized` from helm ~20 minutes
  # in, which looks like a cluster problem rather than a TTL one.
  $CLI write "auth/jwt/role/${name}" \
    role_type="jwt" \
    user_claim="job_workflow_ref" \
    bound_audiences="${AUDIENCE}" \
    bound_claims_type="string" \
    bound_claims="${claims}" \
    token_policies="${policy}" \
    token_ttl="${TOKEN_MAX_TTL}" token_max_ttl="${TOKEN_MAX_TTL}" token_num_uses=0
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
for r in read publish deploy; do
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
# teardown is split the same way and for the same reason: deleting a Namespace
# is cluster-scoped, but emptying one first (helm release Secrets, PVCs,
# workloads) is not. A single ClusterRole carrying both would grant the
# namespaced half in EVERY namespace — see preview-teardown-ns below.
$CLI policy write preview-teardown - <<EOF
path "kubernetes/creds/preview-teardown" {
  capabilities = ["update"]
}
path "kubernetes/creds/preview-teardown-ns" {
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
#
# BIND BY NAME, NOT generated_role_rules. Every role below names a ClusterRole
# that an operator applied from the runbook; the engine only creates a
# ServiceAccount and a binding to it. The alternative — having the engine
# author the rules — is what forced OpenBao's own ServiceAccount to hold
# `escalate` plus create/update on roles AND clusterroles cluster-wide, since
# Kubernetes refuses to let a principal create rules exceeding its own. That
# grant let anyone holding Bao's token mint arbitrary cluster permissions,
# production included, and no admission policy here constrained it.
#
# The trade is that role RULES are now cluster state rather than script
# arguments: change a role and you must apply the runbook's ClusterRole block
# before re-running this script. That is the better failure mode — the rules
# are reviewable in git and a drifted one fails loudly at mint time instead of
# silently widening what CI can do.
#
# Names are prefixed `pawtograder-preview-` because they are cluster-scoped
# objects sharing a namespace with everything else on the cluster; the Bao
# role names below stay unprefixed.
# ---------------------------------------------------------------------------
echo "==> kubernetes roles"

# read: the narrowest. A namespaced Role granting `get` on Secrets, nothing
# else. Used by build-web, which builds untrusted PR code.
$CLI write kubernetes/roles/preview-read \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  kubernetes_role_name="pawtograder-preview-read"

# publish: identical grant to preview-read, but a separate role so the
# publish-e2e-bundle job can keep its own `environment: preview-publish`
# claim. Sharing preview-read would not work: each jwt role binds exactly one
# environment value, so a job declaring preview-publish is rejected at
# auth/jwt/login by the role bound to preview-build.
$CLI write kubernetes/roles/preview-publish \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  kubernetes_role_name="pawtograder-preview-publish"

# deploy: helm needs broad verbs, but only INSIDE the preview namespace.
#
# rbac.authorization.k8s.io is in the list because the chart renders a Role and
# a RoleBinding (templates/secrets-bootstrap-rbac.yaml). Latent today — the
# preview passes `--set secrets.autogenerate=false`, which is the `if` guarding
# that template, so nothing in that group is rendered — but the group belongs
# here rather than being rediscovered as a 403 the first time someone enables
# the bootstrap Job for a preview. If that day comes, note that the minted SA
# would need `bind` to attach a Role it does not itself hold — escalation
# prevention again — and that the rules live in the runbook's
# pawtograder-preview-deploy ClusterRole now, not in this file.
$CLI write kubernetes/roles/preview-deploy \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="50m" token_max_ttl="${TOKEN_MAX_TTL}" \
  kubernetes_role_name="pawtograder-preview-deploy"

# provision / teardown: these need CLUSTER-scoped verbs (create and delete
# Namespace), which RBAC cannot restrict by name prefix. The name bound is
# enforced by a ValidatingAdmissionPolicy instead — see the runbook. Their
# ServiceAccount is created in $CI_NS because it cannot live in a namespace it
# is about to create or has just deleted.
$CLI write kubernetes/roles/preview-provision \
  allowed_kubernetes_namespaces="${CI_NS}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  kubernetes_role_name="pawtograder-preview-provision"

# Namespaced counterpart to preview-provision: writes the chart's Secrets into
# one labeled preview namespace and can reach no other.
$CLI write kubernetes/roles/preview-provision-secrets \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  kubernetes_role_name="pawtograder-preview-provision-secrets"

# Cluster-scoped half: Namespace get/delete and NOTHING else. The namespaced
# rules that used to live here (Secrets, PVCs, ConfigMaps, Pods, Services,
# apps/batch) applied in every namespace, production included, because a
# generated ClusterRole is bound with a ClusterRoleBinding — the same mistake
# preview-provision was split to avoid. The token `destroy` mints runs on every
# PR close and that job is deliberately not trust-gated, so it was the widest
# credential in the system. Namespace NAMES are bounded by the admission policy
# in the runbook, which matches CREATE, UPDATE and DELETE — UPDATE because
# preview-provision holds `patch` on namespaces cluster-wide, so labelling an
# arbitrary namespace `pawtograder.net/preview=true` would otherwise make it
# selectable by every label-scoped role here.
$CLI write kubernetes/roles/preview-teardown \
  allowed_kubernetes_namespaces="${CI_NS}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  kubernetes_role_name="pawtograder-preview-teardown"

# Namespaced half: empty one labeled preview namespace before it is deleted.
# PVCs must go explicitly because helm does not remove them.
#
# Two things here are easy to get wrong and both fail only at teardown time:
#
#   * The apiGroups mirror preview-deploy's, because helm uninstall deletes
#     everything the chart rendered — Ingresses, HPAs, ServiceMonitors and
#     ExternalSecrets included, not just core and apps/batch. With a shorter
#     list `helm uninstall` reports errors for each kind it may not touch.
#   * `update` on Secrets, because helm's first act in uninstall is to write
#     the release Secret back with status "uninstalling"
#     (pkg/action/uninstall.go:118 in v3.14.4, the version this workflow pins,
#     via the secrets driver's Update at pkg/storage/driver/secrets.go:188).
#     get/list/delete alone makes helm 403 before it deletes anything.
#
# Both are survivable today only because the job runs `helm uninstall || true`
# and then deletes the namespace, which garbage-collects whatever helm left —
# so the failure is silent and the release looks cleanly uninstalled.
$CLI write kubernetes/roles/preview-teardown-ns \
  allowed_kubernetes_namespace_selector="{\"matchLabels\":{\"${PREVIEW_LABEL_KEY}\":\"true\"}}" \
  kubernetes_role_type=ClusterRole \
  token_default_ttl="20m" token_max_ttl="${TOKEN_MAX_TTL}" \
  kubernetes_role_name="pawtograder-preview-teardown-ns"

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
