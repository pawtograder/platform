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
| edge-runtime (worker tier) | same image, `edgeFunctions.workerTier` (opt-in) | 2 |
| kong          | `kong:3`                                                 | 2                |
| web (Next.js) | `ghcr.io/pawtograder/web` (built per release)            | 2                |

`edgeFunctions.workerTier` (off by default) splits the edge fleet by isolation
model: the four pg_cron-poked pgmq consumers get a second Deployment with their
own `maxParallelism`, eszip cache and memory limit, and Kong routes those
function names to it by path. (Not an "admission budget": `--max-parallelism` is
per service path rather than per pod, so it is not a per-pod cap on concurrency —
see the `maxParallelism` note in `values.yaml`.) Callers are unaffected — everything still lives at
`/functions/v1/<name>`, so there is no migration and no client change, and the
split does not exist on hosted supabase.com or under `supabase functions serve`.
See the `workerTier` block in `values.yaml` for the sizing and the reasoning.

## Upgrading to 0.4.0

Two render-time refusals are new, and both can stop a `helm upgrade` on values
that rendered fine on 0.3.x. Neither touches the cluster when it fires.

- **The edge memory budget got 510Mi stricter.** The Deno host term in
  `pawtograder.edgeFunctions.assertMemoryBudget` moved from ~90Mi (the cost at
  startup with an empty cache) to ~600Mi (the converged, load-independent
  baseline), so the required sum at chart defaults is 3160Mi rather than 2650Mi.
  An overlay with `edgeFunctions.resources.limits.memory` between those two —
  `3Gi` is the likely one — is now refused. Raise the limit; the message prints
  every term.
- **A memory limit must be a whole number of `Mi` or `Gi`.** The assertion reads
  only those two forms, and anything else used to switch the whole check off
  rather than fail. That is more than fractional `Gi`: **decimal SI** (`4G`,
  `4000M`), **bare bytes** (`4294967296`) and other binary suffixes (`4Ki`) are
  all refused too, and all of them are valid Kubernetes quantities that rendered
  fine on 0.3.x. Verified against the chart, not inferred from the regex. Spell
  the limit in whole `Mi` or `Gi` (`3584Mi`, not `3.5Gi`; `4Gi`, not `4G`).

`edgeFunctions.resources.requests.memory` also moves 512Mi to 1.5Gi in the chart
default, and to 1.8Gi in both prod overlays. Requests are what the scheduler
reserves, so re-check the edge tier's total against your node pool before
upgrading. At the chart's own defaults (`replicas: 2`, autoscaling off) that is
3Gi where it used to be 1Gi. On a fleet shaped like `values-prod.yaml`, which
sets `minReplicas: 12` / `maxReplicas: 24` at 1.8Gi, it is 21.6GiB at the floor
and 43.2GiB at the ceiling, against 6GiB and 12GiB before. `updateStrategy` is
`maxUnavailable: 0`, so a pod that cannot be scheduled stalls the rollout rather
than replacing an old one. `edgeFunctions.workerTier`, if you enable it, adds
its own 2 x 1.5Gi on top of all of that.

**Upgrading to 0.4.0 restarts the Postgres primary once**, whether or not you
enable the worker tier. The primary's pod-template `checksum/config` used to hash
the whole rendered `monitoring.yaml`; it now hashes only the postgres_exporter
custom-queries named template, which is the sole part of that file the exporter
sidecar mounts. Narrowing the hash input moves the digest once, so the first
`helm upgrade` onto 0.4.0 rolls the StatefulSet — a write outage the chart's own
notes put at ~10 min. Schedule it as a maintenance window rather than as an
ordinary `helm upgrade`.

What that one roll buys: enabling `edgeFunctions.workerTier` afterwards no longer
touches the database, and neither does any future ServiceMonitor or scrape-cadence
edit. Before the narrowing, turning the tier on widened the edge ServiceMonitor's
selector to `component In (functions, functions-workers)` and added an `edge_tier`
relabeling, neither of which matched the checksum's strip patterns, so the tier
flip alone rolled the primary. `tests/render-guardrails.sh` now pins the
invariance in both directions: the checksum must not move on the tier flip or on
a chart-version bump, and must still move on a real config edit.

If the maintenance window is genuinely unavailable, the restart can be deferred.
The chart renders no `updateStrategy` for the Postgres StatefulSet, so it runs the
Kubernetes default of `RollingUpdate`; patching it to `OnDelete` lets the new pod
template land without restarting the primary:

