# Preview isolation on ripley

A preview runs a helm chart taken from the PR. Whatever the deploy credential
may write, the PR may write, and RBAC stops at the namespace boundary while
several things on the cluster do not: the External Secrets Operator,
ingress-nginx, Reflector, the Grafana sidecar, the Prometheus Operator, the
scheduler and the pod network are shared with every other workload on ripley.
This page covers the controls that keep a previewed PR inside its namespace.
Most key on the namespace label `pawtograder.net/preview=true`, which the
`secrets` job in `preview.yml` sets and the deploy credential cannot change.

## The deploy role

`pawtograder-preview-deploy` (defined in
[preview-oidc-cluster-credentials.md](./preview-oidc-cluster-credentials.md))
grants exactly the kinds the chart renders for a preview: Deployments,
StatefulSets, Jobs, ConfigMaps, Services, ServiceAccounts, Secrets (also helm's
release storage), Ingresses, ExternalSecrets, ServiceMonitors and
PrometheusRules. It also has read-only access to pods, logs, events,
Endpoints, PVCs and ReplicaSets for `helm --wait`. It has no RBAC,
NetworkPolicy, SecretStore, PodMonitor, DaemonSet, Endpoints-write,
`pods/exec` or token-request rights. This is the first line: a kind the role
cannot write is a kind no controller can be tricked with. The admission
policies below constrain the kinds it can write, and stay in place as a second
line if the role grows.

When a chart change adds a kind, the preview fails with `forbidden` until the
kind is reviewed and added to both `preview-deploy` and `preview-teardown-ns`.
Check whether a cluster-wide controller acts on it before adding it.

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
  hostless rules and no `defaultBackend`. The class must be `nginx`. Every
  annotation must be on an allow-list (the nginx annotations the chart uses,
  plus helm and kubectl bookkeeping), because other controllers read Ingress
  annotations too: cert-manager's ingress-shim would issue a certificate from
  the DNS-01 issuer for the whole `pawtograder.net` zone. Values are bounded
  too, because ingress-nginx is shared with staging: `proxy-body-size` at most
  `100m` (never `0`, which means unlimited), buffers at most 16 × 64k, and
  timeouts at most an hour. `auth-secret` may not name another namespace. ingress-nginx merges every Ingress for a host into one
  server block, so without this a preview could publish paths on any hostname
  on the cluster.
- `preview-service-surface`: Services must be ClusterIP with a selector and no
  `externalIPs`. This refuses NodePort, LoadBalancer, ExternalName and
  selectorless Services.
- `preview-endpoints-managed`: in a preview namespace, only the three
  kube-controller-manager endpoint controllers may write Endpoints or
  EndpointSlices. The check is on the writer, not its namespace: the chart can
  grant `endpoints` to a ServiceAccount anywhere on the cluster. There is no
  `system:masters` exemption, because in `PREVIEW_CLUSTER_AUTH=static` mode the
  chart is applied with a cluster-admin kubeconfig.

## Other cluster-wide controllers

Several controllers act on objects in any namespace. The deploy role can create
those objects, so each gets an admission policy:

- `preview-externalsecret-surface`: only ExternalSecrets, and only against
  `ClusterSecretStore/openbao-preview` with no per-entry `sourceRef`. A
  namespaced SecretStore with the Webhook provider would have the shared ESO
  controller fetch any URL and store the response in a preview Secret.
  SecretStores, PushSecrets and generators are refused.
- `preview-controller-keys`: on Secrets and ConfigMaps, only Reflector itself
  may write `reflector.v1.k8s.emberstack.com/*` annotations (otherwise a
  preview could push data into `pawtograder-staging`), and the Grafana sidecar
  labels `grafana_dashboard`, `grafana_datasource` and `grafana_alert` are
  refused. The dashboard sidecar reads every namespace and keys files by name,
  so preview dashboards were replacing staging's; `preview.yml` now renders
  none.
- `preview-pod-injection`: no OpenTelemetry operator injection annotations,
  which accept references to another namespace's Instrumentation. It also
  keeps preview pods off nodes reserved for staging and the control plane.
  Those nodes are tainted, so the policy refuses every toleration except
  Kubernetes' own `node.kubernetes.io/*`, refuses `spec.nodeName` on create
  (which would skip the scheduler), and refuses any `priorityClassName`.

## Pod specs, claims and finalizers

