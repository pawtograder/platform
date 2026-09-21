# OIDC-federated cluster credentials for preview CI

Replaces the static `KUBECONFIG_BASE64` secret with short-lived Kubernetes
ServiceAccount tokens, minted per job from a GitHub Actions OIDC token via
OpenBao. Nothing long-lived exists to leak or rotate, and authority comes from
claims OpenBao verifies rather than from a value in repo settings.

```
preview.yml job  (permissions: id-token: write, environment: preview)
  │  GitHub signs a claim set: repository, ref, environment, job_workflow_ref
  ▼
OpenBao  auth/jwt/login  (bound_audiences + bound_claims)
  │  short-lived Bao token carrying one policy
  ▼
OpenBao  kubernetes/creds/<role>
  │  TokenRequest -> ServiceAccount token, RBAC from generated_role_rules
  ▼
$HOME/.kube/config   — expires with the job
```

## Why not `kube-apiserver --oidc-issuer-url`

Pointing the API server at GitHub's issuer would also work, but it needs
control-plane flags and a restart, and before Kubernetes 1.30 only **one**
external OIDC issuer is supported — which on a Rancher-managed cluster is
likely already spoken for. OpenBao already runs in this cluster and the runners
already reach it, so brokering through it needs no control-plane change at all.

## What this retires

| Secret                                              | After cutover                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `KUBECONFIG_BASE64`                                 | delete                                                                                                                                        |
| `KUBECONFIG_PREVIEW_RO_BASE64`                      | never needed — scoping is a Bao role, not a second kubeconfig (supersedes [preview-readonly-kubeconfig.md](./preview-readonly-kubeconfig.md)) |
| `BAO_PUBLISHER_ROLE_ID` / `BAO_PUBLISHER_SECRET_ID` | delete — AppRole replaced by OIDC                                                                                                             |

### The OpenBao AppRole is not retired by this change

`publish-e2e-bundle` and `destroy` still authenticate to OpenBao with the
AppRole to write and delete the e2e bundle under `kv/`. The OIDC roles here
grant only `kubernetes/creds/*`; they cannot write KV. Deleting
`BAO_PUBLISHER_ROLE_ID` / `BAO_PUBLISHER_SECRET_ID` at cutover would make the
publish step skip silently (it treats missing config as a warning) and the
teardown removal quietly no-op, so the out-of-cluster VoiceOver runner would
stop getting bundles with nothing failing to tell you.

Migrating those two KV operations to the same OIDC login is the obvious
follow-up — add a `kv` write path to the `preview-publish` policy and replace
the AppRole login in that step. Until then, keep both secrets.

## The switch

`.github/actions/cluster-credentials` has two paths, selected by the
`PREVIEW_CLUSTER_AUTH` repo variable: unset/`static` decodes the kubeconfig
secret, `oidc` does the exchange above.

It is an explicit switch, **not** "try OIDC and fall back on error". A silent
fallback would turn any OpenBao misconfiguration into a quiet downgrade to the
long-lived credential — indistinguishable from success, and the exact failure
this change exists to remove. Each run logs a notice naming the path taken.

## Roles

| Job                               | Bao role            | k8s role type | Grants                                               |
| --------------------------------- | ------------------- | ------------- | ---------------------------------------------------- |
| `secrets`                         | `preview-provision` | ClusterRole   | get/create/patch Namespace; get/create/update Secret |
| `build-web`, `publish-e2e-bundle` | `preview-read`      | Role          | **get Secret only**                                  |
| `deploy`                          | `preview-deploy`    | Role          | broad, but only inside the preview namespace         |
| `destroy`                         | `preview-teardown`  | ClusterRole   | get/delete Namespace, delete workloads/PVCs          |

`build-web` runs the most untrusted code in the workflow — a full `next build`
against a PR-controlled lockfile — and now gets a token that can do exactly one
thing: read a Secret in one labelled namespace, for 20 minutes.

### Two things that are load-bearing, not incidental

**Namespaces are matched by label.** `allowed_kubernetes_namespaces` does not
accept a `pawtograder-preview-*` glob, and `*` would include
`pawtograder-prod`. So the `secrets` job labels each namespace
`pawtograder.net/preview=true` on creation and the read/deploy roles select on
that label. If that labelling step is ever removed, credential issuance stops —
which is the correct direction to fail.

**`destroy` binds no `environment` claim.** It deliberately declares no
`environment:`, so that a future required-reviewer rule can never block
teardown and leak namespaces and PVCs. GitHub only emits the `environment`
claim when a job declares one, so `preview-teardown` must not bind it. The
other three roles do bind `environment=preview`, which is what makes that
declaration meaningful.

## Prerequisites

1. **OpenBao runs in the target cluster** and its ServiceAccount can mint
   tokens (below). `bao write -f kubernetes/config` with no arguments uses
   Bao's own in-cluster identity; pass `kubernetes_host` /
   `kubernetes_ca_cert` only if Bao is outside the cluster.
2. **OpenBao has egress to `token.actions.githubusercontent.com`** for JWKS
   discovery. If it does not, the alternative is pinning
   `jwt_validation_pubkeys`, which you then have to rotate by hand when GitHub
   rolls keys — check this before committing to the approach.
