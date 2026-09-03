# Secrets Rotation

> ## Which deployments this applies to — read this before running anything
>
> **Every command below assumes External Secrets Operator + OpenBao.** If your
> install does not have them, `kubectl annotate externalsecret` errors on a
> resource type that is not registered, and the OpenBao paths name nothing.
>
> - **ESO-based installs:** this document, as written.
> - **SealedSecrets-based installs — including the Khoury production instance**
>   deployed from the separate `prod-charts` repo: **this document does not
>   apply.** That install sets `externalSecret.enabled=false`, so the chart
>   renders no `ExternalSecret` at all; the cluster has no such resource type,
>   only `bitnami.com/v1alpha1 SealedSecret`. Its secrets are five sealed
>   manifests in `prod-charts/secrets/` (`pawtograder-{edge-functions,jwt,postgres,smtp,web}.sealed.yaml`),
>   rotated by re-sealing with `prod-charts/scripts/seal.sh` and committing —
>   there is no live sync step to force. Names differ too: prod's S3 secret is
>   `s3-credentials`, not `pawtograder-s3`.
>
> This is **pre-existing drift, not something this document's last revision
> introduced**, and a SealedSecrets rotation procedure is its own change rather
> than a footnote here. What survives translation is everything below about
> _which consumers to restart and how disruptive each rotation is_ — that is a
> property of the chart, not of the secret store. What does not is every
> OpenBao path and every `externalsecret` command.
>
> If you are on-call against the Khoury cluster: **stop here and ask.** That is a
> better outcome than working through a procedure whose commands will error.

How to rotate Pawtograder's production secrets, and what breaks while you do. On
an ESO install, prod secrets are stored in **OpenBao** and synced into Kubernetes
Secrets by the **External Secrets Operator (ESO)**. The chart mounts them by name
and never generates them (`secrets.autogenerate` is refused in production). So
rotation is always: **change the value in OpenBao → let ESO sync → restart the
consumers.**

Provisioning scripts (the source of truth for paths and keys):

- `scripts/GenerateJwtKeys.ts`: the JWT/crypto bundle (session keys, API keys,
  service passwords, per-service encryption keys).
- `scripts/setup-openbao-edge-functions.sh`: per-integration bundles (GitHub
  App, Discord, Canvas, SMTP, Sentry, …), one KV path each so rotating one
  never touches the others.

`<env>` below is the deployment tier suffix (e.g. `production`).

---

## The general procedure

1. **Write the new value** to its OpenBao path (rerun the relevant script, or
   `bao kv patch` the one key).
2. **Force / wait for ESO sync.** ESO re-reads at `refreshInterval` (1h). To
   apply immediately, annotate the ExternalSecret to force reconciliation:
   ```bash
   kubectl -n "$NS" annotate externalsecret <name> \
     force-sync="$(date +%s)" --overwrite
   ```
   Confirm `kubectl -n "$NS" get externalsecret <name>` shows `SecretSynced`.
   The `PawtograderExternalSecretNotReady` alert
   ([monitoring-alerting.md](./monitoring-alerting.md)) fires if a sync is
   failing.
3. **Restart the consumers** so they pick up the new Secret value (a Secret
   change does not restart pods on its own):
   ```bash
   kubectl -n "$NS" rollout restart deploy/<consumer>
   ```
