# OIDC-federated cluster credentials for preview CI

Replaces the static `KUBECONFIG_BASE64` secret with short-lived Kubernetes
ServiceAccount tokens, minted per job from a GitHub Actions OIDC token via
OpenBao. Nothing long-lived exists to leak or rotate, and authority comes from
claims OpenBao verifies rather than from a value in repo settings.

```
preview.yml job  (permissions: id-token: write, environment: preview-deploy)
  │  GitHub signs a claim set: repository, ref, environment, job_workflow_ref
  ▼
OpenBao  auth/jwt/login  (bound_audiences + bound_claims)
  │  short-lived Bao token carrying one policy
  ▼
OpenBao  kubernetes/creds/<role>
  │  TokenRequest -> SA token, RBAC from a pre-created ClusterRole (§1)
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
| `KUBECONFIG_BASE64`                                 | **keep** — see below                                                                                                                          |
| `KUBECONFIG_PREVIEW_RO_BASE64`                      | never needed — scoping is a Bao role, not a second kubeconfig (supersedes [preview-readonly-kubeconfig.md](./preview-readonly-kubeconfig.md)) |
| `BAO_PUBLISHER_ROLE_ID` / `BAO_PUBLISHER_SECRET_ID` | **keep** — see below                                                                                                                          |

### `KUBECONFIG_BASE64` is not retired by this change

Only `preview.yml` moved to OIDC. `release-images.yml`'s `deploy-staging` job
still decodes `KUBECONFIG_BASE64` and exits with
`KUBECONFIG_BASE64 secret is required to deploy staging` when it is empty, and
its `build-web` job reads the staging anon key the same way. Deleting the
secret stops every push to `main` and `staging` from deploying. It is also
still the `static` fallback that `preview.yml` passes at five call sites, which
is the path in use until `PREVIEW_CLUSTER_AUTH` is flipped.

Migrating `release-images.yml` to the same action is the follow-up. Until then,
keep the secret.

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

| Job                  | Bao role                    | k8s role type | Grants                                       |
| -------------------- | --------------------------- | ------------- | -------------------------------------------- |
| `secrets`            | `preview-provision`         | ClusterRole   | get/create/patch Namespace                   |
| `secrets`            | `preview-provision-secrets` | Role          | get/create/update/patch Secret               |
| `build-web`          | `preview-read`              | Role          | **get Secret only**                          |
| `publish-e2e-bundle` | `preview-publish`           | Role          | **get Secret only**                          |
| `deploy`             | `preview-deploy`            | Role          | broad, but only inside the preview namespace |
| `destroy`            | `preview-teardown`          | ClusterRole   | **get/delete Namespace only**                |
| `destroy`            | `preview-teardown-ns`       | Role          | delete workloads/PVCs/Secrets in the preview |

`secrets` mints two credentials because the Secret rule cannot ride on the
ClusterRole: a ClusterRole is bound cluster-wide, so it would grant Secret
access in every namespace including production. The admission policy below
bounds Namespace names, not Secret reach.

`destroy` mints two for the same reason, and the order matters. Its
`generated_role_rules` originally put namespaced resources (`secrets`,
`configmaps`, `pods`, `services`, `persistentvolumeclaims`, and all of
`apps`/`batch`) on the ClusterRole, so the token minted on every PR close could
read every Secret and delete every Deployment in the cluster, production
included — and because `destroy` is deliberately not trust-gated, that was the
widest credential in the system. The cluster-scoped role now holds only
`namespaces: [get, delete]`.

The cluster-scoped credential is minted first, because `preview-teardown-ns`
selects its namespace by label: for a PR closed without ever having had a
preview — the common case now that previews are opt-in — there is no namespace
to select and the mint fails. `destroy` therefore checks existence with the
cluster-scoped token, mints the namespaced one only if the namespace is there,
empties the namespace with it, and deletes the namespace itself back on the
cluster-scoped token. The two live in different files (`$HOME/.kube/config` and
`$RUNNER_TEMP/kubeconfig-preview-ns`) so neither has to be minted twice.

`preview-teardown-ns` grants `update` on Secrets on top of get/list/delete, and
covers the same apiGroups as `preview-deploy` rather than just core and
apps/batch. Both are for helm: uninstall writes the release Secret back as
"uninstalling" before it deletes anything, and it deletes every kind the chart
rendered. Without them `helm uninstall` 403s — invisibly, because the job runs
it with `|| true` and the namespace delete afterwards cleans up regardless.

`build-web` runs the most untrusted code in the workflow — a full `next build`
against a PR-controlled lockfile — and now gets a token that can do exactly one
thing: read a Secret in one labeled namespace, for 20 minutes. That 20 minutes
comes from the `ttl:` input at the call site, NOT from the role's
`token_default_ttl`: the action always sends an explicit `ttl`, so the role
default is never consulted. Shortening exposure means editing the call site in
`preview.yml`.

### Two things that are load-bearing, not incidental

**Namespaces are matched by label.** `allowed_kubernetes_namespaces` does not
accept a `pawtograder-preview-*` glob, and `*` would include
`pawtograder-prod`. So the `secrets` job labels each namespace
`pawtograder.net/preview=true` on creation and the read/deploy roles select on
that label. If that labeling step is ever removed, credential issuance stops —
which is the correct direction to fail.

**Every tier binds a different `environment` claim, teardown included.** The
role name is chosen by the caller at login, so if two tiers bound the same
claim, the job holding the weaker one could log in as the stronger. That is
what makes the split real, and it is why `publish-e2e-bundle` has its own
`preview-publish` role rather than reusing `preview-read`: `preview-read` is
bound to `preview-build`, so a job declaring `environment: preview-publish` is
rejected by it at `auth/jwt/login`.

`destroy` is the one tier with an extra constraint: its environment
(`preview-teardown`) **must never be given required reviewers**. Teardown
blocked on an approval is a leaked namespace and a leaked PVC, which is the
whole reason it is a separate environment from `preview-deploy`.

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
ServiceAccount and its binding itself, so it needs those rights.

**It does not author RBAC rules.** Every Bao role in
`scripts/setup-openbao-preview-oidc.sh` names one of the ClusterRoles below
(`kubernetes_role_name`) rather than passing `generated_role_rules`, which is
what keeps this identity from being the most dangerous thing on the cluster.
Letting the engine generate rules requires giving it `escalate` plus
create/update on `roles` AND `clusterroles` cluster-wide — Kubernetes refuses
to let a principal create rules exceeding its own, and `escalate` waives that
check. Anyone holding Bao's token could then mint arbitrary cluster
permissions, including into production namespaces, and nothing in this runbook
constrained it.

Binding by name keeps `bind` — Kubernetes still refuses to let a principal
bind a role it does not itself hold — but `bind` is scoped by `resourceNames`
to these seven roles. The worst an attacker with Bao's token can do is bind a
role you have reviewed; §2b then bounds _where_ they can bind it.

Apply these first; the engine fails at mint time with `clusterroles.rbac...
"pawtograder-preview-read" not found` if a role is missing, which is the
loud failure you want.

```yaml
# The rules that used to live in generated_role_rules, now reviewable objects.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pawtograder-preview-read # build-web: one Secret, read-only
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pawtograder-preview-publish # publish-e2e-bundle; same grant, own tier
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pawtograder-preview-deploy # helm, inside one preview namespace
rules:
  - apiGroups:
      [
        "",
        "apps",
        "batch",
        "networking.k8s.io",
        "policy",
        "autoscaling",
        "monitoring.coreos.com",
        "external-secrets.io",
        "rbac.authorization.k8s.io"
      ]
    resources: ["*"]
    verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pawtograder-preview-provision # cluster-scoped: create the namespace