3. Kubernetes **1.30+** for the `ValidatingAdmissionPolicy` below. On older
   versions, substitute a webhook or accept unbounded namespace names.

## 1. RBAC for OpenBao's ServiceAccount

The engine impersonates nothing; it calls TokenRequest and creates the
SA/Role/RoleBinding itself, so it needs those rights.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: openbao-kubernetes-secrets-engine
rules:
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["get", "create", "delete"]
  - apiGroups: [""]
    resources: ["serviceaccounts/token"]
    verbs: ["create"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings", "clusterroles", "clusterrolebindings"]
    verbs: ["get", "create", "delete"]
  # Needed to evaluate allowed_kubernetes_namespace_selector.
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: openbao-kubernetes-secrets-engine
subjects:
  - kind: ServiceAccount
    name: openbao # adjust to the actual Bao SA
    namespace: openbao
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: openbao-kubernetes-secrets-engine
```

This makes OpenBao able to grant anything it can create a ClusterRole for — it
is, by construction, a privileged component. That is the trade for not
reconfiguring the API server. Treat Bao's own access as the thing to guard.

Also create the namespace the provisioning SAs live in:

```bash
kubectl create namespace pawtograder-preview-ci
```

## 2. Bound namespace names

RBAC cannot restrict `create namespace` by name prefix, so `preview-provision`
and `preview-teardown` would otherwise be able to create or delete _any_
namespace. Bound it in admission instead:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: preview-namespace-names
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "DELETE"]
        resources: ["namespaces"]
  validations:
    # `object` is null on DELETE — the resource being removed is `oldObject`.
    # Testing `object` alone errors on every delete, and with failurePolicy:
    # Fail + Deny that blocks teardown of even valid preview namespaces.
    - expression: "(has(object) && object != null ? object : oldObject).metadata.name.startsWith('pawtograder-preview-pr-')"
      message: "preview CI may only create or delete pawtograder-preview-pr-* namespaces"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: preview-namespace-names
spec:
  policyName: preview-namespace-names
  validationActions: ["Deny"]
  # Scope to the generated SAs only, so ops and Rancher are unaffected.
  matchResources:
    namespaceSelector: {}
```

The binding as written applies to every principal, which would stop _you_
deleting a namespace by hand. Narrow it with a `matchConditions` on
`request.userInfo.username` matching
`system:serviceaccount:pawtograder-preview-ci:*` before applying. Written out
here rather than pre-narrowed because the generated SA name pattern depends on
your Bao mount path, and a policy that silently matches nothing is worse than
none.

## 3. Configure OpenBao

```bash
BAO_ADDR=https://bao.work.ripley.cloud BAO_TOKEN=... \
  ./scripts/setup-openbao-preview-oidc.sh
```

Idempotent. Override `REPO`, `BASE_REF`, `WORKFLOW`, `CI_NS` by env if needed.

## Verify — before switching CI over

A credential that turns out to be equivalent to the old one is worse than none,
because CI will report success either way.

```bash
# 1. Does the JWT role reject a token from the wrong workflow/ref?
#    Grab a real OIDC token from a scratch workflow run, then:
bao write auth/jwt/login role=preview-read jwt="$JWT"      # expect success
bao write auth/jwt/login role=preview-deploy jwt="$WRONG"  # expect permission denied

# 2. Is the read role actually read-only?
SA=$(bao write -field=service_account_token \
      kubernetes/creds/preview-read \
      kubernetes_namespace=pawtograder-preview-pr-1 ttl=5m)
kubectl --token="$SA" -n pawtograder-preview-pr-1 get secret pawtograder-jwt   # yes
kubectl --token="$SA" -n pawtograder-preview-pr-1 delete secret pawtograder-jwt # no
kubectl --token="$SA" get secret -n pawtograder-prod                            # no
kubectl --token="$SA" auth can-i '*' '*' --all-namespaces                       # no

# 3. Does the label selector actually bound issuance?
kubectl label namespace pawtograder-preview-pr-1 pawtograder.net/preview-
bao write kubernetes/creds/preview-read \
  kubernetes_namespace=pawtograder-preview-pr-1 ttl=5m   # expect failure
kubectl label namespace pawtograder-preview-pr-1 pawtograder.net/preview=true
```

## Cut over

```bash
gh variable set PREVIEW_CLUSTER_AUTH --body oidc --repo pawtograder/platform
```

Re-label a PR `preview` and watch the `Cluster credentials` step log
`OIDC-federated ServiceAccount token`. Then delete the static secrets listed at
the top.

**Rollback** is one variable: `gh variable set PREVIEW_CLUSTER_AUTH --body static`.
Keep `KUBECONFIG_BASE64` until at least one full preview deploy _and_ one
teardown have run green on OIDC — teardown is the path least likely to be
exercised by accident and the most expensive to have broken.

## Token lifetimes

`deploy` runs `helm upgrade --wait --wait-for-jobs --timeout 20m`, and the
recovery path can run a second helm operation before it, so its token is minted
at 50m against a 60m `token_max_ttl`. If a deploy ever exceeds that the symptom
is a mid-apply `Unauthorized` rather than a timeout — raise `token_max_ttl` and
the `ttl` input together, since the role cap silently truncates the request.