4. **Verify** with the relevant slice of the
   [smoke checklist](./production-install.md#smoke-test).

Which consumers to restart, and how disruptive each is, depends on the secret.

---

## Rotating by secret

### Integration credentials (low blast radius)

GitHub App, Discord, Canvas, SMTP, Sentry, SIS, Redis, MCP, **AWS Chime** — each
lives at its own bundle path (`apps/pawtograder/<bundle>-<env>`) and is mounted
into the web and/or edge-functions Secret. Rotate one without touching the
others:

1. Update the bundle path in OpenBao (rerun `setup-openbao-edge-functions.sh`
   for that bundle, or patch the single key).
2. Force ESO sync on `pawtograder-edge-functions` / `pawtograder-web`.
3. `rollout restart` the web (`<release>-web`) and edge-functions
   (`<release>-functions`) deployments — and `<release>-functions-workers` when
   `edgeFunctions.workerTier` is enabled. The worker tier mounts the same
   `envFromSecrets` set and is where several of these credentials are actually
   used (GitHub App key, Discord token, SMTP), and `envFrom` is one-shot: a pod
   that is not restarted keeps the revoked value for its whole life while every
   dashboard stays green.

Notes per integration:

- **GitHub App private key / webhook secret:** GitHub supports multiple active
  private keys — add the new one in GitHub, roll it out here, then delete the
  old one in GitHub. In-flight webhook deliveries signed with the old
  `GITHUB_WEBHOOK_SECRET` fail until the runtime has the new value, so keep the
  restart tight. See [`DEPLOYMENT.md`](../../DEPLOYMENT.md) for the GitHub App
  credential details.
- **SMTP password:** notifications and auth email pause between the provider
  change and the pod restart — rotate off-peak.
- **AWS Chime (`aws-chime`):** this bundle was missing from this document
  entirely until 2026-09-03, despite being live in prod. It holds
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_CHIME_EVENT_AUTH_TOKEN` and
  `AWS_CHIME_SQS_QUEUE_ARN` (see `setup-openbao-edge-functions.sh`), and it lands
  in the `pawtograder-edge-functions` Secret, which **both** edge tiers
  `envFrom`. So rotating it means restarting `<release>-functions` **and**
  `<release>-functions-workers` when `edgeFunctions.workerTier` is enabled —
  `envFrom` is one-shot, so a tier left unrestarted presents the revoked AWS key
  for the whole pod lifetime. Do not confuse this AWS pair with the storage/backup
  one: see the S3 section below, which is a genuinely different credential.
- **Redis (`redis.provider: shared`):** the shared `REDIS_URL` is not part of the
  web/edge bundle. It has its own OpenBao path (`apps/pawtograder/redis-production`
  in prod, set by `redis.shared.path`) and syncs into the `pawtograder-redis`
  ExternalSecret (`templates/redis-externalsecret.yaml`), which both the web and
  edge-functions deployments mount via `envFrom`. So rotate the OpenBao path,
  force ESO sync on `pawtograder-redis` (not the web/edge bundles), then
  `rollout restart` the `<release>-web`, `<release>-functions` and (when enabled)
  `<release>-functions-workers` deployments.

### Postgres passwords (`pawtograder-postgres`)

`POSTGRES_PASSWORD` (superuser) and `PAWTOGRADER_PASSWORD` (app role) are read by
Postgres _at init_ and by every service that connects. Rotating a live DB
password is not a plain secret swap — the role's password in the database must
change too, in lockstep, or every connection fails:

1. `ALTER ROLE postgres WITH PASSWORD '<new>';` (and/or `pawtograder`) in the
   DB, via a Studio SQL console or `psql` as `supabase_admin`.
2. Update the value in OpenBao and force ESO sync.
3. `rollout restart` **every** tier that connects (rest, realtime, storage,
   auth, functions, supavisor if enabled) — they cache the password in env and
   reconnect with it. The edge-functions Deployments are `<release>-functions`
   **and `<release>-functions-workers` when `edgeFunctions.workerTier` is
   enabled** — the worker tier gets `POSTGRES_PASSWORD` from the same shared
   workload template (verified against the rendered Deployment, not assumed) and
   holds it for the pod's whole life. Miss it and the four routed pgmq consumers
   keep presenting the password you just revoked: notifications, GitHub and
   Discord async work and gradebook recalculation all stop draining, while the
   request tier restarts and recovers and every dashboard goes green. This step
   named only `<release>-functions` until 2026-09-02, which was an inconsistency
   inside this document rather than a new pattern — the integration and Redis
   sections above already enumerate both.

Treat this as a brief planned outage; expect connection errors in the gap
between the `ALTER ROLE` and the restarts. Prefer to avoid it unless the
password is known-compromised.

### JWT / session keys (`pawtograder-jwt`): highest blast radius

This bundle (from `GenerateJwtKeys.ts`) signs and verifies every user session
and the long-lived API keys. Rotating it is disruptive by design:

- **Session signing key (ES256 private JWK / `JWT_PRIVATE_JWKS`):** rotating it
  invalidates in-flight sessions signed by the old key unless the old public JWK
  stays in the verifiers' JWK Set during an overlap. To rotate cleanly, add the
  new key alongside the old in `JWT_PUBLIC_JWKS` / `JWT_REALTIME_JWKS`, roll it
  out, cut GoTrue over to signing with the new `kid`, then drop the old public
  key after existing sessions expire. A hard swap (no overlap) logs everyone out.

  "Roll it out" includes **`<release>-functions-workers` when
  `edgeFunctions.workerTier` is enabled**, for the same reason the Postgres step
  does: the worker tier receives `JWT_SECRET` and `SUPABASE_ANON_KEY` from the
  shared edge workload template like the request tier. A worker left on the
  retired key keeps minting or presenting tokens PostgREST now rejects, and the
  symptom is four queues that stop draining rather than a login failure anyone
  would connect to a key rotation.

  **Rotate `JWT_SIGNING_JWK` with it.** That key is a copy of this same EC private
  JWK, held on its own because `_shared/MCPAuth.ts` needs a bare JWK rather than a
  set (it is what MCP and the CLI mint per-user RLS JWTs with, and it reaches the
  edge runtime as `JWT_SECRET`). Leave it on the old key and MCP/CLI keep minting
  tokens signed by a key you have just retired from `JWT_PUBLIC_JWKS`, so
  PostgREST rejects all of them — while the rest of the app looks healthy. The
  autogenerate bootstrap does not fix this for you: it only ever _backfills_ a
  missing key, never overwrites an existing one.

- **`ANON_KEY` / `SERVICE_ROLE_KEY` (HS256, derived from `JWT_SECRET`):** these
  are **baked into the web image at build time** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`).
  Rotating `JWT_SECRET` therefore also requires a **new web image build** with
  the new anon key, not just a Secret swap — see
  [production-install.md](./production-install.md) step 4. Plan it as a release.