rules:
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pawtograder-preview-provision-secrets # namespaced half of provision
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pawtograder-preview-teardown # cluster-scoped: delete the namespace
rules:
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pawtograder-preview-teardown-ns # empty one namespace before deleting
rules:
  - apiGroups:
      [
        "",
        "apps",
        "batch",
        "networking.k8s.io",
        "policy",
        "autoscaling",
        "monitoring.coreos.com",
        "external-secrets.io",
        "rbac.authorization.k8s.io"
      ]
    resources: ["*"]
    verbs: ["get", "list", "delete"]
  # helm writes the release Secret back as "uninstalling" before it deletes
  # anything; get/list/delete alone makes it 403 at the first step.
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["update"]
```

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: openbao-kubernetes-secrets-engine
rules:
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["get", "create", "update", "delete"]
  - apiGroups: [""]
    resources: ["serviceaccounts/token"]
    verbs: ["create"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["rolebindings", "clusterrolebindings"]
    verbs: ["get", "create", "update", "delete"]
  # NO create/update/delete on roles or clusterroles, and NO escalate: the
  # engine binds the reviewed roles above, it does not author rules. `bind`
  # is still required — Kubernetes refuses to let a principal bind a role it
  # does not hold — but resourceNames pins it to exactly these seven, so a
  # compromised Bao token cannot grant permissions nobody reviewed.
  #
  # resourceNames does not apply to `list`/`watch`, which is fine: the engine
  # only needs `get` on a role it is about to bind.
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["clusterroles"]
    verbs: ["get", "bind"]
    resourceNames:
      - pawtograder-preview-read
      - pawtograder-preview-publish
      - pawtograder-preview-deploy
      - pawtograder-preview-provision
      - pawtograder-preview-provision-secrets
      - pawtograder-preview-teardown
      - pawtograder-preview-teardown-ns
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

> **Still the most powerful identity in the design — treat it accordingly.**
> It can create a ServiceAccount anywhere and bind any of the seven reviewed
> ClusterRoles to it. §2b bounds that to the preview namespaces, and to
> `preview-provision`/`preview-teardown` for cluster-scoped bindings; apply it,
> or this identity reaches production by binding `pawtograder-preview-deploy`
> into a production namespace.
>
> What it can no longer do — and could, when the engine authored its own rules
> — is invent permissions. No `escalate`, no `create` on `roles` or
> `clusterroles`, so the ceiling is the union of seven roles you reviewed in
> git rather than anything expressible in RBAC.
>
> Two things worth doing anyway, neither of which this runbook can do for you:
>
> - **Isolate the identity** if you can: a preview-only cluster, or at least a
>   ServiceAccount used by nothing but this engine.
> - **Alert on `clusterrolebindings` writes by this ServiceAccount** in the API
>   server audit log. Legitimate traffic is namespaced RoleBindings plus the
>   two cluster-scoped tiers; anything else is worth a page.

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
        # UPDATE belongs here as much as CREATE and DELETE. `preview-provision`
        # holds `patch` on namespaces CLUSTER-WIDE (it is minted with
        # cluster_role_binding=true), because the secrets job labels the
        # namespace it just created. Every other tier is scoped by
        # `allowed_kubernetes_namespace_selector` on
        # `pawtograder.net/preview=true` — so a single `kubectl label namespace
        # <any-namespace> pawtograder.net/preview=true` makes that namespace
        # selectable by `preview-deploy` (verbs ["*"] on resources ["*"]) and
        # `preview-teardown-ns`. Labelling is an UPDATE, so with CREATE/DELETE
        # alone the policy never sees it and the name bound below is not a
        # bound at all.
        operations: ["CREATE", "UPDATE", "DELETE"]
        resources: ["namespaces"]
  # Scoped to the principals this policy is about, and this is the part you
  # must get right BEFORE applying: confirm the username (below) and edit the
  # prefix if your Bao mount path differs. Without it the policy denies
  # namespace CREATE/UPDATE/DELETE cluster-wide for every principal — see the
  # warning under the block.
  #
  # matchConditions lives HERE, on ValidatingAdmissionPolicySpec.
  # ValidatingAdmissionPolicyBindingSpec has no such field — it takes
  # policyName, paramRef, matchResources and validationActions — so putting it
  # on the binding is rejected as an unknown field, and a client that prunes
  # instead of rejecting leaves you with the unscoped binding this is meant to
  # avoid.
  matchConditions:
    - name: only-preview-ci-sas
      expression: "request.userInfo.username.startsWith('system:serviceaccount:pawtograder-preview-ci:')"
  validations:
    # `object` is null on DELETE — the resource being removed is `oldObject`.
    # Testing `object` alone errors on every delete, and with failurePolicy:
    # Fail + Deny that blocks teardown of even valid preview namespaces.
    # On UPDATE `object` is the incoming version, which is the one to bound.
    #
    # `object == null ? oldObject : object`, NOT `has(object) && ...`: `has()`
    # is a CEL macro whose argument must be a field selection (`has(x.y)`), so
    # a bare identifier does not compile in cel-go — which is what Kubernetes
    # uses — and the policy is rejected at apply time rather than behaving
    # oddly. The null test alone is also sufficient, which is why the
    # conjunction was redundant as well as invalid.
    - expression: "(object == null ? oldObject : object).metadata.name.startsWith('pawtograder-preview-pr-')"
      message: "preview CI may only create, relabel or delete pawtograder-preview-pr-* namespaces"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: preview-namespace-names
