# Production-Readiness Review & Remediation Plan

Review date: 2026-06-10. Scope: `charts/pawtograder` as deployed to staging via
`examples/values-staging.yaml` + `.github/workflows/release-images.yml`.

Status legend: ✅ fixed in this branch · 🔶 partially addressed · ⬜ deferred (tracked below)

---

## 1. Data durability

| # | Finding | Where | Status |
|---|---------|-------|--------|
| 1.1 | Postgres is a single replica with no failover (documented as deferred to v0.2) | `postgres-statefulset.yaml`, `values.yaml` ("single primary") | ⬜ deferred — see [Deferred work](#deferred-work) |
| 1.2 | No WAL archiving → recovery granularity is the last nightly dump (≤24 h data loss on disk failure) | `postgres-config.yaml` | ⬜ deferred — needs pgBackRest/WAL-G sidecar design |
| 1.3 | Backup is a plain-SQL `pg_dump \| gzip` with **no integrity verification** before or after upload | `backup.yaml` | ✅ switched to `pg_dump -Fc`, gzip/TOC verified, post-upload size check |
| 1.4 | No restore testing — a corrupt backup looks identical to a good one | — | ✅ new `backup-verify` CronJob runs `pg_restore --list` against the newest object weekly |
| 1.5 | Backup CronJob has no `activeDeadlineSeconds`/`startingDeadlineSeconds`, no failure alerting | `backup.yaml` | ✅ deadlines added; 🔶 alerting = PrometheusRule on `kube_job_status_failed` left to cluster monitoring |
| 1.6 | Retention via `mc ilm rule add … \|\| true` can fail silently | `backup.yaml` | ✅ failure is now loud (verifies an expiry rule exists) |
| 1.7 | `mc` downloaded from dl.min.io at job runtime (availability + supply-chain) | `backup.yaml` | 🔶 still downloaded (SHA-pinned); baking into the migrations image tracked below |
| 1.8 | Staging uses `local-path` (node-local) storage — node loss = data loss | `values-staging.yaml` | ⬜ accepted for staging; prod example mandates replicated storage class |
| 1.9 | No graceful shutdown for postgres (default 30 s grace, no preStop) | `postgres-statefulset.yaml` | ✅ `terminationGracePeriodSeconds: 600` |

## 2. Availability & resilience

| # | Finding | Where | Status |
|---|---------|-------|--------|
| 2.1 | Zero PodDisruptionBudgets — drains/autoscaler can evict every replica of a tier at once | all | ✅ PDBs for all multi-replica components; optional postgres PDB (default off) |
| 2.2 | No `securityContext` on any workload except smtp-relay (no runAsNonRoot, no capability drop, no seccomp) | all | ✅ values-driven pod/container securityContext helpers, conservative defaults (seccomp `RuntimeDefault`, `allowPrivilegeEscalation: false`, drop ALL); postgres exempt from drop-ALL (entrypoint needs setuid) |
| 2.3 | No preStop hooks / terminationGracePeriodSeconds — rollouts drop in-flight requests + WebSockets | all | ✅ per-component `terminationGracePeriodSeconds` + optional preStop drain sleep |
| 2.4 | kong / rest / supavisor / edge-functions have no liveness probe (wedged-but-listening never restarts) | respective templates | ✅ TCP liveness probes added |
| 2.5 | Anti-affinity only on realtime — other multi-replica tiers can stack on one node | all but `realtime.yaml` | ✅ realtime's `spreadAcrossNodes` soft anti-affinity generalized to all multi-replica components |
| 2.6 | No explicit rolling-update strategy (default allows 1 unavailable on 2-replica tiers) | all Deployments | ✅ `maxUnavailable: 0` / `maxSurge: 1` default, values-overridable |
| 2.7 | No `priorityClassName` support | all | ✅ global + per-component value |
| 2.8 | `web.workflowMetricsLeader` is an honor-system singleton flag | `web.yaml` | ✅ guarded: chart fails when leader=true with replicas>1 |
| 2.9 | No startup probes for slow-booting services | realtime, postgres | 🔶 probe thresholds tuned instead; revisit if boot-time flapping observed |

## 3. Security

| # | Finding | Where | Status |
|---|---------|-------|--------|
| 3.1 | **Zero NetworkPolicies** — anything in the namespace (or cluster, depending on CNI defaults) reaches postgres:5432, Kong admin :8001, Redis, unauthenticated metrics ports | — | ✅ `networkPolicy.enabled`: default-deny ingress + same-release allow + ingress-controller/monitoring namespace allows. Default off; on in prod example |
| 3.2 | One shared ServiceAccount, token auto-mounted into every pod | `serviceaccount.yaml` | ✅ `automountServiceAccountToken: false` on the shared SA; bootstrap job opts back in |
| 3.3 | Bootstrap RBAC allows get/create on **all** secrets in namespace | `secrets-bootstrap-rbac.yaml` | ✅ `get` restricted by `resourceNames` (create cannot be name-restricted in k8s RBAC) |
| 3.4 | Studio ingress can be enabled without basic-auth — full DB control behind an unauthenticated URL | `ingress-studio.yaml` | ✅ guard: fails render unless basic-auth enabled or explicitly waived |
| 3.5 | storage / edge-functions / GoTrue `/metrics` unauthenticated | `monitoring.yaml` | 🔶 mitigated by NetworkPolicy (3.1); per-service tokens deferred |
| 3.6 | No ingress rate limiting (nginx annotations or Kong plugin) | `ingress.yaml`, `kong-config.yaml` | 🔶 prod example ships `limit-rps`/`limit-connections` annotations; Kong-level limiting deferred |
| 3.7 | `secrets.create=true` renders plaintext secrets into helm release history | `secrets.yaml` | ✅ blocked when `global.environment` ∈ {staging, production} |
| 3.8 | Kong `storage-v1`/`functions-v1` routes carry no key-auth (matches upstream Supabase; services self-validate JWTs) | `kong-config.yaml` | ⬜ accepted — defense-in-depth key-auth tracked below |

## 4. Environment separation (staging settings that must not reach prod)

Addressed by the new **`global.environment`** value (`dev` | `preview` | `staging` | `production`,
default `dev`) and `templates/validations.tpl`, which fails a `production` render when any of
these are set:

- `web.e2e.enabled` / `edgeFunctions.e2e.enabled` / `edgeFunctions.e2e.mockGitHub` (privileged test paths)
- `secrets.create` or `secrets.autogenerate` (non-recoverable / plaintext key material)
- `migrations.resetOnDrift` (drops `public` schema — destroys all application data)
- `seed.enabled` (demo data)
- `studio.ingressEnabled` without `studio.basicAuth.enabled`
- a floating (`*-latest`) image tag on web / edge-functions / migrations

`examples/values-staging.yaml` now declares `global.environment: staging`;
new `examples/values-prod.yaml` declares `production` and documents the remaining
operator checklist (replicated storage class, prod image builds, ESO paths, redis
`internal`, SMTP, monitoring tokens).

## 5. Release / deploy pipeline (not chart-fixable; tracked)

- The web image bakes `NEXT_PUBLIC_SUPABASE_ANON_KEY` + URLs at build time and a tag push
  (`v*`) does **not** build web without a manual `workflow_dispatch` — production needs its
  own build path wired to the prod cluster's anon key (`release-images.yml`).
- No automated rollback or post-deploy smoke gate beyond `helm upgrade --wait`.
- ESO syncs have no failure alerting (`refreshInterval: 1h`, stale secrets serve silently);
  add a PrometheusRule on `externalsecret_status_condition` in cluster monitoring.
- Forward-only migrations have no documented "roll app back, leave schema forward" runbook.

## Deferred work

1. **Postgres HA** (1.1): single-primary is a deliberate v0.1 limitation. Recommended path:
   pgBackRest or WAL-G sidecar with WAL archiving to S3 first (cheap PITR, keeps
   single-primary), CloudNativePG/Patroni if real failover becomes a requirement.
2. **WAL archiving** (1.2): blocked on choosing the tool above; `postgres.config` passthrough
   already accepts `archive_mode`/`archive_command` for operators who wire their own.
3. **Bake `mc` into the migrations image** (1.7): removes the runtime download from backup,
   verify, and retention paths.
4. **Per-service metrics auth** (3.5) and **Kong rate-limiting plugin** (3.6).
5. **Defense-in-depth key-auth on Kong storage/functions routes** (3.8).
6. **Per-component ServiceAccounts** — today one SA with no API access is shared; split if
   any workload ever needs the k8s API.
7. **Prod web-image build path + post-deploy smoke test + rollback runbook** (§5).
