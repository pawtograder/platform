# pawtograder Helm chart

Self-hosted [pawtograder](https://pawtograder.net) — bundles the Next.js web
app together with the Supabase services it depends on:

| Component     | Image                                                    | Default replicas |
| ------------- | -------------------------------------------------------- | ---------------- |
| postgres      | `supabase/postgres:17`                                   | 1 (StatefulSet)  |
| supavisor     | `supabase/supavisor`                                     | 2                |
| gotrue (auth) | `supabase/gotrue`                                        | 2                |
| postgrest     | `postgrest/postgrest`                                    | 2                |
| realtime      | `supabase/realtime` (clustered)                          | 3 (StatefulSet)  |
| storage-api   | `supabase/storage-api`                                   | 2                |
| imgproxy      | `darthsim/imgproxy`                                      | 1                |
| postgres-meta | `supabase/postgres-meta`                                 | 1                |
| studio        | `supabase/studio`                                        | 1                |
| edge-runtime  | `ghcr.io/pawtograder/edge-functions` (built per release) | 2                |
| kong          | `kong:3`                                                 | 2                |
| web (Next.js) | `ghcr.io/pawtograder/web` (built per release)            | 2                |

The chart is environment-agnostic. Cluster-specific concerns (ingress class,
storage class, node selectors, secret backend) come from a values overlay you
maintain alongside your deployment.

## Quick start (kind / single-node)

```sh
helm install pawtograder oci://ghcr.io/pawtograder/charts/pawtograder \
  --version 0.1.0 \
  --namespace pawtograder \
  --create-namespace \
  --set global.hostname=pawtograder.example.com \
  --set ingress.className=nginx \
  --set postgres.persistence.storageClass=local-path \
  --set storage.backend=s3 \
  --set storage.s3.endpoint=https://s3.example.com \
  --set storage.s3.bucket=pawtograder \
  --set secrets.create=true \
  --set secrets.values.postgres.password=$(openssl rand -base64 32) \
  --set secrets.values.postgres.pawtograderPassword=$(openssl rand -base64 32) \
  --set secrets.values.jwt.secret=$(openssl rand -base64 48) \
  --set secrets.values.jwt.anonKey=$ANON_JWT \
  --set secrets.values.jwt.serviceRoleKey=$SERVICE_JWT \
  --set secrets.values.s3.accessKey=$S3_KEY \
  --set secrets.values.s3.secretKey=$S3_SECRET
```

`secrets.create=true` is for evaluation only. Production deployments should
provision Secrets out-of-band (External Secrets Operator, sealed-secrets,
SOPS-encrypted manifests) and set `secrets.create=false`.

## Required Secrets when `secrets.create=false`

| Secret name (default)        | Required keys                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pawtograder-postgres`       | `POSTGRES_PASSWORD`, `PAWTOGRADER_PASSWORD`                                                                                                                                                                                                                  |
| `pawtograder-jwt`            | `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_PRIVATE_JWKS`, `JWT_PUBLIC_JWKS`, `JWT_REALTIME_JWKS`, `REALTIME_ENC_KEY`, `PG_META_CRYPTO_KEY`, `PGSODIUM_ROOT_KEY` (+ `SUPAVISOR_SECRET_KEY_BASE`, `SUPAVISOR_VAULT_ENC_KEY`, `SUPAVISOR_API_JWT_SECRET`, `SUPAVISOR_METRICS_JWT_SECRET` if `supavisor.enabled=true`) |
| `pawtograder-smtp`           | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (if SMTP)                                                                                                                                                                                                 |
| `pawtograder-s3`             | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (if S3 storage)                                                                                                                                                                                                 |
| `pawtograder-web`            | Optional. Mounted via envFrom into the web pod. Use this for GitHub App, Discord, Canvas, LLM credentials, etc.                                                                                                                                              |
| `pawtograder-edge-functions` | Optional. Same idea, mounted into the edge-runtime pod.                                                                                                                                                                                                      |

The full set of keys consumed from `pawtograder-jwt`:

- `JWT_SECRET` — HS256 secret used by GoTrue, PostgREST, Realtime, Kong, the
  edge runtime, and the bootstrap superuser's `app.jwt_secret` GUC. **Size
  at ≥ 48 raw bytes (≥ 64 base64 chars).** HS256 itself only needs ≥ 32
  bytes, but realtime also reuses this value as Phoenix's `secret_key_base`
  (via `realtime.yaml`), which `Plug.Crypto` requires to be ≥ 64 bytes.
  The autogenerate path uses `randomBytes(48).toString("base64")` for
  exactly this reason; the Quick-start shows `openssl rand -base64 48`.
  If you set this below 64 chars, GoTrue/PostgREST/Kong/edge run fine but
  realtime crash-loops with "secret_key_base is too short."
- `ANON_KEY`, `SERVICE_ROLE_KEY` — long-lived HS256 JWTs (`role=anon` and
  `role=service_role`) signed with `JWT_SECRET`.
- `JWT_PRIVATE_JWKS` — JSON array of private JWKs for asymmetric session
  signing (consumed by GoTrue as `GOTRUE_JWT_KEYS`).
- `JWT_PUBLIC_JWKS` — JWK Set object `{"keys":[…]}` of public material for
  PostgREST / storage-api verification.
- `JWT_REALTIME_JWKS` — EC-only JWK Set (Joken can't accept `oct` JWK maps);
  Realtime falls back to `JWT_SECRET` for HS256 verification.
- `REALTIME_ENC_KEY` — AES-128 (exactly 16 bytes) for realtime tenant
  secret encryption.
- `PG_META_CRYPTO_KEY` — AES-256 (base64) shared between postgres-meta and
  Studio for encrypting saved DB connection strings.
- `PGSODIUM_ROOT_KEY` — 32-byte hex; mounted as a file into the postgres
  pod for `pgsodium` server-secret-key initialization.
- `SUPAVISOR_*` — distinct per-purpose secrets used only when supavisor is
  enabled (Phoenix endpoint key, Vault encryption, API JWT, metrics JWT —
  each has its own length / role requirement; do not reuse one value
  across all four).

`ANON_KEY` and `SERVICE_ROLE_KEY` are JWTs signed with `JWT_SECRET`. Generate
the entire bundle (private/public/realtime JWKs, anon + service-role tokens,
realtime/pg-meta/pgsodium keys, postgres passwords) using the helper script
in `scripts/GenerateJwtKeys.ts` (or any JWT library) with claims:

### Edge-function credentials via OpenBao + ESO

`pawtograder-edge-functions` carries every external-integration secret the
edge runtime consumes — GitHub App, AWS Chime, Discord, Canvas, SIS,
SMTP, MCP/LLM, Upstash Redis, Sentry, and a `misc` catch-all. Two ways
to provision it:

1. **OpenBao + External Secrets Operator** (recommended for staging/prod).
   One operator step per integration ("bundle") per environment:

   ```sh
   # github-app bundle
   scripts/setup-openbao-edge-functions.sh \
     --env preview \
     --bundle github-app \
     --from-file .secrets/github-app-preview.env

   # aws-chime bundle (only if you use Chime in this env)
   scripts/setup-openbao-edge-functions.sh \
     --env preview \
     --bundle aws-chime \
     --from-file .secrets/aws-chime-preview.env

   # list all bundles + their documented keys
   scripts/setup-openbao-edge-functions.sh --list
   ```

   `.env` files use the literal env-var names as keys (e.g.
   `GITHUB_APP_ID=…`, `DISCORD_BOT_TOKEN=…`). All keys are optional; the
   script warns about missing documented keys and about unknown keys
   (typically a typo or wrong `--bundle`). Multi-line values like the
   GitHub App PEM use a `_FILE` suffix:

   ```sh
   GITHUB_APP_ID=123456
   GITHUB_OAUTH_CLIENT_ID=Iv1.abc
   GITHUB_PRIVATE_KEY_STRING_FILE=/abs/path/to/private-key.pem
   ```

   Then enable in chart values, listing only the bundles you've populated:

   ```yaml
   secrets:
     externalSecret:
       enabled: true
       env: preview
       bundles:
         - github-app
         - aws-chime
   ```

   The chart renders one `ExternalSecret` with a `dataFrom: extract`
   entry per bundle. ESO syncs them all into
   `pawtograder-edge-functions` with `creationPolicy: Owner`. Adding a
   new env var to an existing bundle is "edit the script's
   `BUNDLE_KEYS`, rerun the script" — no chart change.

   When `externalSecret.enabled=true` the chart's stub-generation path
   (for E2E previews) is automatically suppressed so ESO is the
   unambiguous owner.

2. **Hand-provisioned Secret** (sealed-secrets, `kubectl create`, etc.).
   Just make sure `pawtograder-edge-functions` exists in the release
   namespace with whichever env vars your deploy uses; the edge runtime
   checks every integration before use, so missing keys are tolerated.

```json
{ "iss": "supabase", "ref": "pawtograder", "role": "anon",         "iat": <now>, "exp": <far-future> }
{ "iss": "supabase", "ref": "pawtograder", "role": "service_role", "iat": <now>, "exp": <far-future> }
```

The `web` and `edge-functions` images are built by the pawtograder release
pipeline and tagged with the chart's `appVersion`. Override `web.image.tag`
and `edgeFunctions.image.tag` to pin to a different release.

## Build-time vs runtime env vars (Next.js)

`NEXT_PUBLIC_*` vars are inlined into the client bundle at build time. The
chart cannot override them. Build the web image with build-args matching the
hostname and anon key you'll deploy with:

```sh
docker build \
  --build-arg NEXT_PUBLIC_PAWTOGRADER_WEB_URL=https://staging.pawtograder.net \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://api.staging.pawtograder.net \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_JWT \
  -t ghcr.io/pawtograder/web:$VERSION .
```

## Realtime sizing

The chart sizes realtime for ~600 concurrent websocket connections out of the
box (3 pods × ~1 GiB each). Raise `realtime.replicas` to scale further; pods
discover each other through the headless Service for fan-out across the
cluster.

## Postgres replica (planned)

The current release ships a single-primary postgres. A read replica will be
added in a future minor release; for now, scale realtime/rest horizontally
and rely on supavisor to absorb connection bursts.

## Required postgres extensions

The chart uses the `supabase/postgres:17` image, which already ships every
extension pawtograder relies on (pgmq, pg_cron, pg_net, pg_graphql, pgaudit,
plpgsql, plpgsql_check, pg_tle, supautils, timescaledb). These are listed in
`postgres.sharedPreloadLibraries`; do not remove items unless you also remove
their consumers in the migration set.

## Migrations

A pre-install / pre-upgrade Helm hook runs the migrations Job, which connects
to postgres and applies `supabase/migrations/*` in order. The image must be
prebuilt with the migration files baked in; reference it via
`migrations.image`.

## Audit-table partitions

Pawtograder's `audit` table is partitioned by date and requires the
`audit_maintain_partitions()` SQL function to run periodically. The chart
ships an `auditPartitions` CronJob (default: 03:00 UTC daily) that calls it.
Disable via `auditPartitions.enabled=false` only if you handle this elsewhere.

## Values reference

See [`values.yaml`](./values.yaml) for the full set of values, organized by
component. Common knobs:

```yaml
global:
  hostname: pawtograder.example.com
  apiOnSeparateHost: true # api.<hostname> vs path-based
  nodeSelector: {} # default placement for every pod
  tolerations: []
  imagePullSecrets: []

ingress:
  enabled: true
  className: ""
  tls:
    enabled: true
    secretName: pawtograder-tls

postgres:
  persistence:
    storageClass: ""
    size: 50Gi
  resources: { ... }

realtime:
  replicas: 3
  spreadAcrossNodes: true # podAntiAffinity hint
```

## Monitoring (metrics + logs)

Gated behind `monitoring.enabled` (default `false`). When enabled, the
chart emits Prometheus Operator CRs and Grafana-discoverable ConfigMaps
that the cluster's observability stack picks up — it does **not** deploy
Prometheus or Grafana itself.

### Cluster prerequisites

- A Prometheus instance managed by `prometheus-operator` (kube-prometheus-stack
  works out of the box). Its `serviceMonitorSelector` must permit
  `ServiceMonitor` CRs in this namespace.
- Grafana with the `kiwigrid/k8s-sidecar` discovery sidecar (kps-grafana ships
  it). Dashboards are mounted from any namespace via
  `grafana_dashboard: "1"` ConfigMaps.

### What gets scraped

| Component        | Path / port              | Auth                                     |
|------------------|--------------------------|------------------------------------------|
| postgres         | `:9187 /metrics` (sidecar) | none (ClusterIP, in-pod sidecar)         |
| storage-api      | `:5000 /metrics`         | none (already exposes Prometheus format) |
| edge-functions   | `:9000 /metrics`         | none                                     |
| auth (GoTrue)    | `:9999 /metrics`         | `GOTRUE_METRICS_ENABLED=true`            |
| kong             | `:8001 /metrics` (admin) | none — admin port is ClusterIP-only      |
| realtime         | `:4000 /metrics`         | HS256 JWT in `pawtograder-jwt:REALTIME_METRICS_BEARER` |
| supavisor        | `:4000 /metrics`         | HS256 JWT in `pawtograder-jwt:SUPAVISOR_METRICS_BEARER` |
| web (Next.js)    | `:3000 /api/metrics`     | bearer in `pawtograder-jwt:METRICS_SCRAPE_TOKEN` |

The postgres exporter ships custom queries that surface pawtograder-specific
gauges (active submissions per class, help_request queue depth, total class
count, top-20 statements, table sizes). See
`templates/monitoring.yaml` for the full query set; dashboards reference
these metric names directly.

### Dashboards

Five dashboards land in the Grafana **Pawtograder** folder when
`monitoring.enabled=true`:

| UID                              | Title              | Covers                                    |
|----------------------------------|--------------------|-------------------------------------------|
| `pawtograder-stack-overview`     | Stack Overview     | pod readiness, restart-count, error rate, p95 latency |
| `pawtograder-postgres`           | Postgres Deep Dive | cache hit, replication lag, top statements, table sizes |
| `pawtograder-realtime`           | Realtime Fanout    | connection churn, broadcast rate, Erlang VM load |
| `pawtograder-edge-functions`     | Edge Functions     | per-function RPS / p95 / errors           |
| `pawtograder-app-business`       | App Business       | submissions/min, grading actions, queue depth, per-class views |

Toggle individual dashboards via `monitoring.dashboards.{stackOverview,
postgresDeepDive, realtimeFanout, edgeFunctions, appBusiness}: false` if your
platform team owns them out-of-band.

### Logs

Log collection is **cluster-level**, not chart-level — DaemonSets and
their `pods/log` RBAC are inherently cluster-scoped, so a per-PR helm
release can't install them. The pawtograder chart contributes nothing
for log shipping; instead, the cluster runs:

- One **Loki** single-binary StatefulSet at `loki.monitoring:3100`
- One **Alloy** DaemonSet across every node, scoped (by namespace regex)
  to `pawtograder-.*|monitoring`. Onboard a new app by extending the
  regex in `monitoring/alloy-config`.

Both live in `/home/jon/work/k8s/apps/monitoring/`. Querying:

```
{namespace="pawtograder-preview-pr-741"}
{namespace=~"pawtograder-.*", component="realtime"} |= "error"
{namespace="pawtograder-preview-pr-741", level="error"}
```

The Alloy pipeline best-effort parses pino-style JSON (level, msg) and
promotes `level` as a Loki label. Pod labels — `component` and
`instance` — are joined onto every line by the discovery relabel. To
get the most out of log queries from the web app, structure your
console output as JSON (e.g. pino).

### Secrets

When `monitoring.enabled=true`, these additional keys are required in
`pawtograder-jwt`:

| Key                          | Purpose                                  | Generated by      |
|------------------------------|------------------------------------------|-------------------|
| `REALTIME_METRICS_BEARER`    | Scrapes `realtime:/metrics`              | autogenerate / `GenerateJwtKeys.ts` |
| `SUPAVISOR_METRICS_BEARER`   | Scrapes `supavisor:/metrics` (if enabled)| autogenerate / `GenerateJwtKeys.ts` |
| `METRICS_SCRAPE_TOKEN`       | Scrapes `web:/api/metrics`               | autogenerate / `GenerateJwtKeys.ts` |

Both `secrets.autogenerate=true` and `scripts/GenerateJwtKeys.ts` emit
these alongside the existing key bundle.

### App-level metrics

The Next.js web app uses `prom-client`. Custom counters/histograms live in
`lib/metrics.ts` and are exposed at `/api/metrics` (Node-runtime route,
bearer-gated). Helpers:

```ts
import { timeHttp, timeRpc, getMetrics } from "@/lib/metrics";

// Wrap a route handler — observes web_http_request_duration_seconds.
export async function POST(req: NextRequest) {
  return timeHttp("/api/discord/webhook", "POST", () => handler(req));
}

// Increment business counters as events happen.
const m = await getMetrics();
m?.submissionCreated.inc({ class_id: String(classId) });
```

Default Node metrics (`process_*`, `nodejs_*`, GC, event loop lag) are
auto-collected under the `web_` prefix.

## Compatibility

- Kubernetes >= 1.27
- Helm >= 3.14
- Tested with the supabase/postgres 17.x line.

## License

GPL-3.0-only. See [LICENSE](../../LICENSE).
