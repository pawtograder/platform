# Production Install (first bring-up)

An ordered checklist for standing up a fresh production Pawtograder on a
Rancher-managed Kubernetes cluster. It expands the operator checklist in
[`values-prod.yaml`](../../charts/pawtograder/examples/values-prod.yaml) into a
sequence, and points at the chart docs for the details of each step.

This is the _cluster_ bring-up. It complements, and does not replace:

- [`charts/pawtograder/README.md`](../../charts/pawtograder/README.md) — the
  source of truth for values, secrets, and image builds.
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md) — the **integration credentials** (GitHub
  App, LTI, Discord, SMTP, EventBridge) that the chart mounts. Obtain those in
  parallel; the chart won't be fully functional without them.
- [`PRODUCTION-READINESS.md`](../../charts/pawtograder/PRODUCTION-READINESS.md) —
  what's hardened and what's deferred (Postgres HA, WAL/PITR).

Throughout, `NS` is the release namespace (e.g. `pawtograder-prod`) and
`<release>` is the Helm release name. Cluster access is a kubeconfig from the
prod Rancher project (or the Rancher UI where a shell is easier).

---

## Order matters

Several steps must land **before** the first `helm upgrade`, because the render
guard rails (`templates/validations.yaml`, armed by `global.environment:
production`) refuse to render otherwise, and because the pods fail to start
without their secrets and storage. Do them in this order.

### 1. Cluster prerequisites

- [ ] **Namespace** created in the target Rancher project (`kubectl create ns "$NS"`, or the Rancher UI). Keep it in its own project for RBAC isolation.
- [ ] **Replicated storage class** available and set as `postgres.persistence.storageClass` in your values. **Not `local-path`**: node loss on a single-primary Postgres with node-local storage is unrecoverable short of the last backup. Ceph RBD, cloud block storage (EBS/PD), or equivalent.
- [ ] **ingress-nginx** (or your ingress controller) installed; its namespace
      label matches `networkPolicy.ingressControllerNamespaceSelector`.
- [ ] **cert-manager** with the `ClusterIssuer` named in `ingress.annotations`
      (`letsencrypt-prod` in the template).
- [ ] **DNS** for `global.hostname` (and `api.<hostname>` if
      `apiOnSeparateHost: true`, plus `studio.<hostname>` only if you expose
      Studio) pointing at the ingress load balancer.
- [ ] **PriorityClasses** created cluster-side if you set
      `global.priorityClassName` (the chart references them; it does not create
      them).
- [ ] **External Secrets Operator** — required **only if** you sync secrets
      from a store (the `values-prod.yaml` path). Install it with a `SecretStore`/
      `ClusterSecretStore` pointing at your OpenBao/Vault. If your cluster has no
      ESO, use the pre-created-Secrets path instead — see §2 and
      [`values-prod-noeso.yaml`](../../charts/pawtograder/examples/values-prod-noeso.yaml);
      ESO is not otherwise a prerequisite.
- [ ] **Redis** — pick a provider. `internal` (the no-ESO default in
      [`values-prod-noeso.yaml`](../../charts/pawtograder/examples/values-prod-noeso.yaml))
      deploys a single-replica Redis with the release and owns the
      `pawtograder-redis` Secret — nothing to provision. `shared` (the
      `values-prod.yaml` path) uses a cluster-wide Redis you run outside the
      release, synced via ESO: deploy the instance from
      [`charts/pawtograder/examples/shared-redis/`](../../charts/pawtograder/examples/shared-redis/)
      and populate its OpenBao path with `setup-openbao-redis-shared.sh
      --bao-path apps/pawtograder/redis-production` (it defaults to the
      `redis-shared` path, so pass `--bao-path`); the chart then syncs it into
      `pawtograder-redis` via `templates/redis-externalsecret.yaml`. Redis state
      is reconstructable either way — losing it is not data loss.
- [ ] **kube-prometheus-stack** (or an equivalent Prometheus Operator plus
      Grafana) installed. The chart's ServiceMonitors, PrometheusRules, and
      Grafana dashboards depend on it (see the chart README's "Monitoring"
      section). The Grafana dashboard sidecar must watch the app namespace, but
      kube-prometheus-stack defaults to watching only Grafana's own namespace,
      so set `grafana.sidecar.dashboards.searchNamespace: ALL` (or include
      `$NS`), or the shipped dashboards are silently absent. Routing a
      `severity: critical` alert to a human is the separate step in §6.

### 2. Secret material (ESO or pre-created — never chart-generated)

`secrets.create` and `secrets.autogenerate` are **refused** under
`environment: production` — key material must never be generated into Helm
release history. The guard does **not** mandate ESO, though: it is satisfied by
Secrets that already exist in the namespace. Two supported paths:

- **Pre-created (no ESO)** — the [`values-prod-noeso.yaml`](../../charts/pawtograder/examples/values-prod-noeso.yaml)
  path, for clusters without External Secrets Operator. Set
  `secrets.externalSecret.enabled: false` (the chart then renders **no**
  ExternalSecrets) and create the base Secrets yourself before install —
  sealed-secrets for a GitOps repo, or `kubectl create secret` for a manual
  one. Each Secret's exact key list is documented in
  [`charts/pawtograder/examples/externalsecrets/`](../../charts/pawtograder/examples/externalsecrets/)
  (one manifest per base Secret) and the chart README's "Required Secrets".
  With `redis.provider: internal` the chart owns `pawtograder-redis`, so you
  create only the six base Secrets (`jwt`, `postgres`, `s3`, `smtp`, `web`,
  `edge-functions`). Then skip to §3 — the ESO steps below don't apply.
- **ESO-synced** — the [`values-prod.yaml`](../../charts/pawtograder/examples/values-prod.yaml)
  path: populate the backing store (OpenBao/Vault), then let the chart's
  ExternalSecrets sync it into the `secrets.names` K8s Secrets, as below.

The chart renders ExternalSecrets for only three of the Secrets it mounts:
`pawtograder-web` and `pawtograder-edge-functions`
(`templates/edge-functions-externalsecret.yaml`) plus `pawtograder-redis`
(`templates/redis-externalsecret.yaml`). The four base Secrets
(`pawtograder-jwt`, `pawtograder-postgres`, `pawtograder-s3`,
`pawtograder-smtp`) are not chart-rendered, so you author their ExternalSecrets
yourself. Example manifests, one per base Secret, live in
[`charts/pawtograder/examples/externalsecrets/`](../../charts/pawtograder/examples/externalsecrets/);
each target Secret's key list matches exactly what the chart consumes.

- [ ] **JWT bundle** generated with `scripts/GenerateJwtKeys.ts` and stored in
      OpenBao. **Escrow the private key** somewhere durable and separate —
      losing it invalidates every issued session and signed URL.
- [ ] **Web + edge-function bundles** populated with
      `scripts/setup-openbao-edge-functions.sh` (`web` for GoTrue/LTI/web-only
      keys, plus GitHub App, Discord, Canvas, MCP/LLM, Sentry, and every
      `edgeFunctionsBundles` entry you enable). The prod template includes the
      `misc` bundle because it carries `EDGE_FUNCTION_SECRET` for DB→edge
      callbacks.
- [ ] **Postgres, S3, SMTP** secrets populated (`pawtograder-postgres`,
      `pawtograder-s3`, `pawtograder-smtp`).
- [ ] **ExternalSecrets** applied and **synced green** before installing the
      chart. Confirm: `kubectl -n "$NS" get externalsecret` shows every one
      `SecretSynced=True`. Base Secrets (`jwt`, `postgres`, `s3`, `smtp`) are
      required for pod startup; optional web/edge integration bundles fail later
      on the feature path that needs the missing key.

See the chart README's "Required Secrets" and "Integration credentials via
OpenBao + ESO" sections for the exact paths and keys.

### 3. Object storage

Create the buckets on any S3-compatible backend (e.g., AWS S3, MinIO, or Ceph
RGW) with its own console or CLI. Point `storage.s3.endpoint` /
`backup.s3.endpoint` at that backend and put the credentials in
`pawtograder-s3`. For how to size these buckets and the app-data retention
policy they hold, see [data-retention.md](./data-retention.md).

- [ ] **Storage + backup buckets** created **with versioning on**
      (`storage.s3.bucket`, `backup.s3.bucket`).
- [ ] **Noncurrent-version expiration** added to both buckets. Backup retention
      is an `mc ilm` object-expiry rule the backup Job creates
      (`templates/backup.yaml`, keyed off `backup.retentionDays`). On a
      versioned bucket, object expiry only writes delete markers, so old
      noncurrent versions accumulate indefinitely and storage grows without
      bound. Add a noncurrent-version expiration rule to each bucket so
      superseded versions age out.

### 4. Production image builds

The web image bakes `NEXT_PUBLIC_SUPABASE_URL` and the cluster's anon key at
build time, so a staging image cannot serve prod. The `release-images.yml`
`workflow_dispatch` takes `web_hostname`, `api_hostname`, `namespace`,
`channel`, and `channel_host_suffix`. There is no anon-key input. The build
reads the anon key live from `<namespace>/pawtograder-jwt` in the cluster
(`release-images.yml`, the "Read anon key from cluster" step), so `namespace`
must be your prod namespace.

- [ ] Build web / edge-functions / migrations via `release-images.yml`
      (`workflow_dispatch`), with `web_hostname` / `api_hostname` set to the
      prod hostname(s) and `namespace` set to the prod namespace.