spec:
  policyName: preview-namespace-names
  # No matchResources: an omitted selector means "everything the policy's
  # matchConstraints already matched", which is what you want here. The
  # principal restriction is on the policy above, not on this object.
  validationActions: ["Deny"]
```

Confirm that username before applying — `kubectl get sa -n
pawtograder-preview-ci` after one mint, or read it out of the API server audit
log — because the generated SA name depends on your Bao mount path. The two
ways to get this wrong fail in opposite directions:

- **A `matchConditions` that matches nothing** silently disables the policy.
  The namespace-name bound is then not enforced at all, and nothing says so.
  Verify with the `can-i` checks in §Verify, not by the absence of errors.
- **No `matchConditions` at all** — for instance a binding with
  `matchResources: {namespaceSelector: {}}`, the empty selector, which matches
  EVERY namespace rather than none — denies namespace CREATE, UPDATE and
  DELETE cluster-wide for every principal, including you, Rancher, and any
  controller that creates a namespace. `failurePolicy: Fail` plus
  `validationActions: ["Deny"]` makes that immediate and total. Do not apply it
  in that form to find out.
- **`matchConditions` on the binding instead of the policy** fails the same
  way: the field does not exist on `ValidatingAdmissionPolicyBindingSpec`, so
  you get either a validation error or — with a pruning client — a silently
  unscoped binding, which is the previous bullet.

Dry-run it first; a CEL compile error in either expression surfaces here rather
than at the first teardown:

```bash
kubectl apply --dry-run=server -f preview-namespace-names.yaml
```

## 2b. Bound where preview RBAC may be attached

§1 stops OpenBao authoring rules; this stops it attaching the reviewed ones
where they do not belong. Without it the engine can still create a RoleBinding
in **any** namespace — so a compromised Bao token could bind
`pawtograder-preview-deploy` (`resources: ["*"], verbs: ["*"]`) into
production, having never created a Role at all.

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: preview-rbac-placement
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["rbac.authorization.k8s.io"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE", "DELETE"]
        resources: ["rolebindings", "clusterrolebindings"]
      # ServiceAccounts too: the engine creates one per credential, and
      # without this it could create (or edit) one in any namespace.
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE", "DELETE"]
        resources: ["serviceaccounts"]
  # The OpenBao pod's own ServiceAccount — NOT the per-credential SAs the
  # engine generates, which live in the preview namespaces. Confirm it before
  # applying; a matchConditions that matches nothing disables the policy
  # silently.
  matchConditions:
    - name: only-openbao
      expression: "request.userInfo.username == 'system:serviceaccount:openbao:openbao'"
  variables:
    - name: obj
      expression: "object == null ? oldObject : object"
    - name: ns
      expression: "request.namespace"
    - name: previewNs
      expression: "request.namespace.startsWith('pawtograder-preview-pr-') || request.namespace == 'pawtograder-preview-ci'"
  validations:
    # ServiceAccounts: the preview namespace (namespaced tiers) or
    # pawtograder-preview-ci (cluster tiers), nowhere else.
    - expression: "request.resource.resource != 'serviceaccounts' || variables.previewNs"
      message: "OpenBao may only manage ServiceAccounts in pawtograder-preview-pr-* or pawtograder-preview-ci"
    # RoleBindings: preview namespaces only, to one of the five namespaced
    # tiers, and ONLY to ServiceAccounts in that same namespace. Checking the
    # roleRef without the subjects bounded WHAT could be bound but not TO
    # WHOM: a stolen Bao token could bind a tier to any identity it liked.
    - expression: >-
        request.resource.resource != 'rolebindings' || (
          variables.previewNs &&
          variables.obj.roleRef.kind == 'ClusterRole' &&
          variables.obj.roleRef.name in ['pawtograder-preview-read', 'pawtograder-preview-publish',
            'pawtograder-preview-deploy', 'pawtograder-preview-provision-secrets', 'pawtograder-preview-teardown-ns'] &&
          (!has(variables.obj.subjects) || variables.obj.subjects.all(s,
            s.kind == 'ServiceAccount' && has(s.namespace) && s.namespace == variables.ns))
        )
      message: "OpenBao may only bind a namespaced preview tier, inside a preview namespace, to a ServiceAccount in that namespace"
    # ClusterRoleBindings: only the two tiers that are cluster-scoped by
    # necessity, and only to ServiceAccounts in pawtograder-preview-ci. Binding
    # preview-deploy or preview-teardown-ns cluster-wide would hand every
    # namespace to CI; binding provision/teardown to an arbitrary subject —
    # OpenBao's own SA included — would hand it cluster-wide namespace
    # create/delete that outlives any lease.
    - expression: >-
        request.resource.resource != 'clusterrolebindings' || (
          variables.obj.roleRef.name in ['pawtograder-preview-provision', 'pawtograder-preview-teardown'] &&
          (!has(variables.obj.subjects) || variables.obj.subjects.all(s,
            s.kind == 'ServiceAccount' && has(s.namespace) && s.namespace == 'pawtograder-preview-ci'))
        )
      message: "OpenBao may only create ClusterRoleBindings for preview-provision/-teardown, to ServiceAccounts in pawtograder-preview-ci"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: preview-rbac-placement
spec:
  policyName: preview-rbac-placement
  validationActions: ["Deny"]
```