```bash
# BEFORE the upgrade
kubectl patch statefulset <release>-postgres -n <ns> \
  -p '{"spec":{"updateStrategy":{"type":"OnDelete"}}}'

helm upgrade ...          # new pod template is recorded; the primary keeps running

# ... LATER, in the maintenance window, and not before:
kubectl delete pod <release>-postgres-0 -n <ns>     # applies the new template
kubectl patch statefulset <release>-postgres -n <ns> \
  -p '{"spec":{"updateStrategy":{"type":"RollingUpdate"}}}'
```

**Do not restore `RollingUpdate` straight after the upgrade.** The StatefulSet
would then hold an outdated pod under a strategy whose whole job is to replace
outdated pods, and the controller does exactly that — immediately, and outside
any window. That is the restart this procedure exists to defer, so restoring the
strategy early buys nothing at all. `OnDelete` has to stay in place until the
window; the pod delete is what applies the template, and the second patch just
returns the StatefulSet to its normal mode afterwards.

Two more caveats, both load-bearing.

**First: safe only if the exporter's queries are unchanged — and not for the
reason you would guess.** Deferring the roll is safe only when the upgrade does
not change the postgres_exporter `queries.yaml` — true for 0.4.0, where the
rendered ConfigMap is byte-identical to 0.3.17 and only the *input* to the
primary's `checksum/config` narrowed, but confirm it with `helm diff` before
assuming it on any later version.

The reason is *not* that the sidecar keeps its previously mounted file. The
ConfigMap is mounted at the directory `/etc/postgres-exporter` with **no
`subPath`**, so the kubelet does refresh that file inside the live container
shortly after the ConfigMap changes. What does not refresh is the *process*:
postgres_exporter v0.18.0 reads `PG_EXPORTER_EXTEND_QUERY_PATH` once at startup
and exposes no reload flag and no `/-/reload` endpoint, so a new file is never
re-parsed. That is documented behaviour for the release the chart pins, not
something verified against the exporter's source here — but it is the premise the
`checksum/config` annotation exists on: a restart is the only way to pick up new
queries, which is why the chart hashes them into the pod template at all.

The trap that the wrong reason hides: during an `OnDelete` window,
`kubectl exec <pod> -c postgres-exporter -- cat /etc/postgres-exporter/queries.yaml`
shows the **new** file while the process is still serving the **old** parse. The
file is not evidence about what the exporter is collecting. Check for the metric
in Prometheus, not for the query in the file.

The instructive contrast is in the same pod. The **main postgres container**
mounts its config volume with a `subPath` for every entry (`postgresql.conf`,
`pg_hba.conf`, and the four init scripts), and a `subPath` mount is a one-time
copy the kubelet never updates. So for `postgresql.conf` or `pg_hba.conf` a
ConfigMap edit does not reach the running container *at all* — there is no
refreshed file to be misled by, and only the pod replacement applies it. Two
mounts in one pod, two different staleness mechanisms, one operational
conclusion: the restart is what applies config.

**Second: `OnDelete` suspends every other postgres change too.** While the
StatefulSet sits on `OnDelete`, *every* postgres
pod-template change stops rolling, not just this one: an image bump, a resource
change, a `postgresql.conf` edit all land silently and apply only on the next
pod delete. The chart does not manage `updateStrategy`, so Helm will not restore
it for you. Track it, and keep the window short. See
[incident-response.md](../../docs/operations/incident-response.md).