The Cilium policy governs traffic from the preview's pods. Some parts of a pod
spec are carried out by the node's kubelet instead, from the node network, and
some objects can outlive teardown. These policies cover them:

- `preview-pod-spec` (pods) and `preview-workload-template` (Deployment,
  StatefulSet and Job templates, so a bad template is refused up front and
  does not fail pod creation in a loop):
  - Volumes: only `configMap`, `secret`, `projected`, `emptyDir`,
    `downwardAPI` and `persistentVolumeClaim`. PSA `baseline` still allows
    NFS, iSCSI, CephFS, RBD and inline CSI, which the kubelet mounts from the
    node network.
  - Probes and lifecycle handlers may not set a `host`, and probes may run no
    more often than every 5s. PSA `baseline` also refuses a host on pods; the
    template check catches it earlier.
  - Images must come from Docker Hub (including short names), `ghcr.io` or
    `quay.io`. The node's runtime pulls them, outside the egress policy, so an
    image naming an internal host, IP or port would be a node-originated
    request; the nodes pull all three registries through the in-cluster
    mirrors.
  - `terminationGracePeriodSeconds` at most 900 (the chart's longest is 600,
    for Postgres). Kubernetes honours it on uninstall and namespace deletion.
  - The template policy also repeats the per-pod rules from
    `preview-pod-injection` (no `nodeName`, only `node.kubernetes.io/*`
    tolerations, no `priorityClassName`, at most 6 + 6 containers, no
    OpenTelemetry annotations), so the workload is refused rather than its
    controller retrying pods that would be.
- `preview-statefulset-claims` and `preview-pvc-surface`: claims must use
  `ceph-rbd` and may not pick a volume (`volumeName`, `selector`, a data
  source). `local-minio` is a Retain class with pre-made volumes.
- `preview-finalizers`: only the finalizers a real controller owns, on the kind
  it manages (ESO's cleanup on ExternalSecrets, `pvc-protection` on PVCs, the
  Job controller's tracking finalizer on pods, and the garbage collector's
  `foregroundDeletion`/`orphan`). Workload and claim templates may carry none.
  A finalizer no controller removes would leave the namespace `Terminating`
  forever, and the teardown role cannot patch it away.

CEL in admission policies is type-checked separately for each kind a policy
matches, so a field one kind lacks (a Pod has no `spec.template`) is an error
even behind a guard. Expressions that fail at runtime deny under
`failurePolicy: Fail`. Keep each policy to kinds that share the fields it
reads, and check `.status.typeChecking` after every change.

## List sizes and reconcile rates

Quotas count objects, not what is inside them. The admission policies also cap
list sizes and rates that land on shared controllers, each a few times above
what the chart renders:

- Ingress: at most 5 rules, 10 paths per rule and 2 TLS entries of 5 hosts
  (ingress-nginx renders and reloads all of it).
- Service: at most 8 ports (Cilium programs each one on every node).
- ExternalSecret: at most 20 `data` and 5 `dataFrom` entries, refreshed no
  more often than every 5 minutes (the shared ESO controller and OpenBao).
- PrometheusRule: at most 20 groups and 100 rules, evaluated no more often
  than every 30s.
- ServiceMonitor: a required `bodySizeLimit` of at most 16MiB, in MiB or KiB
  (Kyverno fills in 10MiB), on top of the sample, target and interval bounds
  below.
- Pod: at most 6 containers and 6 init containers (kubelet and runtime work),
  with LimitRange floors of 10m CPU and 16Mi memory per container so they
  cannot be packed in for free.
- Deployment and StatefulSet (`preview-workload-bounds`): at most 3 replicas,
  and `revisionHistoryLimit` at most 10 (the default), so history cannot fill
  the ReplicaSet and ControllerRevision quotas.
- Job: parallelism at most 2, completions at most 4, at most 6 retries. The
  quota rejects pods past its ceiling, but controllers keep retrying them, so
  desired sizes are bounded where they are declared. The chart runs everything
  at 1 replica and 1 pod.

## Resource ceilings

