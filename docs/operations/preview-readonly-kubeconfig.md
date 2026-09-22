# Read-only kubeconfig for preview CI

> **Superseded by
> [OIDC-federated cluster credentials](./preview-oidc-cluster-credentials.md)**,
> which removes the static kubeconfig entirely rather than scoping a second
> one. This remains the right move only if you want the privilege reduction
> without standing up the OpenBao JWT/Kubernetes engines — the two are
> alternatives, not steps, and doing OIDC makes
> `KUBECONFIG_PREVIEW_RO_BASE64` unnecessary.

`.github/workflows/preview.yml` builds and deploys PR-supplied code. Two of its
jobs need cluster access only to **read** one Secret, and giving them the same
kubeconfig that the deploy job uses to `helm upgrade` is more privilege than the
work needs:

| Job                  | What it actually does with the cluster                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `build-web`          | `kubectl -n <preview-ns> get secret pawtograder-jwt -o jsonpath={.data.ANON_KEY}`                                                       |
| `publish-e2e-bundle` | `kubectl get namespace`, then `kubectl -n <preview-ns> get secret <name> -o jsonpath=...` (see `scripts/publish-preview-e2e-to-bao.sh`) |

`build-web` is the job that runs the most untrusted code in the workflow — a
full `next build` against a PR-controlled lockfile and Next config — so it is
the worst place in the repo to hold a cluster-admin credential.

Both jobs read `KUBECONFIG_PREVIEW_RO_BASE64` and **fall back to
`KUBECONFIG_BASE64`** when it is unset, so CI keeps working until this is done.
Until you complete it, there is no privilege reduction — only the plumbing.

## Why not just pass the value between jobs

The `secrets` job already reads `ANON_KEY` and `::add-mask::`es it. Masked values
are stripped from job outputs, so it cannot be handed to `build-web` that way.
Scoping the credential is the available route; see the comment on the `secrets`
job in `preview.yml`.

## 1. Create the ServiceAccount and RBAC

Namespaces are created per preview (`pawtograder-preview-pr-<id>`), so the read
role has to be cluster-wide in definition. Scope it to Secrets only, `get` only.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: preview-ci-reader
  namespace: pawtograder-preview-ci
---
# A ClusterRole is a DEFINITION and grants nothing until bound. Binding this
# cluster-wide is deliberately NOT done here: it would let the preview
# credential read Secrets in every namespace, production included, and this
# credential is handed to a job that builds untrusted PR code.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: preview-secret-reader
rules:
  # `get` only: not list, not watch. The jobs look up Secrets by exact name,
  # so list/watch would only add the ability to enumerate.
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
```

Bind it **per preview namespace**, as part of that namespace's lifecycle, so
the credential reaches exactly the previews that currently exist. Add this to
the `secrets` job right after it creates the namespace:

```bash
kubectl -n "$NS" create rolebinding preview-secret-reader \
  --clusterrole=preview-secret-reader \
  --serviceaccount=pawtograder-preview-ci:preview-ci-reader \
  --dry-run=client -o yaml | kubectl apply -f -
```

The binding is deleted along with the namespace, so teardown needs no extra
step. `publish-preview-e2e-to-bao.sh` probes a Secret rather than the
Namespace precisely so this can stay namespaced: `get namespace` is
cluster-scoped and would force a cluster-wide grant straight back in.

## 2. Mint a long-lived token

```bash
kubectl create namespace pawtograder-preview-ci --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f preview-ci-reader.yaml

# Kubernetes >= 1.24 does not auto-create SA token Secrets.
kubectl -n pawtograder-preview-ci create token preview-ci-reader --duration=8760h
```

`create token` caps at the API server's `--service-account-max-token-expiration`.
If it returns something shorter than requested, either accept the shorter
lifetime and add a rotation reminder, or create a bound Secret of type
`kubernetes.io/service-account-token` instead.

## 3. Build the kubeconfig

```bash
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
TOKEN=$(kubectl -n pawtograder-preview-ci create token preview-ci-reader --duration=8760h)

cat > preview-ro.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: ripley
    cluster:
      server: ${SERVER}
      certificate-authority-data: ${CA}
users:
  - name: preview-ci-reader
    user:
      token: ${TOKEN}
contexts:
  - name: preview-ro
    context:
      cluster: ripley
      user: preview-ci-reader
current-context: preview-ro
EOF
```

## 4. Verify it is actually restricted

Do this before installing it. A credential that turns out to be equivalent to
the old one is worse than none, because the workflow will report success.

```bash
export KUBECONFIG=$PWD/preview-ro.kubeconfig
kubectl auth can-i get secrets -n pawtograder-preview-pr-1   # yes
kubectl auth can-i list secrets -n pawtograder-preview-pr-1  # no
kubectl auth can-i create namespace                          # no
kubectl auth can-i delete namespace                          # no
kubectl auth can-i '*' '*' --all-namespaces                  # no
helm list -n pawtograder-preview-pr-1                        # should fail
```

## 5. Install it

```bash
for env in preview-build preview-publish; do
  base64 -w0 preview-ro.kubeconfig | gh secret set KUBECONFIG_PREVIEW_RO_BASE64 \
    --repo pawtograder/platform --env "$env"
done
shred -u preview-ro.kubeconfig
```

Each job declares its own environment, so a secret on a single `preview`
environment resolves to empty everywhere and the workflow silently falls back
to `KUBECONFIG_BASE64`. The two jobs that read this one are `build-web`
(`environment: preview-build`) and `publish-e2e-bundle`
(`environment: preview-publish`), so set it on both, or set it repo-wide and
accept the wider scope.

## 6. Confirm the fallback is no longer in use

The fallback is silent by design, so grep a run to be sure the scoped
credential is the one being used:

```bash
gh run view <run-id> --repo pawtograder/platform --log \
  | grep -E "Read anon key from cluster|Cluster credentials"
```

Then re-run a preview and check `build-web` still gets a non-empty `ANON_KEY`.
If the scoped credential is wrong, that step fails with
`ANON_KEY missing in <ns>/pawtograder-jwt` rather than falling back.