- [ ] Confirm the CI secret `KUBECONFIG_BASE64` holds a kubeconfig that reaches
      the prod cluster API. The web build reads the anon key through it and
      fails hard if it is missing or cannot reach the cluster.
- [ ] **Pin the resulting tags** (`vX.Y.Z` or `<branch>-<sha>`) in
      `web.image.tag`, `edgeFunctions.image.tag`, `migrations.image.tag`. A
      floating `*-latest` tag is refused by the prod render guard.

> **Known blocker, tracked for the prod-deploy repo work.** The web build bakes
> `STAGING_GITHUB_OAUTH_CLIENT_ID`, `STAGING_BUGSINK_DSN`, and the staging
> PostHog keys into every image with no prod override (`release-images.yml`, the
> "Build & push web image" step), so a prod web image built today ships staging
> OAuth, error reporting, and analytics. Do not patch the workflow here. It is
> out of scope for the cluster bring-up.

### 5. Install

Copy the base template that matches your cluster into your deployment repo and
fill every `← ...` blank: [`values-prod.yaml`](../../charts/pawtograder/examples/values-prod.yaml)
(ESO + shared Redis) or [`values-prod-noeso.yaml`](../../charts/pawtograder/examples/values-prod-noeso.yaml)
(pre-created Secrets + in-chart Redis + existing wildcard cert). Then:

```bash
helm upgrade --install <release> ./charts/pawtograder \
  -n "$NS" --create-namespace \
  -f <your-prod-values>.yaml --wait --wait-for-jobs
```

Order of operations inside the chart: Postgres StatefulSet comes up → the
migrations Job waits for Postgres **and** the Supabase services' own migrations,
then applies Pawtograder migrations and rewrites the vault edge-callback URL to
the in-cluster Kong host → the stateless tiers retry until the schema exists.
`--wait --wait-for-jobs` blocks until Deployments are Ready and the per-revision
migrations Job has completed.

If the render is **refused**, the guard rails caught a staging-only setting
(e2e, `secrets.create`/`autogenerate`, `seed.enabled`, `resetOnDrift`, a
floating or unpinned image tag, an empty `postgres.persistence.storageClass`,
unset PrometheusRule labels, or an unauthenticated Studio ingress). Fix the
values; do not disable the guard.

### 6. Post-install verification

- [ ] **Helm smoke test** passes:
      `helm test <release> -n "$NS"`.
- [ ] **Human smoke test** (below) passes.
- [ ] **First backup + verify.** Wait for the first scheduled `backup` Job (or trigger one: `kubectl -n "$NS" create job --from=cronjob/<release>-backup backup-manual`), then confirm `backup-verify` goes green — it runs weekly, so trigger it too rather than waiting: `kubectl -n "$NS" create job --from=cronjob/<release>-backup-verify backup-verify-manual`. A restore is only as good as its last verified backup — see [disaster-recovery.md](./disaster-recovery.md).
- [ ] **Alerts wired end-to-end.** The chart's PrometheusRules show up in the
      cluster Prometheus (`prometheusRules.labels` matched the `ruleSelector`),
      and a test `severity: critical` alert reaches a human through
      Alertmanager. See [monitoring-alerting.md](./monitoring-alerting.md).
- [ ] **Integration credentials** installed and exercised (GitHub App webhook
      delivery, SMTP send, LTI launch if used) per [DEPLOYMENT.md](../../DEPLOYMENT.md).

---

## Smoke test

The minimum "is this release actually serving" check. Run it after every
install, [rollback](./rollback.md), and [restore](./disaster-recovery.md).

1. **App loads.** `https://<hostname>` returns the sign-in page over HTTPS with
   a valid cert (no mixed-content / CSP errors in the console).
2. **Auth works.** Sign in as a known user; the session persists across a
   navigation.
3. **Data plane reads.** Open a course and load the gradebook — this exercises
   PostgREST + RLS.
4. **A recent submission renders** — exercises storage (file fetch) and the
   submission view.
5. **Realtime connects.** The office-hours / discussion view shows a live
   WebSocket connection (no reconnect loop in the console).
6. **DB→edge callbacks fire.** Trigger a gradebook recalculation and confirm a
   cell updates. If it never refreshes, the vault `supabase_project_url` /
   `edge-function-secret` weren't rewritten — re-run migrations (see
   [rollback.md](./rollback.md) / the migrations Phase 4 note).
7. **No error spike** in Sentry / logs for the tiers you just rolled.

A pod-level pass (`kubectl -n "$NS" get pods` all Ready) is necessary but not
sufficient — a pod can be Ready and still serve a broken build. Always drive the
user flow.

## Related

- [disaster-recovery.md](./disaster-recovery.md) — backup & restore.
- [rollback.md](./rollback.md) — rolling a bad release back.
- [monitoring-alerting.md](./monitoring-alerting.md) — the alerts step 6 wires.