Same two failure modes as §2, and the same dry run applies:

```bash
kubectl apply --dry-run=server -f preview-rbac-placement.yaml
```

With §1 and §2b together, a compromised OpenBao token can bind seven reviewed
roles, in preview namespaces only, plus two of them cluster-scoped. That is a
bounded, enumerable blast radius rather than "arbitrary cluster permissions",
which is what it was when the engine authored its own rules.

## 3. Configure OpenBao

```bash
BAO_ADDR=https://bao.work.ripley.cloud BAO_TOKEN=... \
  ./scripts/setup-openbao-preview-oidc.sh
```

Idempotent. Override `REPO`, `BASE_REFS`, `WORKFLOW`, `CI_NS` by env if needed.

## Verify — before switching CI over

A credential that turns out to be equivalent to the old one is worse than none,
because CI will report success either way.

```bash
# 1. Does the JWT role accept the right token and reject the wrong one?
#
#    The POSITIVE test needs a token minted BY preview.yml: the role binds
#    job_workflow_ref to `.../preview.yml@<allowed base ref>` AND
#    environment=preview-build, and a scratch workflow's token has neither.
#    Testing with a scratch token reports "permission denied" for a correctly
#    configured role, which reads as a broken cutover. Get one by temporarily
#    echoing the token's CLAIMS (never the token) from a preview.yml job
#    running in the preview-build environment.
#
#    Before either test, confirm the claim this binding rests on is present.
#    GitHub documents job_workflow_ref under reusable workflows; its own
#    example token for a direct job carries it too, and these jobs call a
#    composite action rather than a reusable workflow. If it is ABSENT for
#    your runs, bind `workflow_ref` in setup-openbao-preview-oidc.sh instead
#    (same value for a direct job) rather than discovering it as five failing
#    logins at cutover:
python3 -c 'import base64,json,sys;p=sys.argv[1].split(".")[1];print(sorted(json.loads(base64.urlsafe_b64decode(p+"=="*(-len(p)%4)))))' "$PREVIEW_JWT"

bao write auth/jwt/login role=preview-read jwt="$PREVIEW_JWT"   # expect success
bao write auth/jwt/login role=preview-deploy jwt="$PREVIEW_JWT" # expect denied
                                                                # (wrong environment claim)

# 2. Is the read role actually read-only?
#
#    ttl=10m, not less: TokenRequest rejects expirationSeconds under 600
#    ("may not specify a duration less than 10 minutes"), and the engine does
#    NOT clean up the ServiceAccount and RoleBinding it created before that
#    failure — look for leftover v-root-* objects afterwards.
#
#    Test through a kubeconfig holding ONLY the minted token. `kubectl
#    --token=` on top of an admin kubeconfig still sends the admin client
#    certificate, the API server authenticates the certificate first, and
#    every check below then reports what cluster-admin can do — all "yes",
#    which looks like a catastrophically broad role rather than a broken test.
#    `auth whoami` must print system:serviceaccount:..., not your own user.
SA=$(bao write -field=service_account_token \
      kubernetes/creds/preview-read \
      kubernetes_namespace=pawtograder-preview-pr-1 ttl=10m)