Kyverno policy `preview-resource-ceilings` generates a ResourceQuota
(`preview-quota`) and LimitRange (`preview-limits`) in every preview namespace
and puts them back if they change. `preview-ceilings-managed` lets only
Kyverno's background controller and the namespace controller write them; the
deploy role holds core `*` and RBAC in the namespace, so without it the chart
could delete the quota or grant that right elsewhere. Kyverno generates them
asynchronously, so the `secrets` job in `preview.yml` waits for both to exist
before any build or deploy job starts, and fails the preview if they do not
appear. Besides CPU, memory,
storage and pods, the quota counts every namespaced type the deploy role can
create (Deployments, ReplicaSets, RBAC, ServiceAccounts, ExternalSecrets,
monitoring CRs and so on), so a chart cannot pile up objects that cost
apiserver, controller or operator capacity. It is sized from measured previews
with headroom for a rolling deploy; the manifest records the measurements.

## Monitoring: admission policies and a Kyverno mutation

The cluster Prometheus (`monitoring/kps-prometheus`) selects monitoring CRs from
every namespace and sits outside the preview egress policy, and the deploy role
holds `monitoring.coreos.com/*`. Previews legitimately create ServiceMonitors
and one alert-only PrometheusRule, so these kinds are constrained, not removed:

- `preview-servicemonitor-surface`: allow-lists of ServiceMonitor spec and
  endpoint fields (the chart's shape plus limits and TLS/auth that reference
  Secrets). `namespaceSelector` may name only the preview's own namespace. This
  refuses `honorLabels`, relabelings, `jobLabel` and target labels (forging
  another namespace's series); `proxyUrl` and `oauth2` (making Prometheus call
  arbitrary URLs); and `bearerTokenFile` and TLS `*File` fields (reading files
  off the Prometheus pod). It also requires `followRedirects: false`.
- `preview-servicemonitor-no-redirects` (Kyverno `ClusterPolicy`) sets
  `followRedirects: false` on every preview ServiceMonitor endpoint. Prometheus
  follows redirects by default, so without this a preview pod could redirect
  the scraper to any internal URL. Mutation runs before validation, so charts
  need no change, and the policy above fails closed if Kyverno is down. The
  same policy fills in `sampleLimit: 20000` and `targetLimit: 50` when a
  chart omits them; the VAP caps them at 50000 and 100, requires a scrape
  interval of at least 15s, and allows at most 4 endpoints per
  ServiceMonitor.
- `preview-prometheusrule-surface`: alerting rules only. A recording rule could
  write arbitrary series into the shared Prometheus.
- `preview-monitoring-kinds`: every other monitoring kind (PodMonitor, Probe,
  ScrapeConfig, AlertmanagerConfig and the operator's own CRs) is refused.

## Network: Cilium policies

The same file holds two Cilium policies:

- `pawtograder-preview-egress` (clusterwide) is an egress allow-list for
  preview pods: other preview pods, kube-dns, `pawtograder-shared-redis:6379`,
  nodes on 80/443 (ingress-nginx runs on the host network) and non-RFC1918
  addresses. Everything else in the cluster and on the LAN is dropped. The
  forbidden set is repeated as `egressDeny` rules. Cilium unions the allows of
  every policy that selects a pod, and the deploy role can create
  NetworkPolicies, so without the denies a chart could add an allow-all egress
  policy and reopen everything. A deny wins over any allow.
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
  preview-servicemonitor-surface preview-prometheusrule-surface \
  preview-monitoring-kinds preview-externalsecret-surface \
  preview-controller-keys preview-pod-injection preview-ceilings-managed \
  preview-workload-bounds preview-pod-spec preview-workload-template \
  preview-statefulset-claims preview-pvc-surface preview-finalizers \
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
- The same probes give the same results with an allow-all egress
  NetworkPolicy added to the preview namespace.
- `hubble observe --verdict DROPPED --from-namespace <preview ns>` shows only
  the probes above.

## Known residuals

- The deploy job applies the PR's chart, and helm's `lookup` reads anything
  the deploy credential can read. That is safe only because the credential is
  the namespaced OIDC `preview-deploy` token; `preview.yml` has no static
  kubeconfig path, and one must not be added back.

- A preview's alert rules are evaluated by the shared Prometheus and can query
  any series, so an expensive expression costs cluster-wide query capacity.
  No Alertmanager is wired to that Prometheus, so preview alerts page nobody.

- Port 443 on the nodes is ingress-nginx, which serves every Ingress on the
  cluster. A preview can reach internal hostnames through it the same way any
  LAN client can; those services rely on their own authentication.
- Previews can reach each other's pods and share the preview wildcard
  certificate, MinIO keys and Redis. That is accepted.
- A clusterwide Cilium policy cannot express "same namespace", which is why
  cross-preview traffic is allowed rather than scoped per preview.