`autoscaling.targetMemoryUtilizationPercentage` is **unchanged** at 80: it was
already 80 in 0.3.17 (#948). What moved in 0.4.0 is the three example
overlays — `values-prod.yaml`, `values-prod-noeso.yaml` and
`values-staging.yaml` — which set it explicitly and went 100 → 80. If your own
overlay pins 100, nothing about this upgrade changes that, and you should read
the target note in `values.yaml`: 100 is a dead band of 90–110% once the HPA's
default tolerance is applied, which is what pinned prod at `maxReplicas` for
weeks.

The chart is environment-agnostic. Cluster-specific concerns (ingress class,
storage class, node selectors, secret backend) come from a values overlay you
maintain alongside your deployment.

## Quick start (kind / single-node)

The chart needs ~15 secret values in the `pawtograder-jwt` Secret —
HS256 JWT secret, anon + service-role tokens, asymmetric JWK sets,
realtime encryption key, pg-meta crypto key, pgsodium root key, plus
supavisor's four distinct secrets when supavisor is enabled. Trying to
hand-craft these via `--set` flags is error-prone. Use the helper:

```sh
# 1. Generate the full JWT bundle into a .env file
npx tsx scripts/GenerateJwtKeys.ts --env > .secrets/pawtograder-jwt.env

# 2. Create the Secret from that file (along with the postgres + S3
#    Secrets you provision however you like).
kubectl create namespace pawtograder
kubectl -n pawtograder create secret generic pawtograder-jwt \
  --from-env-file=.secrets/pawtograder-jwt.env
kubectl -n pawtograder create secret generic pawtograder-postgres \
  --from-literal=POSTGRES_PASSWORD=$(openssl rand -base64 32) \
  --from-literal=PAWTOGRADER_PASSWORD=$(openssl rand -base64 32)
kubectl -n pawtograder create secret generic pawtograder-s3 \
  --from-literal=AWS_ACCESS_KEY_ID=$S3_KEY \
  --from-literal=AWS_SECRET_ACCESS_KEY=$S3_SECRET

# 3. Install with secrets.create=false (default) — the chart reads the
#    pre-existing Secrets above.
helm install pawtograder oci://ghcr.io/pawtograder/charts/pawtograder \
  --version 0.1.0 \
  --namespace pawtograder \
  --set global.hostname=pawtograder.example.com \
  --set ingress.className=nginx \
  --set postgres.persistence.storageClass=local-path \
  --set storage.backend=s3 \
  --set storage.s3.endpoint=https://s3.example.com \
  --set storage.s3.bucket=pawtograder
```

For ephemeral previews you can flip the chart's in-cluster autogenerate
path on with `--set secrets.autogenerate=true` — a pre-install hook
mints the JWT bundle + postgres passwords + e2e tokens inside the
cluster. See `secrets-bootstrap-script.yaml` for what gets generated.
Never use autogenerate in production: keys aren't recoverable, and
upgrades that recreate the namespace lose them.

`--set secrets.create=true` plus inline `--set secrets.values.*` flags
is also supported for evaluation but expects you to hand-feed all ~15
JWT bundle values; production deployments should provision Secrets
out-of-band (External Secrets Operator, sealed-secrets, SOPS-encrypted
manifests) as shown above.

## Deploying staging

`charts/pawtograder/examples/values-staging.yaml` is the canonical
long-lived deployment overlay (durable Postgres, HA-ish stateless tier,
S3 backups, ExternalSecrets out of OpenBao). It assumes:

- A dedicated `tier: prod-staging` node pool with a matching `NoSchedule`
  taint.
- An ingress controller answering on `nginx` ingressClass with
  cert-manager wired to `letsencrypt-prod`.
- DNS records for `staging.pawtograder.net`,
  `api.staging.pawtograder.net`, and `studio.staging.pawtograder.net`
  pointing at the ingress LB.
- S3 buckets `pawtograder-staging-backups` and
  `pawtograder-staging-storage` on `s3.talos.ripley.cloud`.

### One-time: provision OpenBao + ExternalSecrets

Populate the bundles the chart's ExternalSecrets read from
(`kv/apps/pawtograder-staging/*`):

```sh
# JWT bundle (all ~15 supabase-internal tokens / keys). `bao kv put @file`
# expects JSON, so convert the dotenv output through jq first.
npx tsx scripts/GenerateJwtKeys.ts --env > /tmp/pawtograder-staging-jwt.env
jq -Rn '[inputs
  | select(test("^[^#=]+="))
  | capture("^(?<key>[^=]+)=(?<value>.*)$")
] | from_entries' /tmp/pawtograder-staging-jwt.env \
  | bao kv put kv/apps/pawtograder-staging/jwt -
rm /tmp/pawtograder-staging-jwt.env

# App integration bundles. Each command prompts for the values it expects,
# or reads from a --env-file. See the script's --list output.
scripts/setup-openbao-edge-functions.sh --bundle github-app --env staging
scripts/setup-openbao-edge-functions.sh --bundle discord    --env staging
scripts/setup-openbao-edge-functions.sh --bundle canvas     --env staging
scripts/setup-openbao-edge-functions.sh --bundle llm        --env staging
scripts/setup-openbao-edge-functions.sh --bundle sentry     --env staging
scripts/setup-openbao-edge-functions.sh --bundle e2e        --env staging

# SMTP for GoTrue mail (signup confirm / magic link / recovery). All creds,
# including SMTP_ADMIN_EMAIL (the From: address), live in this bundle —
# nothing baked into chart values. SMTP_PASS, not SMTP_PASSWORD.
bao kv put kv/apps/pawtograder-staging/smtp \
  SMTP_HOST='<smtp-host>' \
  SMTP_PORT='587' \
  SMTP_USER='<smtp-username>' \
  SMTP_PASS='<smtp-password>' \
  SMTP_ADMIN_EMAIL='noreply@staging.pawtograder.net'

# Postgres + S3 + Studio basic-auth Secrets (chart doesn't manage these)
kubectl -n pawtograder-staging create secret generic pawtograder-postgres \
  --from-literal=POSTGRES_PASSWORD=$(openssl rand -base64 32) \
  --from-literal=PAWTOGRADER_PASSWORD=$(openssl rand -base64 32)
kubectl -n pawtograder-staging create secret generic pawtograder-s3 \
  --from-literal=AWS_ACCESS_KEY_ID=$S3_KEY \
  --from-literal=AWS_SECRET_ACCESS_KEY=$S3_SECRET
htpasswd -nbB admin "$STUDIO_PASS" | kubectl -n pawtograder-staging \
  create secret generic pawtograder-studio-auth --from-file=auth=/dev/stdin
```

OAuth provider credentials (GitHub, Microsoft/Azure) ride in the
`pawtograder-web` bundle — `GITHUB_OAUTH_CLIENT_ID` /
`GITHUB_OAUTH_CLIENT_SECRET`, `AZURE_OAUTH_CLIENT_ID` /
`AZURE_OAUTH_CLIENT_SECRET`. Use `bao kv patch kv/apps/pawtograder-staging/web …`
to add them without clobbering the rest of that bundle, then flip
`auth.external.<provider>.enabled: true` in the values overlay.

Apply the ExternalSecret manifests in the namespace so ESO syncs each
OpenBao bundle into the matching K8s Secret name.

### Deploy or redeploy

```sh
scripts/redeploy-staging.sh
```

That script uninstalls any existing release, drops the Postgres PVC
(staging data is disposable), waits for the namespace to settle, then
runs `helm upgrade --install` with the values file above. Re-run any
time you want a clean slate — it's idempotent on a missing release.

## Required Secrets when `secrets.create=false`

| Secret name (default)        | Required keys                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pawtograder-postgres`       | `POSTGRES_PASSWORD`, `PAWTOGRADER_PASSWORD`                                                                                                                                                                                                                  |
| `pawtograder-jwt`            | `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_PRIVATE_JWKS`, `JWT_PUBLIC_JWKS`, `JWT_REALTIME_JWKS`, `JWT_SIGNING_JWK` (MCP/CLI only), `REALTIME_ENC_KEY`, `PG_META_CRYPTO_KEY`, `PGSODIUM_ROOT_KEY` (+ `SUPAVISOR_SECRET_KEY_BASE`, `SUPAVISOR_VAULT_ENC_KEY`, `SUPAVISOR_API_JWT_SECRET`, `SUPAVISOR_METRICS_JWT_SECRET` if `supavisor.enabled=true`) |
| `pawtograder-smtp`           | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL` (if `auth.smtp.enabled=true`; also mount into `edgeFunctions.envFromSecrets` to enable notification email)                                                                                                                                                          |
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
- `JWT_SIGNING_JWK` — **required for MCP and the CLI**, optional otherwise. The
  single EC private JWK (a bare JWK object, *not* a set) that
  `_shared/MCPAuth.ts` signs short-lived per-user RLS JWTs with, using ES256. It
  must be the **same EC entry that appears in `JWT_PRIVATE_JWKS`** — its public
  half has to be in `JWT_PUBLIC_JWKS` or PostgREST rejects every token minted
  with it.

  The edge-functions container receives it as `JWT_SECRET`, which is confusing
  but deliberate: that is the env var MCPAuth reads, and it is the *only*
  consumer of `JWT_SECRET` inside the edge runtime. It is **not** the HS256
  shared secret the rest of the stack uses — pointing it there is why MCP and
  the CLI did not work on self-hosted installs before this key existed.

  Where it comes from, by install type:

  - **`secrets.autogenerate=true`** — handled for you, including on upgrade, where
    the bootstrap Job extracts the key from the `JWT_PRIVATE_JWKS` already in the
    namespace rather than generating a new one.
  - **`secrets.create=true`** — set `secrets.values.jwt.signingJwk`.
    `GenerateJwtKeys.ts --helm-values` emits it.
  - **ESO / OpenBao** — `GenerateJwtKeys.ts` emits `JWT_SIGNING_JWK` into the JWT
    bundle, and `examples/externalsecrets/pawtograder-jwt.yaml` maps it. A bundle
    provisioned *before* this key existed does not have it: add it to the OpenBao
    path with the extraction below, then force an ESO sync.
  - **SealedSecrets / hand-made Secrets** — add it yourself with the extraction
    below (`kubeseal --merge-into` adds one key without re-sealing the rest).

  Because the `secretKeyRef` is `optional: true`, until the key is present the
  edge tier runs normally and only MCP/CLI fail. Extract it from the JWKS you
  already have:

  ```bash
  kubectl -n <ns> get secret pawtograder-jwt \
    -o jsonpath='{.data.JWT_PRIVATE_JWKS}' | base64 -d \
    | jq -c '(if type=="array" then . else .keys end)
             | map(select(.kty=="EC" and .crv=="P-256" and .d)) | .[0]'
  ```

  Then add that JSON as `JWT_SIGNING_JWK` on the same Secret and restart the
  functions Deployment. Users authenticate the CLI against
  `https://api.<hostname>/functions/v1/cli` (with `apiOnSeparateHost`, the
  default) — the app shows the exact URL for your deployment in the **user menu →
  API Tokens**, alongside the MCP server URL for Claude Desktop.
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

### Integration credentials via OpenBao + ESO

`pawtograder-web` carries Next.js / GoTrue runtime secrets (OAuth client
credentials, LTI, Discord webhook public keys, web-only LLM config).
`pawtograder-edge-functions` carries every external-integration secret the edge
runtime consumes — GitHub App, AWS Chime, Discord bot, Canvas, SIS, SMTP,
MCP/LLM, Upstash Redis, Sentry, and a `misc` catch-all. Two ways to provision
them:

1. **OpenBao + External Secrets Operator** (recommended for staging/prod).
   One operator step per integration ("bundle") per environment:

   ```sh
   # Web-app bundle (GoTrue OAuth, LTI, Discord public keys, etc.)
   scripts/setup-openbao-edge-functions.sh \
     --env production \
     --bundle web \
     --from-file .secrets/web-production.env

   # github-app bundle for edge functions
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
       env: production
       webBundles:
         - web
       edgeFunctionsBundles:
         - github-app
         - aws-chime
   ```

   The chart renders one `ExternalSecret` per target Secret. Each has a
   `dataFrom: extract` entry per bundle. ESO syncs web bundles into
   `pawtograder-web` and edge bundles into `pawtograder-edge-functions` with
   `creationPolicy: Owner`. Adding a new env var to an existing bundle is
   "edit the script's `BUNDLE_KEYS`, rerun the script" — no chart change.

   When `externalSecret.enabled=true` the chart's stub-generation path
   (for E2E previews) is automatically suppressed so ESO is the
   unambiguous owner.

2. **Hand-provisioned Secrets** (sealed-secrets, `kubectl create`, etc.).
   Just make sure `pawtograder-web` and/or `pawtograder-edge-functions` exist in
   the release namespace with whichever env vars your deploy uses. The web and
   edge pods mount those Secrets by name; optional integrations tolerate missing
   keys until their feature path is used.

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

### Source map upload (optional)

Every web bundle carries injected debug IDs, but a stack trace in Bugsink stays
minified until the matching source maps are uploaded. That upload is off unless
the build is given somewhere to send them:

```sh
docker build \
  --build-arg NEXT_PUBLIC_PAWTOGRADER_WEB_URL=https://staging.pawtograder.net \
  --build-arg NEXT_PUBLIC_BUGSINK_DSN=$BUGSINK_DSN \
  --build-arg SENTRY_URL=https://bugsink.example.edu \
  --build-arg SENTRY_PROJECT=pawtograder-web \
  --build-arg SENTRY_UPLOAD_ID=$(date +%s) \
  --secret id=sentry_auth_token,env=BUGSINK_AUTH_TOKEN \
  -t ghcr.io/pawtograder/web:$VERSION .
```

- **`sentry_auth_token`** is a BuildKit secret, never a build-arg, so it stays out
  of the image layers and `docker history`. Create it in the Bugsink UI.
- **`NEXT_PUBLIC_BUGSINK_DSN`** is what enables the bundler plugin that does the
  upload, so it is required here even though it is otherwise about runtime error
  reporting. Without it there are no reported errors to symbolicate, so a token
  without a DSN is a misconfiguration and fails the build rather than reporting an
  upload that never happens.
- **`SENTRY_URL`** — your Bugsink base URL. Required whenever the token is
  present: the bundler plugin reads a missing URL as sentry.io, so the build
  fails rather than shipping your source maps to a third party.
- **`SENTRY_PROJECT`** — Bugsink ≥ 2.2.0 rejects an upload naming a project slug
  it does not have. `SENTRY_ORG` is accepted but ignored (Bugsink is single-org).
- **`SENTRY_UPLOAD_ID`** — cache key for the layer that performs the upload.
  BuildKit deliberately leaves secret *contents* out of the build cache, so
  without a value that changes per build, a layer built before the token existed
  can be replayed afterwards and upload nothing. Any changing non-secret value
  works; in CI use the run id plus the run attempt, since re-running a run keeps
  the same run id. The build refuses a token without one.

Pass none of these and the build behaves exactly as it did before: maps are
generated, debug IDs are injected, and the upload step is skipped with
`sentry: no auth token supplied, skipping source map upload` in the log.

## Deployment skinning / branding

Self-hosted deployments can re-brand the app — service name, tagline, logos, and
accent color — **without rebuilding the web image**. Unlike the `NEXT_PUBLIC_*`
build-time vars above, branding is delivered as **plain runtime env vars** that
the app reads server-side on every request (`lib/branding.ts`) and hands to the
client via a React context. The same published `ghcr.io/pawtograder/web` image
therefore renders whatever branding the chart injects.

Configure it under `web.branding`:

```yaml
web:
  branding:
    name: "PawtograderNext" # titles, headings, wordmarks
    description: "…" # <meta name="description">
    tagline: "…" # line under the wordmark on auth screens
    logoLight: "/Logo-Light.png" # bundled path OR absolute https:// URL
    logoDark: "/Logo-Dark.png" # bundled path OR absolute https:// URL
    favicon: "/favicon.svg" # browser-tab icon; bundled path OR https:// URL
    colorPalette: "teal" # accent: gray|red|orange|yellow|green|teal|blue|cyan|purple|pink
```

Any field left blank keeps its built-in Pawtograder default. The staging overlay
([`examples/values-staging.yaml`](./examples/values-staging.yaml)) uses this to
run staging as **PawtograderNext** with a teal accent.

### Logos & favicon: bake into the image (no asset hosting)

Custom logos and the favicon can be provided two ways:

- **Absolute `https://` URL** to an externally hosted asset — logos render with a
  plain `<img>` (no `next.config` image-host allow-listing needed), and the
  favicon is set via `<link rel="icon">`.
- **Baked into the image (recommended — avoids hosting mess).** Drop your files
  into the repo's [`public/branding/`](../../public/branding/) directory before
  `docker build`; everything under `public/` is copied into the web image and
  served at `/branding/*`. Then point the values at those paths:

  ```yaml
  web:
    branding:
      name: "TartanGrader"
      logoLight: "/branding/logo-light.png"
      logoDark: "/branding/logo-dark.png"
      favicon: "/branding/favicon.png"
      colorPalette: "red"
  ```

  The same published image still re-skins per deployment from the env vars; the
  assets just need to be present inside it. A complete worked example (CMU-themed
  **TartanGrader**, with assets shipped under `public/branding/tartangrader-*`)
  lives in
  [`examples/values-tartangrader.yaml`](./examples/values-tartangrader.yaml).

The default favicon is the bundled `public/favicon.ico` (the app reads the
favicon from `web.branding.favicon` via root-layout metadata; the former
`app/favicon.ico` / `app/icon.svg` file-convention icons were moved to `public/`
so a single, override-able `<link rel="icon">` is emitted).

### Single sign-on (SSO)

The sign-in page renders one button per provider in `web.branding.ssoProviders`
(in order). Leaving it empty keeps the historical default — a single
**Continue with Microsoft (Northeastern Login)** button. Configuring SSO is a
**two-part** job: the **button** (frontend) and the **provider** (GoTrue) must
both be set up, or the button errors on click.

**1. Buttons (frontend):**

```yaml
web:
  branding:
    ssoProviders:
      - provider: google # Supabase/GoTrue OAuth provider id
        label: "Continue with Google" # button text
        icon: google # microsoft|github|google|apple|discord|gitlab|slack|twitch|linkedin|sso|generic
      - provider: azure
        label: "Continue with Microsoft"
        icon: microsoft
        scopes: "email User.Read" # optional OAuth scopes
```

Allowed `provider` values: `apple, azure, bitbucket, discord, facebook, figma,
github, gitlab, google, kakao, keycloak, linkedin_oidc, notion, slack_oidc,
spotify, twitch, workos, zoom`. The server action validates the provider and
re-reads its scopes from config (never from the client form). To show **no** SSO
buttons (email-only), set `BRAND_SSO_PROVIDERS: "[]"` via `web.extraEnv`.

**2. Provider (GoTrue):** enable each provider and supply its OAuth client
id/secret (stored in the `pawtograder-web` Secret). `github`, `azure`, and
`discord` have first-class blocks; everything else uses the generic
`auth.externalProviders` list:

```yaml
auth:
  external:
    github: { enabled: true } # reads GITHUB_OAUTH_CLIENT_ID / _SECRET
    azure: { enabled: true } # reads AZURE_OAUTH_CLIENT_ID / _SECRET
  externalProviders:
    - name: google # -> GOTRUE_EXTERNAL_GOOGLE_*
      enabled: true # reads GOOGLE_OAUTH_CLIENT_ID / _SECRET from the web Secret
    - name: keycloak
      enabled: true
      url: https://sso.example.edu/realms/main # some providers require an issuer URL
      # clientIdKey / clientSecretKey override the default <NAME>_OAUTH_CLIENT_ID/_SECRET keys
```

Each enabled provider's redirect URI defaults to the API gateway origin +
`/auth/v1/callback`. That origin depends on `global.apiOnSeparateHost`:

- **Separate API host (default, `apiOnSeparateHost: true`):**
  `https://api.<hostname>/auth/v1/callback`
- **Path-based routing (`apiOnSeparateHost: false`, API shares the web host):**
  `https://<hostname>/auth/v1/callback`

Register that exact URL in the provider's OAuth app (override per provider with
`redirectUri` if your topology differs). Put the client id/secret in the
`pawtograder-web` Secret under the `<NAME>_OAUTH_CLIENT_ID` /
`<NAME>_OAUTH_CLIENT_SECRET` keys (e.g. `GOOGLE_OAUTH_CLIENT_ID`). A complete
worked example (Google + Microsoft + GitHub) is in
[`examples/values-tartangrader.yaml`](./examples/values-tartangrader.yaml).