TK=$(mktemp); kubectl config view --raw --minify -o json |
  jq --arg t "$SA" '.users[0].user = {token: $t}' > "$TK"
k() { kubectl --kubeconfig "$TK" "$@"; }
k auth whoami                                                          # system:serviceaccount:...
k auth can-i get secret/pawtograder-jwt -n pawtograder-preview-pr-1    # yes
k auth can-i delete secret/pawtograder-jwt -n pawtograder-preview-pr-1 # no
# NAMED get, not `get secret -n ...`: without a name kubectl does a LIST,
# which this role never grants, so a cluster-wide get-only binding would
# still show the "expected" denial.
k auth can-i get secret/pawtograder-jwt -n pawtograder-prod            # no
k auth can-i '*' '*' --all-namespaces                                  # no
rm -f "$TK"

# 3. Does the label selector actually bound issuance?
kubectl label namespace pawtograder-preview-pr-1 pawtograder.net/preview-
bao write kubernetes/creds/preview-read \
  kubernetes_namespace=pawtograder-preview-pr-1 ttl=10m  # expect failure
kubectl label namespace pawtograder-preview-pr-1 pawtograder.net/preview=true

# 4. Test Bao policy restrictions with a NON-root token. A root token ignores
#    denied_parameters, so `cluster_role_binding=true` "succeeding" as root
#    proves nothing about the policy (§2b should still refuse the binding).
PT=$(bao token create -policy=preview-deploy -ttl=15m -field=token)
BAO_TOKEN=$PT bao write kubernetes/creds/preview-deploy \
  kubernetes_namespace=pawtograder-preview-pr-1 cluster_role_binding=true ttl=10m  # permission denied
