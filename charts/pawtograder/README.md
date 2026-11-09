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

Every web bundle carries injected debug IDs, but a stack trace in Sentry stays
minified until the matching source maps are uploaded. That upload is off unless
the build is given somewhere to send them:

```sh
docker build \
  --build-arg NEXT_PUBLIC_PAWTOGRADER_WEB_URL=https://staging.pawtograder.net \
  --build-arg NEXT_PUBLIC_SENTRY_DSN=$SENTRY_DSN \
  --build-arg SENTRY_URL=https://sentry.example.edu \
  --build-arg SENTRY_ORG=pawtograder \
  --build-arg SENTRY_PROJECT=pawtograder-web \
  --build-arg SENTRY_UPLOAD_ID=$(date +%s) \
  --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  -t ghcr.io/pawtograder/web:$VERSION .
```

- **`sentry_auth_token`** is a BuildKit secret, never a build-arg, so it stays out
  of the image layers and `docker history`. Create it in the Sentry UI (it needs
  `project:releases`).
- **`NEXT_PUBLIC_SENTRY_DSN`** is what enables the bundler plugin that does the
  upload, so it is required here even though it is otherwise about runtime error
  reporting. Without it there are no reported errors to symbolicate, so a token
  without a DSN is a misconfiguration and fails the build rather than reporting an
  upload that never happens.
- **`SENTRY_URL`** — your Sentry base URL. Required whenever the token is
  present: the bundler plugin reads a missing URL as sentry.io, so the build
  fails rather than shipping your source maps to a third party.
- **`SENTRY_ORG`** / **`SENTRY_PROJECT`** — the org and project slugs the maps
  and release belong to (default `pawtograder` / `pawtograder-web`).
- **`SENTRY_IS_BUGSINK=1`** — only if the target is still a Bugsink. It skips
  release create, finalize, and deploy, which Bugsink does not implement; Bugsink
  also ignores `SENTRY_ORG` and rejects an unknown `SENTRY_PROJECT`.
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
    azure:
      enabled: true # reads AZURE_OAUTH_CLIENT_ID / _SECRET
      # Optional: pin sign-in to one Entra directory. Unset, GoTrue talks to
      # login.microsoftonline.com/common and accepts an ID token from any
      # issuer — including personal Microsoft accounts.
      url: https://login.microsoftonline.com/<tenant-id>
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
`redirectUri` if your topology differs). Microsoft/Entra matches it
character-for-character and rejects a mismatch with `AADSTS50011` at the
*consent* screen — after the client id has already been accepted — so a wrong
value here looks like a working button that dead-ends on Microsoft's side. Put the client id/secret in the
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
The confirmation link also carries `redirect_to={{ .RedirectTo }}`, which sends
someone who signed up partway through a sign-in (such as an OAuth consent
request) back to it, so keep that parameter in an override.
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