### Custom email templates

GoTrue's transactional emails (invite / confirmation / recovery / magic-link /
email-change) can be branded per deployment. Enable it with:

```yaml
auth:
  mailer:
    templates:
      enabled: true
```

This runs a tiny `mail-templates` sidecar in the auth pod that serves the
template HTML on `127.0.0.1`, and points GoTrue's `GOTRUE_MAILER_TEMPLATES_*`
at it. A sidecar is required because GoTrue's mailer fetches templates over
**http(s) only — there is no `file://` support**, so a bare ConfigMap mount
does not work. If a fetch ever fails, GoTrue falls back to its built-in
default template, so email delivery degrades gracefully.

Defaults are the chart-bundled files under
[`email-templates/`](./email-templates); their links route through the web
app's own `/auth/*` pages via `token_hash` (e.g.
`{{ .SiteURL }}/auth/reset-password?token_hash={{ .TokenHash }}&type=email`).
Override any body with raw HTML via `auth.mailer.templates.files.<name>`
(`invite`, `confirmation`, `recovery`, `magicLink`, `emailChange`), and set
custom subject lines via `auth.mailer.templates.subjects.<name>` (empty →
GoTrue's default subject). Bodies are Go `html/template` with GoTrue's
variables (`{{ .ConfirmationURL }}`, `{{ .TokenHash }}`, `{{ .SiteURL }}`,
`{{ .Email }}`, `{{ .NewEmail }}`, …).

## Deploying production

Start from `examples/values-prod.yaml` — it is a documented template, not a
deployable file: copy it into your deployment repo and fill in the hostname,
storage classes, S3 endpoints, alert labels, and pinned image tags. The full
gap analysis that drove the production hardening (and the items still
deferred — automatic postgres failover, per-service metrics auth) lives in
[PRODUCTION-READINESS.md](./PRODUCTION-READINESS.md).

Key mechanics:

- **`global.environment: production` arms render-time guard rails**
  (`templates/validations.yaml`): the chart refuses to render with e2e
  bypasses, `secrets.create`/`autogenerate`, `seed.enabled`,
  `migrations.resetOnDrift`, floating or unpinned image tags, an empty
  `postgres.persistence.storageClass`, unset/blank PrometheusRule labels, or
  a Studio ingress without basic-auth. Staging arms a smaller subset.
- **NetworkPolicies** (`networkPolicy.enabled=true`): default-deny ingress
  to every release pod, with allows for intra-release traffic, the ingress
  controller's namespace (→ web/kong/studio), and the monitoring namespace.
- **PDBs, zero-downtime rollouts, preStop drains, soft node-spread, and
  baseline security contexts** are chart defaults — see
  `podDisruptionBudget`, per-component `updateStrategy` /
  `terminationGracePeriodSeconds` / `spreadAcrossNodes`, and
  `global.podSecurityContext` / `global.containerSecurityContext` in
  values.yaml.
- **Backups verify themselves**: the backup CronJob dumps in `pg_dump -Fc`
  format, validates the archive TOC before AND size-checks after upload,
  and a weekly `backup-verify` CronJob re-downloads the newest object,
  re-parses its TOC, and fails if the newest backup is older than 48 h.
  Restore with `pg_restore --clean --if-exists --no-owner --no-acl -d <db> <file>`.
- **Web images are environment-specific**: `NEXT_PUBLIC_*` values (incl. the
  cluster's anon key) are baked at build time. Build prod images via
  `release-images.yml` `workflow_dispatch` with the prod hostname/namespace
  inputs before the first deploy.

## Realtime sizing

The chart sizes realtime for ~600 concurrent websocket connections out of the
box (3 pods × ~1 GiB each). Raise `realtime.replicas` to scale further; pods
discover each other through the headless Service for fan-out across the
cluster.

## Postgres standby

The chart can run an optional streaming standby (`postgres.replica`) backed by
WAL-G archiving (`postgres.walg`). It is a warm manual failover target and
read-only service, not automatic HA: promotion is operator-driven to avoid
split-brain against the shared WAL archive. See
[`docs/operations/point-in-time-recovery.md`](../../docs/operations/point-in-time-recovery.md).

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
| auth (GoTrue)    | `:9100 /metrics`         | `GOTRUE_METRICS_EXPORTER=prometheus` (separate port; `:9999` is the API) |
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

Seven dashboards land in the Grafana **Pawtograder** folder when
`monitoring.enabled=true`:

| UID                              | Title              | Covers                                    |
|----------------------------------|--------------------|-------------------------------------------|
| `pawtograder-stack-overview`     | Stack Overview     | pod readiness, restart-count, error rate, p95 latency |
| `pawtograder-postgres`           | Postgres Deep Dive | cache hit, replication lag, top statements, table sizes |
| `pawtograder-realtime`           | Realtime Fanout    | connection churn, broadcast rate, Erlang VM load |
| `pawtograder-edge-functions`     | Edge Functions     | per-function RPS / p95 / errors           |
| `pawtograder-app-business`       | App Business       | submissions/min, grading actions, queue depth, per-class views |
| `pawtograder-rate-limiting`      | Rate Limiting & Queues | GitHub Bottleneck backpressure, circuit-breaker state, async worker + dead-letter queue depths |
| `pawtograder-edge-soak`          | Edge Soak / Resilience | edge HPA scaling, per-pod memory / OOMKills, worker cancel/kill events, function errors + throughput |

Toggle individual dashboards via `monitoring.dashboards.{stackOverview,
postgresDeepDive, realtimeFanout, edgeFunctions, appBusiness, rateLimiting,
edgeSoak}: false` if your platform team owns them out-of-band.

### Logs

Log collection is **cluster-level**, not chart-level — DaemonSets and
their `pods/log` RBAC are inherently cluster-scoped, so a per-PR helm
release can't install them. The pawtograder chart contributes nothing
for log shipping; instead, the cluster runs:

- One **Loki** single-binary StatefulSet at `loki.monitoring:3100`
- One **Alloy** DaemonSet across every node, scoped (by namespace regex)
  to `pawtograder-.*|monitoring`. Onboard a new app by extending the
  regex in `monitoring/alloy-config`.

Both are deployed separately at the cluster level (the operator's
`k8s/apps/monitoring/` directory or equivalent — not in this chart).
Querying:

```logql
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
