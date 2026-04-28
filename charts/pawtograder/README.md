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

| Secret name (default)        | Required keys                                                |
| ---------------------------- | ------------------------------------------------------------ |
| `pawtograder-postgres`       | `POSTGRES_PASSWORD`, `PAWTOGRADER_PASSWORD`                  |
| `pawtograder-jwt`            | `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`                 |
| `pawtograder-smtp`           | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (if SMTP) |
| `pawtograder-s3`             | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (if S3 storage) |
| `pawtograder-web`            | Optional. Mounted via envFrom into the web pod. Use this for |
|                              | GitHub App, Discord, Canvas, LLM credentials, etc.           |
| `pawtograder-edge-functions` | Optional. Same idea, mounted into the edge-runtime pod.      |

`ANON_KEY` and `SERVICE_ROLE_KEY` are JWTs signed with `JWT_SECRET`. Generate
them using the helper script in `scripts/generate-jwt.ts` (or any JWT library)
with claims:

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

## Compatibility

- Kubernetes >= 1.27
- Helm >= 3.14
- Tested with the supabase/postgres 17.x line.

## License

GPL-3.0-only. See [LICENSE](../../LICENSE).