BAO_TOKEN=$PT bao token revoke -self
```

## Cut over

```bash
gh variable set PREVIEW_CLUSTER_AUTH --body oidc --repo pawtograder/platform
```

Re-label a PR `preview` and watch the `Cluster credentials` step log
`OIDC-federated ServiceAccount token`.

Do not delete any secret at this point. Per the table above,
`KUBECONFIG_BASE64` is still required by `release-images.yml` and the
`BAO_PUBLISHER_*` pair is still the login for both KV operations; the only one
this change makes unnecessary is `KUBECONFIG_PREVIEW_RO_BASE64`, which was
never created.

**Rollback** is one variable: `gh variable set PREVIEW_CLUSTER_AUTH --body static`.
That only works while `KUBECONFIG_BASE64` still exists, which is one more
reason to keep it. Confirm at least one full preview deploy _and_ one teardown
have run green on OIDC before relying on the new path: teardown is the least
likely to be exercised by accident and the most expensive to have broken.

## Token lifetimes

`deploy` runs `helm upgrade --wait --wait-for-jobs --timeout 20m`, and the
recovery path can run a second helm operation before it, so its token is minted
at 50m against a 60m `token_max_ttl`. If a deploy ever exceeds that the symptom
is a mid-apply `Unauthorized` rather than a timeout.

THREE limits have to clear the job's runtime, not one, and the third is the
easy one to miss:

1. the `ttl` input at the call site in `preview.yml` (50m for `deploy`);
2. the Kubernetes role's `token_max_ttl` (60m), which silently truncates a
   larger request;
3. the JWT auth role's `token_ttl` — the lifetime of the **Bao token** the
   action logs in with, in `scripts/setup-openbao-preview-oidc.sh`.

(3) is the ceiling over the other two. A dynamic-secret lease is a child of the
token that created it, so when the Bao token expires its lease is revoked with
it, OpenBao deletes the generated ServiceAccount, and every token issued for
that SA stops working _immediately_ — regardless of the 50m stamped on it. The
action logs in once and never renews. So a `token_ttl` shorter than the longest
`ttl` any job requests makes the extra minutes fiction: raise all three
together, and keep `token_ttl >= max(ttl)`.
