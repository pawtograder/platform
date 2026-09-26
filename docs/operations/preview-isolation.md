# Preview isolation on ripley

A preview runs a helm chart taken from the PR, deployed with a credential that
holds `*` on most API groups inside the preview namespace. RBAC stops at the
namespace boundary, but several things on the cluster do not: the External
Secrets Operator, ingress-nginx and the pod network are shared with every other
workload on ripley. This page covers the cluster-side controls that keep a
previewed PR inside its namespace. They key on the namespace label
`pawtograder.net/preview=true`, which the `secrets` job in `preview.yml` sets
and the deploy credential cannot change.

## Secrets: `openbao-preview` store

The cluster-wide `openbao` ClusterSecretStore reads all of `kv/apps/*` in
OpenBao (MinIO root, the Cloudflare token, Ceph, Authentik and more). It now
carries a `conditions` block that refuses namespaces with the preview label.
Previews use `openbao-preview` instead, backed by the Bao role `eso-preview`
and the policy `eso-preview-reader`, which reads only
`apps/pawtograder/preview-shared` and `apps/pawtograder/redis-shared`.

Both stores, the policy and the role live in the k8s infra repo:
`apps/external-secrets/cluster-secret-store.yaml`,
`apps/openbao/policies/eso-preview-reader.hcl` and
`apps/openbao/bootstrap/03-policies.sh`.

`preview.yml` passes `storeName=openbao-preview` to helm for every
ExternalSecret the chart renders. That override is a convenience; the store's
conditions are the control, because the chart comes from the PR.

Anything added to `eso-preview-reader` is readable by every previewed PR.

## Ingress, Services and Endpoints: admission policies

`manifests/preview-isolation.yaml` holds three ValidatingAdmissionPolicies,
bound to preview namespaces:

- `preview-ingress-surface`: every host must be
  `pr-<id>[-name].preview.pawtograder.net` for the namespace's own id, with no
  hostless rules and no `defaultBackend`. The class must be `nginx`. Only the
  nginx annotations the chart uses are allowed, and `auth-secret` may not name
  another namespace. ingress-nginx merges every Ingress for a host into one
  server block, so without this a preview could publish paths on any hostname
  on the cluster.
- `preview-service-surface`: Services must be ClusterIP with a selector and no
  `externalIPs`. This refuses NodePort, LoadBalancer, ExternalName and
  selectorless Services.
- `preview-endpoints-managed`: identities from preview namespaces may not write
  Endpoints or EndpointSlices.

## Network: Cilium policies

The same file holds two Cilium policies:

- `pawtograder-preview-egress` (clusterwide) is an egress allow-list for
  preview pods: other preview pods, kube-dns, `pawtograder-shared-redis:6379`,
  nodes on 80/443 (ingress-nginx runs on the host network) and non-RFC1918
  addresses. Everything else in the cluster and on the LAN is dropped.
- `pawtograder-ci-egress-deny` (in `arc-runners-pawtograder`) is a deny-list
  for the CI runner pool: pods in other namespaces except kube-dns, node
  management ports (kubelet, etcd, Talos apid/trustd) and RFC1918 addresses
  that are not cluster nodes. It is a deny-list because runners need GitHub,
  GHCR, the kube-apiserver, the registry and OpenBao's public name, and they
  scale to zero, so their traffic is hard to observe.

The chart's own NetworkPolicy is not a substitute: the PR controls the chart,
and the deploy role can delete NetworkPolicies.

## Applying

```bash
kubectl apply -f docs/operations/manifests/preview-isolation.yaml
```

Check the admission policies type-checked:

```bash
kubectl get validatingadmissionpolicy preview-ingress-surface \
  preview-service-surface preview-endpoints-managed \
  -o custom-columns=NAME:.metadata.name,TYPECHECK:.status.typeChecking
```

## Verifying

- An ExternalSecret in a preview namespace that names `openbao` ends in
  `SecretSyncedError` and creates no Secret.
- A server-side dry run of an Ingress for `auth.in.ripley.cloud` in a preview
  namespace is denied by `preview-ingress-surface`.
- From a preview pod, `pawtograder-postgres.pawtograder-staging:5432`,
  `openbao.openbao:8200` and `kubernetes.default:443` time out;
  `s3.talos.ripley.cloud:443`, shared Redis and `api.github.com:443` connect.
- `hubble observe --verdict DROPPED --from-namespace <preview ns>` shows only
  the probes above.

## Known residuals

- Port 443 on the nodes is ingress-nginx, which serves every Ingress on the
  cluster. A preview can reach internal hostnames through it the same way any
  LAN client can; those services rely on their own authentication.
- Previews can reach each other's pods and share the preview wildcard
  certificate, MinIO keys and Redis. That is accepted.
- A clusterwide Cilium policy cannot express "same namespace", which is why
  cross-preview traffic is allowed rather than scoped per preview.