- **Per-service encryption keys** (`REALTIME_ENC_KEY`, `PG_META_CRYPTO_KEY`,
  `PGSODIUM_ROOT_KEY`): these decrypt data at rest (pgsodium, saved
  connections, realtime tenant secrets). **Do not rotate `PGSODIUM_ROOT_KEY`
  casually** — data encrypted under the old key becomes unreadable. Rotate only
  with a deliberate re-encryption plan.

> **Escrow, don't regenerate.** These keys are escrowed in the secret store on
> purpose: losing them loses every session and every value encrypted under them,
> with no recovery. Production refuses `secrets.autogenerate` for exactly this
> reason. Keep an offline escrow of the JWT bundle separate from the cluster.

### S3 credentials (`secrets.names.s3`, `pawtograder-s3` by default)

Used by storage (object serving) and the backup/verify/drill CronJobs. The
Secret's name is a values knob, and it is overridden in production — Khoury's
is `s3-credentials`, so read `secrets.names.s3` rather than the default. Rotate
the key in your object store, update OpenBao, force ESO sync, `rollout restart`
storage. The next backup Job picks up the new value on its own schedule; run a
manual backup to confirm before the old key is revoked.

Neither edge tier needs a restart here, and that is a real exception rather than
the omission the Postgres step used to have. But **not** for the reason this
section gave until 2026-09-03 — it claimed the edge workload's rendered
environment "carries no S3 or AWS credentials at all", and the live prod manifest
says otherwise: `pawtograder-edge-functions`, which both edge tiers `envFrom`,
carries `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` among its 25 keys.

The distinction is **credential identity, not credential absence.** The AWS pair
in the edge environment comes from the `aws-chime` bundle and authenticates to
Chime; the pair this section rotates is `secrets.names.s3`, consumed only by
storage (via the shared S3 env helper) and the backup / verify / drill CronJobs.
Two different keys that happen to share the AWS variable names. Rotating the S3
key therefore does not touch anything either edge tier holds, so neither needs a
restart. Rotating the **Chime** key does need both — that is the `aws-chime`
entry above.

Functions do reach storage through Kong rather than the object store directly,
which is _why_ the S3 pair never had to be in their environment. That part of the
old claim was right; "no AWS credentials at all" was not.

---

## Related

- [monitoring-alerting.md](./monitoring-alerting.md) —
  `PawtograderExternalSecretNotReady` catches a sync that silently breaks.
- [disaster-recovery.md](./disaster-recovery.md) — losing the JWT/pgsodium keys
  is a data-loss event, not just an auth outage.
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md) — what each integration credential is.