**Read the chart version before you upgrade.** A patch bump (`0.3.26` →
`0.3.27`) leaves Postgres running. A minor or major bump (`0.3.x` → `0.4.0`)
is the only kind allowed to restart it. Not every one does, so check the
release's PR for the restart-gate notice before booking a maintenance window.
CI enforces the rule; see
[Chart versions and Postgres restarts](../../docs/operations/planned-maintenance.md#chart-versions-and-postgres-restarts).

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
  Both jobs stage the dump on a per-pod ephemeral PVC, sized by
  `backup.scratchSize` (30Gi default) on `backup.scratchStorageClass` — the
  dump must fit whole, since its TOC is verified locally before upload. Size
  this for your database and point it at a cheap tier; leaving it on node
  ephemeral storage is what makes a nightly backup fail part-written and put
  the whole node under DiskPressure. Point it at NETWORK storage — it falls
  back to `postgres.persistence.storageClass`, which is node-local on some
  installs. Because a retained Job keeps its pod and each pod keeps its claim,
  `backup.successfulJobsHistoryLimit` defaults to 1 (failures keep 3); turn
  both down under a namespace storage quota.
  Point `backup.image` at `ghcr.io/pawtograder/backup` (published by
  `release-images.yml` from `charts/pawtograder/images/backup/Dockerfile`) —
  supabase/postgres with a SHA-pinned `mc` baked in. Pin the tag: in
  production an empty or floating `backup.image.tag` is refused, because the
  image is only pulled on the nightly run and would otherwise fail at 04:00
  rather than at deploy time. The jobs fall back to installing `mc` at runtime
  when it isn't on PATH, but that fetch is a third-party dependency on the one
  run that has to work: it broke production on 2026-09-12 when MinIO archived
  the open-source `mc` project and `dl.min.io` began returning 410 for every
  binary. Tag it like the other Pawtograder images (release version or
  `<branch>-<sha>`), *not* with the Postgres version — `release-images.yml`
  publishes it as `backup:<version>`. What tracks `postgres.image.tag` is the
  Dockerfile's `FROM`, so `pg_dump` still matches the server it dumps.
- **Web images are environment-specific**: `NEXT_PUBLIC_*` values (incl. the
  cluster's anon key) are baked at build time. Build prod images via
  `release-images.yml` `workflow_dispatch` with the prod hostname/namespace
  inputs before the first deploy.

## Forgejo and Coder (optional)

The chart can also run [Forgejo](https://forgejo.org) (git hosting and Actions) and [Coder](https://coder.com) (Cloud Workspaces) in the release's namespace. Both are off by default; with them off, the chart renders exactly as without this section. `examples/values-forgejo-coder.yaml` turns everything on; layer it, with your hosts, on top of the environment's values file.

| Value | What it adds |
| --- | --- |
| `forgejo.enabled` | Forgejo (subchart, upstream `forgejo-helm/forgejo`) |
| `forgejo-db.enabled` | A separate Postgres for Forgejo (`groundhog2k/postgres`), Service `pawtograder-forgejo-db`; only with `forgejo.database=own` |
| `forgejoRunner.enabled` | Forgejo Actions jobs, one pod per job (`templates/forgejo-runner.yaml`) |
| `coder.enabled` | Coder (subchart, upstream `helm.coder.com/v2`), plus the post-install hook that creates its first owner and pushes `files/coder-templates/*` |
| `coder-db.enabled` | A separate Postgres for Coder, Service `pawtograder-coder-db`; only with `coder.database=own` |

`global.nodeSelector`, `tolerations`, `affinity` and `priorityClassName` apply to the chart's own new pods (the `app-databases` Job, the Coder bootstrap hook, the Actions dispatcher and job pods, and Coder workspaces through `coderBootstrap.workspaces`), but not to the subcharts. For each one that's set globally, give every enabled subchart the same key (`forgejo.<key>`, `coder.coder.<key>`, `forgejo-db.<key>`, `coder-db.<key>`) with every global node selector label and toleration in it; the render fails otherwise. Workspaces take only `nodeAffinity`; a `podAffinity` or `podAntiAffinity` that would reach them fails the render, and `coderBootstrap.workspaces.affinity` overrides the global one.

The Forgejo subchart builds its image from `global.imageRegistry`, but `forgejo.image.fullOverride` and the other subcharts and full image references don't use it. So with it set, point `forgejo.image.fullOverride` (if you set one) at a full image reference under that registry, and point `forgejo-db.image.registry`, `coder-db.image.registry`, `coder.coder.image.repo` (and the `first-owner` init container with it), `coderBootstrap.workspaces.image` and `forgejoRunner.image.repository` at that registry; the render fails otherwise. Without internet egress, also bake `code-server` into the workspace image, at the version in `coderBootstrap.workspaces.codeServerVersion` or with that value set to `""`: otherwise the template downloads that release from GitHub on a workspace's first start. coderd's provisioner also runs `terraform init` for the template's pinned providers (`coder/coder` 2.19.0, `hashicorp/kubernetes` 3.4.0), so provide a provider mirror too. For example, bake them into a Coder image under a `filesystem_mirror` and point `TF_CLI_CONFIG_FILE` in `coder.coder.env` at that CLI config. Workspace pods pull with `coderBootstrap.workspaces.imagePullSecrets`, which names Secrets in the workspace namespace.

The release must be named `pawtograder`: subchart values name `pawtograder-*` Secrets and ConfigMaps, and a render with another name fails.

The subcharts aren't committed. `Chart.lock` pins them, and `scripts/build-deps.sh` fetches them into `charts/` (gitignored). CI runs it before every helm command; run it yourself before `helm template`, `lint` or `upgrade` against a checkout, which otherwise fail with "found in Chart.yaml, but missing in charts/ directory" even with every component off. The published OCI chart already contains them. Their images (Forgejo, Coder, both Postgres servers, and the Coder workspace image in `files/coder-templates`) are pulled from `ghcr.io/pawtograder/mirror`, which `.github/workflows/mirror-third-party.yml` fills from `.github/mirror.yaml`. To change a tag, add it to `.github/mirror.yaml`, let the workflow run on `staging`, then update the value here. The subcharts come from the same mirror (`oci://ghcr.io/pawtograder/mirror/charts`). To move one to a new version, add it to `.github/mirror.yaml` first, then edit `Chart.yaml` and run `helm dependency update charts/pawtograder`.

### Databases

Each app has a `database` value. `pawtograder` (the default) uses this chart's Postgres, with the `*-db` release left off. `own` runs a separate Postgres for the app, so enable its `*-db` alongside it. Either way the app gets its own role and database, created by the `pawtograder-app-databases-<revision>` Job on every install and upgrade.

The app's own settings name the server, so that changing it rolls the app's pods: `forgejo.gitea.config.database.HOST` and the `CODER_PG_CONNECTION_URL` entry in `coder.coder.env`. The defaults point at `pawtograder-postgres:5432`. With `database: own` they become `pawtograder-forgejo-db:5432` and `postgres://coder@pawtograder-coder-db:5432/coder?sslmode=disable`, and with a non-default `service.port` they take that port. The render fails, naming the expected value, when one doesn't match its `database` mode. Switching an existing app between the two connects it to an empty database; move the data first.

**Backups don't cover Forgejo or Coder yet.** `backup.enabled` dumps only Pawtograder's database (`postgres.database`). In `database: pawtograder` mode, `postgres.walg` base backups and WAL archiving cover the `forgejo` and `coder` databases, because they're physical backups of the whole server. The `*-db` servers in `own` mode have no backup. Neither does Forgejo's repository volume, which a database dump wouldn't restore anyway. Back up the volumes, or use `forgejo dump`, until the chart does this itself.

The same physical backup ties the three databases together. A point-in-time restore of `pawtograder-postgres` for a Pawtograder incident ([`docs/operations/point-in-time-recovery.md`](../../docs/operations/point-in-time-recovery.md)) also rewinds the `forgejo` and `coder` databases to the restore target, but not what those apps keep outside Postgres. Afterwards Forgejo's database no longer matches the repositories on its volume: repositories created and pushes made after the target are on disk, while the database is missing them or describes their older state. Coder's database no longer lists workspaces created after the target, but their pods and home volumes stay in the cluster. Before restoring the shared server, stop Forgejo and Coder, and plan to reconcile them afterwards, or put them on `own` so a Pawtograder restore leaves them alone.

With `global.environment: production`, the render requires a named, replicated StorageClass for each volume these components add, as it already does for `postgres.persistence.storageClass`: `forgejo.persistence.storageClass`, `forgejo-db.storage.className`, `coder-db.storage.className` and `coderBootstrap.workspaces.storageClass`.

Sharing this chart's Postgres puts Git and Coder downtime on every Postgres restart, and their connections count against `postgres.config.max_connections`. Move to `own` if either becomes a problem.

In `pawtograder` mode the chart also puts lines at the top of `pg_hba.conf` that let the `forgejo` and `coder` roles log in only to their own database and reject them on every other database on the server, Pawtograder's included. Without them, either role's password would open a session on Pawtograder's database, because Postgres grants CONNECT to every role by default. `pg_hba.conf` is part of the primary's `checksum/config`, so an upgrade that changes which apps are in `pawtograder` mode restarts `pawtograder-postgres`, and the standby if there is one. That covers turning an app on or off and moving it between `pawtograder` and `own`. Schedule such an upgrade as a Postgres restart ([Chart versions and Postgres restarts](../../docs/operations/planned-maintenance.md#chart-versions-and-postgres-restarts)). With both apps off or both on `own`, `pg_hba.conf` is unchanged.

An app that leaves `pawtograder` mode leaves its role behind on this chart's Postgres, and the reject lines go with the mode. So while either app is on, the `app-databases` Job also runs `ALTER ROLE ... NOLOGIN` there for each app that isn't in `pawtograder` mode, whether it's on `own` or off. Moving the app back runs `ALTER ROLE ... LOGIN` again. With both apps off the Job doesn't run, so after turning off the last app, run `ALTER ROLE <app> NOLOGIN` on `pawtograder-postgres` yourself, or drop the role and its database once nothing needs them.

### Secrets

Pre-create these alongside the ones under "Required Secrets" (or sync them with ESO):

| Secret | Keys | Needed for |
| --- | --- | --- |
| `pawtograder-forgejo-admin` | `username`, `password` | Forgejo's admin account (`admin` is reserved) |
| `pawtograder-forgejo-db` | `PGPASSWORD` | Forgejo's database role |
| `pawtograder-forgejo-db-superuser` | `POSTGRES_PASSWORD` | `forgejo-db` (`forgejo.database=own` only) |
| `forgejoRunner.dispatcher.tokenSecret` (e.g. `pawtograder-forgejo-runner-token`) | `token` | The Actions dispatcher; created after Forgejo is up (see "Actions runner") |
| `forgejoRunner.actions.tokenSecret` (e.g. `pawtograder-forgejo-mirror-token`) | `token` | The action mirror hook; created after Forgejo is up (see "Action mirrors") |
| `pawtograder-coder-admin` | `email`, `username`, `password` | Coder's first owner |
| `pawtograder-coder-db` | `PGPASSWORD` | Coder's database role |
| `pawtograder-coder-db-superuser` | `POSTGRES_PASSWORD` | `coder-db` (`coder.database=own` only) |
| `pawtograder-forgejo-oauth` | `key`, `secret` | "Sign in with Pawtograder" on Forgejo; written by `scripts/setup-sso-clients.sh` |
| `pawtograder-coder-oidc` | `CODER_OIDC_CLIENT_ID`, `CODER_OIDC_CLIENT_SECRET` | "Sign in with Pawtograder" on Coder; written by `scripts/setup-sso-clients.sh` |

Keep database passwords alphanumeric; Coder's connection settings don't escape them. To rotate `pawtograder-forgejo-db` or `pawtograder-coder-db`: change the Secret, run `helm upgrade --wait --wait-for-jobs` (the `app-databases` Job sets the role's new password, and without both flags the upgrade returns before the Job finishes), then `kubectl rollout restart deployment/pawtograder-forgejo deployment/coder`. The apps read the password only at startup, and neither subchart restarts on a Secret change. Don't let Reloader restart them on the Secret alone: it would do so before the role's password changes.

With External Secrets Operator, set `forgejoCoderSecrets.externalSecret.enabled` and point `forgejoPath` / `coderPath` at one OpenBao path per app; the chart then renders ExternalSecrets for the enabled apps' admin and database Secrets. It doesn't render the `*-superuser` Secrets, which only `database: own` uses, or the runner token Secrets, which you create after Forgejo is up (see "Actions runner" and "Action mirrors"). `scripts/setup-openbao-forgejo-coder.sh --env <env> --coder-email <email>` writes both paths with generated passwords. `examples/values-staging.yaml` runs this way.

The runner image is built from `images/forgejo-runner` by `.github/workflows/release-images.yml` as `ghcr.io/pawtograder/forgejo-runner:<tag>`, with the same tags as the other images.

### Forgejo

Forgejo's public URL comes from the first `forgejo.ingress.hosts` entry: the subchart builds `ROOT_URL` from it (https when the ingress has `tls`, otherwise `gitea.config.server.PROTOCOL`, unless `gitea.config.server.ROOT_URL` is set), and the edge functions get the same URL, derived the same way, as `FORGEJO_URL`. Forgejo Actions job tokens carry `<ROOT_URL>api/actions` as their issuer; a job asks for one with `enable-openid-connect: true`. The edge functions in this release don't read `FORGEJO_URL` yet, so they still only accept GitHub's tokens: grading from Forgejo Actions needs the follow-up that teaches `validateOIDCToken` this issuer. With the runner on, bare `uses:` names (`actions/checkout@v4`) resolve against mirrors in Forgejo itself; see "Action mirrors" below. Self-registration is off; accounts are provisioned, or, if you turn it on, created on first sign-in with Pawtograder (see below).

Git is HTTPS only, since SSH is disabled for ingress-only clusters. An overlay that extends `forgejo.gitea.additionalConfigFromEnvs`, for instance with S3 credentials as in the example, has to keep the chart's `FORGEJO__DATABASE__PASSWD` and `FORGEJO__ACTIONS__DEFAULT_ACTIONS_URL` entries, and mustn't set `FORGEJO__DATABASE__HOST`, which would override `gitea.config.database.HOST`; the render fails otherwise.

### Actions runner

Every Actions job runs in a pod of its own, so it works where Docker-in-Docker isn't allowed. The runner labels (`ubuntu-latest`, `ubuntu-24.04` and `ubuntu-22.04`, all `:host`) mean the job runs directly in that pod, with the toolchain baked into `images/forgejo-runner`: JDK 21, Maven, Python 3, Node 22 and git. Build it for `linux/amd64`, push it, and set `forgejoRunner.image` (and `forgejoRunner.imagePullSecrets` if the registry needs auth; `global.imagePullSecrets` can't be used with Forgejo on). Job and dispatcher pods are pinned to `kubernetes.io/arch: <forgejoRunner.arch>` (`amd64`); change it only along with the image's platform. Forgejo must serve plain HTTP (`gitea.config.server.PROTOCOL: http`, TLS at the ingress), since the runner reaches it through its Service. Each job pod's `ephemeral-storage` limit caps everything it writes, including outside the `/data` work directory.

A dispatcher Deployment polls Forgejo for waiting jobs. For each one it registers an ephemeral runner, then starts a pod in `forgejoRunner.jobNamespace` that runs `forgejo-runner one-job` for that job alone, with that runner's token mounted from a Secret the pod owns. Forgejo deletes an ephemeral runner after its one job and won't give it a second one, and the dispatcher deletes finished pods (their Secret goes with them). Job pods are owned by the runner's ConfigMap in the job namespace, so turning `forgejoRunner` off or uninstalling deletes running jobs too, rather than leaving them running outside the runner NetworkPolicy. Nothing carries over between jobs: no shared work directory, no cache, no long-lived runner credential. Job pods get no service account token or service-link environment variables, run as uid 1000 with all capabilities dropped, and are killed after `forgejoRunner.podDeadlineSeconds`. At most `forgejoRunner.capacity` run at once.

This is the flow Forgejo 15 added ephemeral runners and `one-job --handle` for (upstream's `examples/on-demand` in the runner repo is the same loop for a single host); upstream ships no Kubernetes operator, and its Kubernetes example needs privileged Docker-in-Docker.

The dispatcher holds a Forgejo access token and a Role that can create pods and Secrets; job pods never see either. A pod can mount any Secret in its namespace, so that Role exists only in `forgejoRunner.jobNamespace`, which must be a namespace other than the release's, and the dispatcher has no Role in the release's namespace. The chart doesn't create the job namespace; create it before you enable the runner. The chart puts the job pods' ServiceAccount, Role, RoleBinding, ConfigMap and NetworkPolicy there. `forgejoRunner.imagePullSecrets` names Secrets that both the dispatcher and the job pods pull with, so create them in both namespaces.

The token lives in a Secret (key `token`) named by `forgejoRunner.dispatcher.tokenSecret`, which the render requires, so install in two steps. First install with `forgejoRunner.enabled: false` and wait for Forgejo. Then create the token and its Secret, and enable the runner:

```bash
TOKEN=$(kubectl -n "$NS" exec deploy/pawtograder-forgejo -c forgejo -- \
  forgejo admin user generate-access-token --username <user> --token-name actions-dispatcher --scopes <scope> --raw)
kubectl -n "$NS" create secret generic pawtograder-forgejo-runner-token --from-literal=token="$TOKEN"
```

With `forgejoRunner.dispatcher.orgs` empty, the dispatcher uses Forgejo's admin API and runs jobs from every repository, so `<user>` must be a site admin and `<scope>` is `write:admin`. With `orgs` set to the organizations whose jobs it should run, it registers runners in each organization instead (`/orgs/<org>/actions/runners`, which Forgejo 15 serves to the organization's owners). Then `<user>` can be an ordinary account that owns those organizations, and `<scope>` is `write:organization`; a site admin's token is never needed. Each new organization has to be added to `orgs`, with that account made an owner. The dispatcher polls the organizations in order, so a busy one listed first can use all of `forgejoRunner.capacity`.

`forgejoRunner.networkPolicy` limits job pods to DNS, Forgejo and the public internet (`privateCidrs` excluded; add exceptions under `extraEgress`), but only on a CNI that enforces NetworkPolicy. See "Isolating jobs and workspaces" below for what the render requires before it runs jobs.

### Action mirrors

Forgejo resolves a bare `uses:` name such as `actions/checkout@v4` against its `[actions] DEFAULT_ACTIONS_URL`, and every job clones its actions afresh, since the runner's cache is off and each job gets a new work directory. With `DEFAULT_ACTIONS_URL` on github.com, a GitHub outage would stop grading. So with the runner on, the chart points `DEFAULT_ACTIONS_URL` at Forgejo's own Service, `http://pawtograder-forgejo-http.<release namespace>.svc:3000`, and a post-install and post-upgrade hook, `pawtograder-forgejo-action-mirrors`, keeps a pull mirror in Forgejo of each entry in `forgejoRunner.actions.mirrors`. The defaults, `actions/checkout` and `pawtograder/assignment-action`, are all that the grade workflow below uses. A mirror keeps its upstream owner and name, because that's the path a bare name asks for: `actions/checkout` lives in an `actions` organization and `pawtograder/assignment-action` in `pawtograder`. Mirrors are public, so job pods clone them without credentials. Forgejo pulls each one from upstream every `forgejoRunner.actions.mirrorInterval` (8h), and jobs use whatever Forgejo already has, so a GitHub outage delays new upstream tags, not grading. To pick up a new tag sooner, use "Synchronize now" in the mirror's settings. The chart uses the Service rather than Forgejo's `self` value, which means the public `ROOT_URL`: job pods reach that only through the ingress, which their egress rules may not allow.

The hook creates a missing organization or mirror and leaves an existing mirror alone apart from its interval. Then, for each entry, it checks that `ref` resolves over the Service without credentials, the way a job clones it. It fails, and the install or upgrade with it, when a repository of that name exists but isn't a mirror, mirrors another `url`, is private, or lacks `ref`. It needs github.com only to create a mirror, so only an upgrade that adds one depends on GitHub being up. It authenticates with the `token` in the Secret named by `forgejoRunner.actions.tokenSecret`, which the render requires. Make the token for an account that can create organizations, or that owns `actions` and `pawtograder` if they already exist, with scopes `write:organization` and `write:repository`:

```bash
TOKEN=$(kubectl -n "$NS" exec deploy/pawtograder-forgejo -c forgejo -- \
  forgejo admin user generate-access-token --username <user> --token-name action-mirrors --scopes write:organization,write:repository --raw)
kubectl -n "$NS" create secret generic pawtograder-forgejo-mirror-token --from-literal=token="$TOKEN"
```

A bare name that isn't in the list doesn't resolve: the job fails at `git clone` with "not found". Add the action to `forgejoRunner.actions.mirrors` (with `url` when it isn't on GitHub), or write its full URL in the workflow (`uses: https://github.com/<owner>/<repo>@<ref>`), which bypasses the mirrors and depends on that host again. `forgejoRunner.actions.source: upstream` turns the mirrors off and sends bare names to `forgejoRunner.actions.upstreamURL` (`https://github.com`); with the runner off, the chart uses `upstreamURL` either way. Mirrors are the default with the runner on because nothing in a course depends on bare names reaching GitHub, and keeping grading independent of github.com is the reason to mirror at all.

Forgejo reads `DEFAULT_ACTIONS_URL` at startup from the `pawtograder-forgejo-actions` ConfigMap, through the `FORGEJO__ACTIONS__DEFAULT_ACTIONS_URL` entry in `forgejo.gitea.additionalConfigFromEnvs`. After changing `source`, `upstreamURL` or `forgejoRunner.enabled`, run `kubectl rollout restart deployment/pawtograder-forgejo`. The render fails when `forgejo.gitea.config.actions.DEFAULT_ACTIONS_URL` is set, since the env entry would override it, and when an overlay drops that entry.

### Grade workflow on Forgejo

The grade workflow lives in each course's handout repositories, not in this chart, as it does on GitHub. `examples/forgejo-grade.yml` is the Forgejo version of the stock `grade.yml` in [pawtograder/template-assignment-handout](https://github.com/pawtograder/template-assignment-handout/blob/main/.github/workflows/grade.yml). Put it at `.github/workflows/grade.yml` in the handout (template) repositories on this Forgejo, which reads `.github/workflows` when a repository has no `.forgejo/workflows`. Grading from it still needs the edge-function follow-up described under "Forgejo". It differs from the GitHub file in four ways:

- `enable-openid-connect: true`, since Forgejo ignores `permissions: id-token: write`.
- `concurrency: { cancel-in-progress: false }`. Without a `concurrency` key, a push cancels that workflow's waiting and running runs on the branch, so a student who pushes twice in a minute loses the first grading run. In the load test below, 15 of 20 runs were cancelled this way before the key was added.
- No `actions/setup-*` steps, which would download a JDK, Python or Node from GitHub on every run. The runner image already has JDK 21, Maven, Python 3 with pip, Node 22 and git; a course that needs another toolchain should have it baked into the image it runs on.
- `action_ref` and `action_repository` as literals, because the runner leaves `github.action_ref` and `github.action_repository` empty in `with:` and the action refuses empty values.

### Sizing capacity

Each job pod requests `forgejoRunner.resources.requests` (1 CPU, 2Gi) and may use up to its limits (2 CPU, 4Gi). At most `forgejoRunner.capacity` (2) run at once, and the rest wait in Forgejo's queue. Job pods are the only pods in `forgejoRunner.jobNamespace`, so that namespace's ResourceQuota is what bounds them. For each key in the quota, `floor(quota / per-job value)` jobs fit; capacity is the smallest of those. The dispatcher and the mirror hook run in the release's namespace, so they need no headroom in it. If the quota also covers other namespaces, as a per-team budget does, use the part left over for jobs. Set the result in `forgejoRunner.quota`, in the quota's own keys, and the render refuses a `capacity` that doesn't fit, naming how many do:

```yaml
forgejoRunner:
  capacity: 6 # limits.cpu, limits.memory and pods each allow 6; the requests allow 8
  quota: { requests.cpu: "8", requests.memory: 16Gi, limits.cpu: "12", limits.memory: 24Gi, pods: "6" }
```

A capacity above the quota doesn't fail jobs: the dispatcher's pod create is refused, and the job waits in Forgejo's queue while the dispatcher retries on each poll. A capacity below it leaves quota unused.

How long the queue gets depends on how long a grading job takes. The Cloud team's lab measured 35 seconds cold and 16 seconds warm for a small Java assignment, peaking at 3.4 cores, so a 2-CPU limit slows it. At a minute per job, 200 pushes spread over the last hour before a deadline are 200 job-minutes of work: at capacity 2 the last job finishes about 100 minutes after the first push, having waited about 40, while capacity 4 keeps up. `tests/forgejo-actions-load.sh --dry-run --pushes 200 --minutes 60 --job-seconds 60 --capacity 4` prints that estimate without touching anything.

To measure rather than estimate, run the load test against a sandbox install before a real deadline. It creates M private repositories in an organization, installs a workflow (a `sleep` by default, or the course's own with `--workflow`), pushes N commits round-robin over T minutes through Forgejo's API, waits for every run, and reports queue wait (run start minus run creation), job duration and peak concurrency, all from Forgejo's API:

```bash
kubectl -n "$NS" port-forward svc/pawtograder-forgejo-http 3000:3000 &
FORGEJO_TOKEN=<token with write:organization, write:repository> \
  charts/pawtograder/tests/forgejo-actions-load.sh --url http://localhost:3000 \
  --repos 50 --pushes 200 --minutes 60 --job-seconds 60 --out /tmp/load.tsv
charts/pawtograder/tests/forgejo-actions-load.sh --url http://localhost:3000 --repos 50 --cleanup
```

Against Forgejo 15.0.9 and a forgejo-runner 13.2.0 in Docker, 20 pushes to 5 repositories over one minute with 15-second jobs took 2.7 minutes at capacity 2, with a p50 queue wait of 41 seconds and a maximum of 89. At capacity 4 they took 1.5 minutes, with a maximum wait of 18 seconds. Both matched the script's estimate.

### Coder

Coder serves on `coder.coder.ingress.host`, with workspace apps on one-label subdomains of `wildcardHost`. Until a Coder deployment has its first user, anyone who reaches it can create that user and become owner. So the Coder pod's `first-owner` init container (`coder.coder.initContainers`) runs a second coderd bound to `127.0.0.1`, which nothing outside the pod can reach. It creates the owner from `pawtograder-coder-admin` before the real coderd starts, so neither the Ingress nor the Service nor the pod IP ever serves Coder without an owner. It adds a coderd startup to every Coder pod start. An overlay that sets `initContainers` must keep that entry, with the same image as `coder.coder.image`; the render fails otherwise. Set `CODER_ACCESS_URL` and `CODER_WILDCARD_ACCESS_URL` in `coder.coder.env`, keeping its `CODER_PG_CONNECTION_URL` entry; the pushed template serves VS Code on a subdomain, so the render fails without the wildcard host and URL. Without `coder.oidc.enabled`, password login is the only sign-in method: signups close after the first owner, and Coder's built-in GitHub login is turned off. `pawtograder-coder-admin` is the owner's password of record: when the bootstrap hook can't log in with it, it resets the owner's password to it (`coder reset-password`, straight against Coder's database), so change it there, not in Coder.

The hook also sets each pushed template's schedule from `coderBootstrap.schedule` with `coder templates edit`, on every install and upgrade, so a change made in Coder's UI lasts only until the next upgrade. A template that `coder templates push` creates never stops its workspaces. The chart's defaults stop a new workspace 2 hours after it starts (`defaultTTL`), and while the agent reports a connection (VS Code in the browser, `coder ssh`, port forwarding) Coder keeps moving the stop to at least 1 hour out (`activityBump`). Coder copies the template's `defaultTTL` into a workspace when it creates it, so changing the value doesn't reach existing workspaces, and without a Premium license a workspace owner can change or turn off their own workspace's autostop. A stopped workspace frees its CPU and memory but keeps its home volume, and the storage quota that volume uses. `dormancyThreshold` (mark a workspace dormant after that long without use) and `dormancyAutoDeletion` (delete a dormant workspace, home volume included, after that long) are Premium features: they're `0` (off) by default. With either set on a Coder without the license, the hook still sets `defaultTTL` and `activityBump`, then fails.

Every workspace runs code-server `coderBootstrap.workspaces.codeServerVersion` (4.143.1). On a workspace's first start, the template downloads that release into `~/.local/lib` on the home volume, unless the image's `code-server` is already that version; later starts reuse it. A changed value reaches a workspace when it moves to the newly pushed template version (`coder update`, or Update in Coder's UI), as any template change does. Set it to `""` to use whatever code-server the image ships.

A workspace works on one repository, the `repo_url` parameter (an HTTPS clone URL, fixed at creation). Its "Git Clone" startup script ([git-clone](https://registry.coder.com/modules/coder/git-clone) 2.0.4) clones it into `/home/coder/<repository name>` when that directory is missing or empty, so later starts keep the student's work and don't clone again, and VS Code opens that folder. git authenticates with the token of the Coder external auth provider `coderBootstrap.workspaces.externalAuthId` (`forgejo`), for both the clone and later pushes. The template declares that provider, so Coder refuses to create a workspace (403) until its owner has linked it; without a link, git in the workspace prints the link URL and waits. That provider's regex must match the bare origin as well as repository URLs (`^https://git\.example\.com(/.*)?$`), since git asks for credentials with the origin alone. Startup also sets git's `user.name` and `user.email` to the Coder owner's name (or username) and email. When the clone fails, the build still succeeds, but the agent's lifecycle ends in `start_error`, and the "Git Clone" script reports `exit_failure` with git's exit code and output in the agent's logs. Point `repo_url` at Forgejo's public URL: workspace pods reach the ingress controller, not the Forgejo Service.

Workspace pods (`files/coder-templates/kubernetes`) run under runc as uid 1000, without privileges or a service account token, and declare requests and limits. They are created in the release's namespace, and the Role the Coder subchart creates lets coderd manage pods, PVCs and Deployments there, Pawtograder's included. Where that matters, put workspaces in a namespace of their own: set `coderBootstrap.workspaceNamespace`, which the pushed templates use (only new workspaces move: an existing workspace keeps its home volume and its pod in the old namespace, so set this before creating workspaces, or recreate them; while workspace home volumes remain in the release's namespace, `helm upgrade` fails unless that namespace is also listed with `workspacePerms: true`, so coderd can still manage them), list it under `coder.coder.serviceAccount.workspaceNamespaces` as `{name: <namespace>, workspacePerms: true}` (the pinned Coder chart fails to render a bare string there), and set `coder.coder.serviceAccount.workspacePerms: false` so coderd keeps no Role in the release's namespace. The render fails if either is missing.

### Sign in with Pawtograder

Pawtograder can be the identity provider for Forgejo and Coder, through Supabase Auth's OAuth 2.1 server. GoTrue issues the ID tokens and sends the browser to the web app's consent page (`/oauth/consent`). By default, sign-in only reaches accounts that already exist. Account creation on first sign-in is off in both apps. With it on, anyone who can sign in to Pawtograder gets a Forgejo account, and a Coder account with workspace compute. Forgejo binds the new account to the `pawtograder` login source, and Coder gives it login type `oidc`. `examples/values-forgejo-coder.yaml` turns on sign-in and shows, commented out, the two settings that turn on account creation. `tests/e2e/forgejo-coder` runs the journeys end to end.

| Value | What it does |
| --- | --- |
| `auth.oauthServer.enabled` | GoTrue's OAuth server, and Kong routes for the OIDC endpoints that apps call without an `apikey` (discovery, JWKS, `oauth/authorize`, `oauth/token`, `oauth/userinfo`). The consent API stays behind `key-auth`. |
| `forgejo.gitea.oauth` | A `pawtograder` login source with `provider: openidConnect`, `existingSecret: pawtograder-forgejo-oauth` and `autoDiscoverUrl` set to `<api url>/auth/v1/.well-known/openid-configuration`; the render fails on any other URL. `gitea.config.oauth2_client.ENABLE_AUTO_REGISTRATION: true` creates a Forgejo account on first sign-in; leave it unset to provision accounts. |
| `coder.oidc.enabled` | `CODER_OIDC_*` in `pawtograder-coder-env`, issuer `<api url>/auth/v1`. The client ID and secret come from `pawtograder-coder-oidc`; Coder leaves OIDC off until that Secret exists. |
| `coder.oidc.allowSignups` | `CODER_OIDC_ALLOW_SIGNUPS`, `false` by default. `true` creates a Coder account, with workspace compute, on first sign-in. |

Clients are registered by an admin; dynamic registration stays off. To turn this on for a release:

1. Deploy with `auth.oauthServer.enabled: true` and `coder.oidc.enabled: true`.
2. Run `scripts/setup-sso-clients.sh --api-url <api url> --forgejo-url <forgejo url> --coder-url <coder url>`. It registers both clients, writes the two Secrets, restarts Forgejo and Coder, then revokes the release's old clients: those with this release's callback URL, or the client ID in its Secret. Clients that other releases registered on the same GoTrue are left alone. If a revoke fails, setup still finishes and the script exits non-zero. Leave out the URL of an app the release doesn't install. For an app whose URL you pass, the script fails before changing anything if that app's Deployment is missing, since the app would keep its old client. Re-running it replaces the clients: it revokes an app's old client only after that app has rolled out with the new one.
3. Deploy with `forgejo.gitea.oauth` set. Forgejo's init container needs `pawtograder-forgejo-oauth`, so it has to exist before this step.

`DISABLE_REGISTRATION: true` doesn't block account creation through this login source: Forgejo gates OAuth auto-registration only on `ENABLE_AUTO_REGISTRATION`. GoTrue requires PKCE on every authorization request. Forgejo and Coder both send it, but a Forgejo login source added with `forgejo admin auth add-oauth` against a running server sends no PKCE on its first sign-in. The subchart's init container adds the source before Forgejo starts, so this chart avoids that.

ID tokens carry `sub`, `email`, `email_verified` and `name`. Pawtograder users have no name in their auth metadata, so `name` is the email. The token has no `nickname` or `preferred_username`, so the example sets `oauth2_client.USERNAME: userid` and Forgejo names each account after the user's `sub`. `USERNAME: email` takes the part before `@`, so `alex@school-a.edu` and `alex@school-b.edu` both get `alex`; with `ACCOUNT_LINKING: disabled`, the second one's first sign-in fails with a 500. Course roles aren't in the token, so they can't map to Forgejo teams or Coder groups yet.

### NetworkPolicy

With `networkPolicy.enabled`, the chart adds the same rules for Forgejo, Coder and their `*-db` Postgres, whose subchart pods the chart's own policies don't select: ingress only from this release's pods and, for Forgejo and Coder, the ingress controller, plus `networkPolicy.monitoringNamespaceSelector` to Forgejo's HTTP port when `monitoring.enabled` and `forgejo.gitea.metrics.enabled` are both on. Job pods in `forgejoRunner.jobNamespace` may reach Forgejo's HTTP port and nothing else in the release, and Forgejo or Coder may reach this chart's Postgres when they use it. That workspace policy has `helm.sh/resource-policy: keep`. Terraform creates workspace pods, so no release object owns them, and they keep running after `coder.enabled` goes off or the release is uninstalled; the policy stays to keep them confined. Remove them with `kubectl -n <workspace namespace> delete pod -l app.kubernetes.io/name=coder-workspace --wait`. The namespace is `coderBootstrap.workspaceNamespace`, or the release's. Check that `kubectl -n <workspace namespace> get pod -l app.kubernetes.io/name=coder-workspace` lists nothing before you delete `pawtograder-apps-coder-workspaces` there. Coder workspace pods, in whichever namespace they run, take no ingress; Coder then relays their traffic over each agent's outbound connection. Their egress is limited like the Actions jobs': DNS, the ingress controller's namespace (agents connect through `CODER_ACCESS_URL`), and the internet minus `coderBootstrap.workspaces.networkPolicy.privateCidrs`. If the access URL resolves to a private address that isn't the in-cluster ingress controller, allow it under `extraEgress`. Each workspace may write `coderBootstrap.workspaces.ephemeralStorageLimit` (4Gi) outside its home volume.

### Isolating jobs and workspaces

Actions job pods and Coder workspaces run code that students write, and a workspace gives them a shell. These pods don't carry the release's labels, so the release's own NetworkPolicies don't cover them, and only their egress policies constrain them: `forgejoRunner.networkPolicy` for job pods and the workspace policy under `networkPolicy.enabled`. Those are Kubernetes NetworkPolicies, so they hold only on a CNI that enforces them and only while no other policy allows the pods more. Cilium unions the allows of every policy that selects a pod, so one cluster-wide allow undoes them. Without that limit, a job or workspace can reach every Service in the cluster, and three in this release have no authentication of their own:

- `meta` (postgres-meta) connects as `postgres`, and its `POST /query` runs any SQL, including changes to grades.
- `studio` has no login inside the cluster; its basic auth is only on the Ingress.
- With `monitoring.enabled` and `kong.metricsListener: admin`, Kong's admin API listens on `:8001`, and its `POST /config` replaces every route.

So the render refuses `forgejoRunner.enabled` or `coder.enabled` unless one of these holds:

1. `meta.enabled` and `studio.enabled` are `false`, and Kong's admin API is off (`monitoring.enabled: false`, or `kong.metricsListener: status`, which serves Kong's metrics from its read-only status API). `examples/values-forgejo-coder.yaml` does this.
2. `networkPolicy.cilium.enabled: true`, described below.
3. `networkPolicy.cniEnforcesEgress: true`, which asserts that the CNI enforces the chart's egress NetworkPolicies and that nothing else allows these pods more. The render then also requires those policies (`forgejoRunner.networkPolicy.enabled`, and `networkPolicy.enabled` for workspaces).

| Control | Enforced by | What it does |
| --- | --- | --- |
| Job pod and workspace NetworkPolicies | the CNI, if it enforces them and nothing allows more | allow DNS, Forgejo (jobs) or coderd and the ingress controller (workspaces), and the internet minus `privateCidrs` |
| `networkPolicy.cilium.enabled` | Cilium `egressDeny`, which wins over any allow | denies every pod in another namespace except kube-dns (and, for workspaces, the ingress controller's namespace), every release pod other than Forgejo's HTTP port or coderd's 8080/8443, every other pod in the job or workspace namespace, every node port but 80 and 443 (the kube-apiserver, kubelet and etcd among them), and `privateCidrs` |
| `forgejoRunner.jobNamespace` | Kubernetes RBAC | the dispatcher can create pods, and so mount Secrets, only in the job namespace |
| Job pod and workspace specs | the kubelet | no service account token, uid 1000, all capabilities dropped |
| The guard above | `helm template` / `helm upgrade` | refuses the apps while nothing above covers meta, Studio and Kong's admin API |

`networkPolicy.cilium.enabled` renders a `CiliumNetworkPolicy` named `pawtograder-forgejo-jobs-egress-deny` in the job namespace and `pawtograder-coder-workspaces-egress-deny` in the workspace namespace, modeled on `pawtograder-ci-egress-deny` in [`docs/operations/manifests/preview-isolation.yaml`](../../docs/operations/manifests/preview-isolation.yaml). Like the workspace NetworkPolicy, the workspace one has `helm.sh/resource-policy: keep`. It needs Cilium and a deploy credential that can manage `ciliumnetworkpolicies.cilium.io` in both namespaces; where only cluster admins can, apply the output of `helm template ... --show-only templates/forgejo-coder-cilium.yaml` through them instead, and keep it in step with the chart. Because a deny wins, `extraEgress` can't reopen an address inside `privateCidrs`; to let these pods reach a LAN host, take its range out of `privateCidrs`. With coder on, `networkPolicy.ingressControllerNamespaceSelector` must be `matchLabels` only, since the deny rules exempt that namespace by its labels.

To check the deny from a job pod or workspace terminal: `pawtograder-meta.<release namespace>.svc:8080`, `pawtograder-postgres.<release namespace>.svc:5432` and `kubernetes.default.svc:443` time out, while Forgejo (from a job) or coderd (from a workspace) and `api.github.com:443` connect. Repeat it with an allow-all egress NetworkPolicy added to the job or workspace namespace; the results must not change.

Ripley runs Cilium, and a probe pod there showed the runner NetworkPolicy isn't enforced. The Ripley install as configured is not safe for real students. With meta, Studio and Kong's admin API off the render accepts it, but job pods and workspaces can still reach Postgres's port, the other release pods, and whatever else on the cluster and the LAN Ripley's policies allow. Don't give it real students until the Cilium deny is in place and passes the check above.

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
| kong             | `:8001 /metrics` (admin), or `:8100 /metrics` (status) with `kong.metricsListener: status` | none. The admin API also accepts `POST /config`, which replaces Kong's routes; the status API is read-only |
| realtime         | `:4000 /metrics`         | HS256 JWT in `pawtograder-jwt:REALTIME_METRICS_BEARER` |
| supavisor        | `:4000 /metrics`         | HS256 JWT in `pawtograder-jwt:SUPAVISOR_METRICS_BEARER` |
| web (Next.js)    | `:3000 /api/metrics`     | bearer in `pawtograder-jwt:METRICS_SCRAPE_TOKEN` |
| metrics-leader   | `:3000 /api/metrics`     | same bearer (only when `web.metricsLeader.enabled`) |

### Workflow metrics and the metrics leader

The four `web_workflow_*` families behind the workflow panels on the
**App Business** dashboard are DB-derived global aggregates: every pod that
refreshes them runs the same `metrics_workflow_*` RPCs over the same rows and
exports the same values. So exactly one pod in the release may hold
`METRICS_WORKFLOW_REFRESH_LEADER`, or the queries multiply and `sum()`
over-counts. There are two ways to arrange that, and which one is right is
purely a function of `web.replicas`:

| `web.replicas` | Use | Why |
|---|---|---|
| 1 | `web.workflowMetricsLeader: true` | Free. No extra pod, no extra memory, and `templates/validations.yaml` refuses the flag above one replica so it cannot silently start double-counting. Correct for previews and small single-replica installs. **Not deprecated.** |
| > 1 | `web.metricsLeader.enabled: true` | Renders `templates/web-metrics-leader.yaml`: a dedicated 1-replica Deployment running the same web image, under component `metrics-leader`, with its own Service and ServiceMonitor. |

Setting both is refused. So is `monitoring.enabled: true` with
`web.replicas > 1` and neither — that combination ships a dashboard with nine
permanently empty panels, which reads exactly like "no workflow runs happened".
Acknowledge it deliberately with `monitoring.allowMissingWorkflowMetrics: true`
if you do not want the metrics.

Two things about the leader Deployment are structural rather than tuning:

- **`replicas` is not exposed as a value.** It is the literal `1`. A second
  replica doubles the query load on `public.workflow_runs` and double-counts
  every gauge — the precise failure the workload exists to prevent.
- **The rollout strategy is `Recreate`.** RollingUpdate would run two leaders for
  the few seconds of every deploy. A few seconds of gauge staleness is free
  against the 300s default refresh interval.

The `metrics-leader` component label is what keeps the pod off every
user-traffic path: the web Service, the Ingress backend, the web ServiceMonitor,
the `allow-ingress-controller` NetworkPolicy, the PDB, web pod anti-affinity and
the `helm test` smoke job all select `component: web` or the web Service by name.
The release-wide `allow-monitoring` NetworkPolicy does include it, so it is
scrapeable. No metric relabeling is configured, and none is needed: a prom-client
labelled gauge that was never `.set()` emits zero samples, so ordinary web pods
contribute nothing to a `sum()` over the workflow families by construction.

Independently of scrape frequency, the app throttles the actual DB refresh to
`web.metricsLeader.refreshIntervalSeconds` (rendered as
`METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS`, default 300). That is the only bound
that survives a second Prometheus, a hand-edited ServiceMonitor, or a `curl` loop
against `/api/metrics`. A failed refresh does not arm the throttle, so a database
blip is retried on the next scrape rather than backed off for five minutes.

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
