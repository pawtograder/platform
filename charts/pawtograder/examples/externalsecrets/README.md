# Base-Secret ExternalSecret examples

The chart renders ExternalSecrets for only three of the Secrets it mounts:
`pawtograder-web` and `pawtograder-edge-functions`
(`templates/edge-functions-externalsecret.yaml`) plus `pawtograder-redis`
(`templates/redis-externalsecret.yaml`). The four **base** Secrets are not
chart-rendered, so an operator authors their ExternalSecrets out-of-band:

| Secret                 | Manifest                     | Keys the chart consumes                                                                                                                                                          |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pawtograder-jwt`      | `pawtograder-jwt.yaml`       | `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_PRIVATE_JWKS`, `JWT_PUBLIC_JWKS`, `JWT_REALTIME_JWKS`, `REALTIME_ENC_KEY`, `PG_META_CRYPTO_KEY`, `PGSODIUM_ROOT_KEY` (+ metrics tokens) |
| `pawtograder-postgres` | `pawtograder-postgres.yaml`  | `POSTGRES_PASSWORD`, `PAWTOGRADER_PASSWORD`                                                                                                                                       |
| `pawtograder-s3`       | `pawtograder-s3.yaml`        | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                                                                                                      |
| `pawtograder-smtp`     | `pawtograder-smtp.yaml`      | `SMTP_ADMIN_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`                                                                                                            |

These are standalone manifests, not chart templates. Copy them into your
deployment repo, adjust the OpenBao paths to where you escrowed the material,
then apply them into the release namespace **before** the first `helm upgrade`
so the Secrets exist when the pods start:

```bash
kubectl -n "$NS" apply -f pawtograder-jwt.yaml \
  -f pawtograder-postgres.yaml \
  -f pawtograder-s3.yaml \
  -f pawtograder-smtp.yaml
kubectl -n "$NS" get externalsecret   # every one SecretSynced=True
```

## What each key list is derived from

Every key here is what a chart template reads by name; adding a key the chart
does not consume is harmless, but a missing key breaks the pod that needs it.

- **`pawtograder-jwt`**: read across GoTrue, PostgREST, realtime, and the web
  tier (`templates/secrets.yaml` documents the full set). The manifest lists the
  nine always-required keys plus the two metrics tokens the prod template needs
  (`REALTIME_METRICS_BEARER`, `METRICS_SCRAPE_TOKEN`), because `monitoring.enabled`
  is `true`. The `SUPAVISOR_*` keys are needed only when `supavisor.enabled` is
  `true`; the prod template disables Supavisor, so they are commented out.
- **`pawtograder-postgres`**: `POSTGRES_PASSWORD` (superuser) and
  `PAWTOGRADER_PASSWORD` (app role). The streaming standby reuses
  `POSTGRES_PASSWORD` for `supabase_replication_admin`, so no separate
  replication password is required.
- **`pawtograder-s3`**: the object-store credentials the storage tier and the
  backup / verify / restore-drill Jobs use.
- **`pawtograder-smtp`**: consumed by GoTrue **and**, when listed in
  `edgeFunctions.envFromSecrets`, by the edge runtime's notification-email processor —
  which accepts this Secret's `SMTP_PASS` / `SMTP_ADMIN_EMAIL` names directly, so the same
  Secret serves both and no separate edge `smtp` bundle is required. The sender
  name is set from `auth.smtp.senderName` in values, not from this Secret.

## Structure

Each manifest maps one key per `data[]` entry from an OpenBao path under the
`apps/pawtograder/<bundle>-<env>` scheme (here `<bundle>-production`), mirroring
`templates/edge-functions-externalsecret.yaml` and
`templates/redis-externalsecret.yaml`: `secretStoreRef` names the same
`openbao` `ClusterSecretStore`, `refreshInterval` is `1h`, and the target uses
`creationPolicy: Owner`. If you escrow a whole bundle at one path with the
literal env-var names as keys, you can swap the explicit `data[]` list for a
single `dataFrom: [{ extract: { key: ... } }]`, exactly as the chart's own
ExternalSecrets do.
