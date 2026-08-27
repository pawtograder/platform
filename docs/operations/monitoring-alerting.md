# Monitoring & Alerting

What Pawtograder alerts on in production and how the alerts are wired. This
covers the operational failure modes
[`PRODUCTION-READINESS.md`](../../charts/pawtograder/PRODUCTION-READINESS.md)
deferred to "cluster monitoring" (§1.5 backup failure, §5 ESO staleness, and
the Studio/ingress cert from the operator checklist).

For **dashboards and the metrics themselves** (what each series means, the
Grafana JSON), see [`../metrics.md`](../metrics.md) and
`charts/pawtograder/dashboards/`. This doc is only about _alerting_.

---

## How it's wired

The chart assumes the cluster already runs **kube-prometheus-stack** (the chart
deploys neither Prometheus nor Grafana). Two pieces:

- **Scrape targets:** `templates/monitoring.yaml` emits `ServiceMonitor` CRs for
  every component that exposes `/metrics`, plus the postgres_exporter sidecar.
  Auto-discovered by the cluster Prometheus. Gated on `monitoring.enabled`.
- **Alert rules:** `templates/prometheus-rules.yaml` emits a `PrometheusRule`
  with the alerts below. Gated on `monitoring.enabled` **and**
  `monitoring.prometheusRules.enabled` (default true).

> **The one thing you must set:** `monitoring.prometheusRules.labels` must match
> the cluster Prometheus's `ruleSelector`. kube-prometheus-stack's default
> selector is `release: <kps-release-name>`. If the label doesn't match, the
> Operator never loads the rules and they silently do nothing. In
> staging/production the chart **refuses to render** an enabled `PrometheusRule`
> with empty `labels` (set `monitoring.prometheusRules.allowUnselectedRules=true`
> to override if your Prometheus selects all rules). Set it in your prod values:
>
> ```yaml
> monitoring:
>   enabled: true
>   prometheusRules:
>     labels:
>       release: kube-prometheus-stack # ← your kps release name
> ```

Routing (who gets paged, which channel) is Alertmanager config. Map
`severity: critical` to a page and `severity: warning` to a chat channel per
your on-call setup — see [incident-response.md](./incident-response.md).

The chart ships an **off-by-default routing scaffold** at
`monitoring.alertmanagerConfig` (`templates/alertmanager-config.yaml`): a
prometheus-operator `AlertmanagerConfig` CR that routes by the `severity` label
(critical → `1h` repeat, warning → `12h`) with placeholder webhook receivers
reading their URLs from a Secret. It's the resource Grafana Alloy's
`mimir.alerts.kubernetes` syncs into Mimir. To use it: set
`alertmanagerConfig.enabled=true`, set `labels` to match Alloy's
`alertmanagerconfig_selector`, create the webhook Secret, and swap the
`webhookConfigs` for `slackConfigs`/`emailConfigs`/`discordConfigs`/etc. The
route tree is agnostic to which rules fire, so it covers the infra and
`pawtograder.app` alerts alike.

A selected rule is still inert if no receiver matches it, and nothing in the
chart can detect that. Before go-live, prove the path end-to-end once: fire a
test alert (e.g. `amtool alert add PawtograderRoutingTest severity=critical`
against the Alertmanager API, or temporarily lower `backupMaxAgeHours` below
the age of the last backup) and confirm a human actually gets paged.

---

## Alerts shipped by the chart

| Alert                                     | Severity | Fires when                                                                                                                       | Runbook                                                  |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `PawtograderBackupJobFailed`              | critical | The nightly pg_dump Job (only) has a recently-started failed pod for 5m                                                          | [disaster-recovery.md](./disaster-recovery.md)           |
| `PawtograderBackupMissing`                | critical | No pg_dump Job has completed in `backupMaxAgeHours` (default 36h), or the metric is absent                                       | [disaster-recovery.md](./disaster-recovery.md)           |
| `PawtograderBackupVerifyJobFailed`        | warning  | A backup-verify or restore-drill Job has a recently-started failure for 5m (recoverability in doubt)                             | [disaster-recovery.md](./disaster-recovery.md)           |
| `PawtograderWALArchiveFailing`            | critical | (`postgres.walg` on) the latest `archive_command` failed and hasn't since succeeded for 15m — pg_wal filling                     | [point-in-time-recovery.md](./point-in-time-recovery.md) |
| `PawtograderReplicaNotStreaming`          | warning  | (`postgres.replica` on) no standby in `state=streaming` for 10m — warm failover target stale                                     | [point-in-time-recovery.md](./point-in-time-recovery.md) |
| `PawtograderReplicaLagHigh`               | warning  | (`postgres.replica` on) standby replay lag exceeds `replicationLagBytesWarning` (default 100 MiB) for 15m — failover RPO growing | [point-in-time-recovery.md](./point-in-time-recovery.md) |
| `PawtograderPostgresConnectionsHigh`      | warning  | (`postgres.enabled`) backends exceed `connectionUsagePercentWarning` (default 80%) of `max_connections` for 15m                  | below                                                    |
| `PawtograderPostgresConnectionsSaturated` | critical | backends exceed `connectionUsagePercentCritical` (default 90%) of `max_connections` for 5m — new connections about to be refused | below                                                    |
| `PawtograderExternalSecretNotReady`       | warning  | An ExternalSecret's `Ready` condition is `False` for 15m                                                                         | [secrets-rotation.md](./secrets-rotation.md)             |
| `PawtograderCertificateExpiringSoon`      | warning  | A cert-manager Certificate is within `certExpiryWarningDays` (default 14) of expiry                                              | below                                                    |
| `PawtograderRecalcStalled`                | critical | gradebook row-recalculate queue > 1000 for 3m — grades going stale                                                               | below                                                    |
| `PawtograderAsyncDLQGrowing`              | critical | async dead-letter queue > 200 for 1m — jobs failing repeatedly                                                                   | below                                                    |
| `PawtograderAsyncQueueBacklog`            | critical | async worker queue > 1000 for 5m — enqueue outpacing drain                                                                       | below                                                    |
| `PawtograderAsyncQueueStuck`              | critical | async worker queue > 10 for 1h — workers stuck/starved                                                                           | below                                                    |

The last four (group `pawtograder.app`) are app-level KPI alerts, converted from
the Grafana-managed rules that run against staging, so the same thresholds now
evaluate in Prometheus/Mimir. All page (`critical`), matching the originals'
uniform routing.

Tunables live under `monitoring.prometheusRules` in `values.yaml`
(`backupMaxAgeHours`, `certExpiryWarningDays`, `replicationLagBytesWarning`).

### Why these

- **Backup** is the recovery floor for any install without WAL-G/PITR enabled
  (`postgres.walg` is optional and off by default, §1.2), so a silently failing
  backup is a data-loss risk that stays invisible until the day you need to
  restore. Two alerts because a stopped CronJob produces no _failing_ Job to
  catch (`PawtograderBackupMissing` covers that). When `postgres.walg` is on, the
  separate `PawtograderWALArchiveFailing` alert covers a stalled WAL archive
  (pg_wal filling the primary's volume).
- **Postgres connections** because the budget is `postgres.config.max_connections`
  (default 400), shared by the PostgREST pools (`rest.dbPool` × replicas),
  supavisor, GoTrue, realtime, storage, and the exporter. As client backends approach
  `max_connections`, new connections are refused and every tier returns 5xx errors at once, so the
  warning fires with headroom (80%) and the critical close to the limit (90%).
  Remediation: find idle-in-transaction backends, trim the pools, or raise
  `max_connections` with matching memory headroom.
- **ExternalSecret** staleness is invisible by design: ESO serves the last-good
  value on a sync failure and only re-reads at `refreshInterval` (1h). A broken
  OpenBao path surfaces as a crash-looping pod at the _next_ restart, long after
  the store actually broke — the alert catches it at break time.
- **Cert expiry** because a lapsed Studio/ingress cert takes the app offline and
  cert-manager renewal can fail quietly (DNS-01 solver, issuer trouble).

### Dependencies

Each alert's expression depends on an exporter being present in the cluster:

- backup alerts → `kube-state-metrics` (`kube_job_status_*`).
- WAL-G alert → the chart's own `postgres_exporter` custom query
  (`pawtograder_wal_archiving_*`, defined in `templates/monitoring.yaml`).
- Postgres connection alerts → the chart's own `postgres_exporter` custom query
  (`pawtograder_db_connections_*`, defined in `templates/monitoring.yaml`).
- replication alerts → the chart's own `postgres_exporter` custom query
  (`pawtograder_replication_*`, defined in `templates/monitoring.yaml`; read from
  the **primary's** `pg_stat_replication`, not `pg_replication_slots`).
- vacuum health and RAM/buffer-cache dashboards
  (`docs/grafana-dashboard-vacuum-health.json`) → the chart's own
  `postgres_exporter` custom queries `pawtograder_vacuum_alert`,
  `pawtograder_db_buffer_cache_bytes`,
  `pawtograder_db_buffer_cache_total_used_bytes` and
  `pawtograder_db_dead_tuples` (all in `templates/monitoring.yaml`). These used
  to come from the `metrics` edge function, which meant Prometheus called
  `database_ram_metrics()` and `vacuum_health_check()` once per functions pod —
  32 replicas in prod, ~1.07 calls/sec, and **77.7% of all database execution
  time**, almost all of it `pg_buffercache` scans (524,288 buffer descriptors
  per call at `shared_buffers = 4GB`). They are global database state, so the
  exporter — scraped once — is the right home. Metric and label names did not
  change. The buffer-cache queries carry `cache_seconds: 300`, so the scan runs
  at most once per 5 minutes even from that one target.
- exporter self-health alerts (`PawtograderPostgresExporterQueryFailing`,
  `PawtograderPostgresExporterDown`) → `pg_exporter_last_scrape_error`, which
  postgres_exporter emits on every scrape. These exist because a failing custom
  query is **silently dropped** from `/metrics` rather than failing the scrape,
  and the vacuum dashboard's `OR vector(0)` then renders the missing series as
  zero alerts — i.e. green. `absent()` is deliberately on this gauge and not on
  the `pawtograder_db_*` families, which are legitimately empty on a healthy
  database (dead-tuple and buffer-cache queries have >100-tuple and >1 MiB floors).
- ESO alert → the External Secrets Operator's `/metrics`
  (`externalsecret_status_condition`).
- cert alert → cert-manager's `/metrics`
  (`certmanager_certificate_expiration_timestamp_seconds`).
- app KPI alerts (`pawtograder.app`) → the **`metrics` edge function**
  (`pawtograder_async_queue_size`, `pawtograder_async_dlq_size`,
  `pawtograder_gradebook_row_recalculate_queue_size`). These are **not**
  postgres_exporter series — they are served at `/metrics` on the edge-functions
  service and scraped by the `edge-functions` ServiceMonitor. That endpoint is
  gated by a `Bearer` token **only when `METRICS_TOKEN` is set** (the function
  serves open `/metrics` otherwise); the ServiceMonitor sends the token from the
  edge-functions Secret with `optional: true`, so an install without the token
  still scrapes. If you set `METRICS_TOKEN` but the ServiceMonitor can't read it,
  the target 401s and the whole `pawtograder.app` group goes dark.

If an exporter is absent, that series is simply missing and the alert never
fires (it does not error). Confirm the series exist in your Prometheus before
relying on the alert.

> **Scrape-target gotcha (fixed):** the postgres*exporter's
> `pg_stat_statements_top` custom query is aggregated by `queryid`.
> `pg_stat_statements` holds one row per `(userid, dbid, toplevel, queryid)`, so
> selecting `queryid` + query text directly produced duplicate `(queryid,
query_preview)` label sets whenever a statement ran under more than one
> role/db — which made the exporter's client library return **HTTP 500 for the
> entire `/metrics` endpoint**, taking down \_all* postgres metrics (the target
> read "down"). Summing per `queryid` keeps each series unique. If you add custom
> queries, ensure their label sets are unique or you will re-break the endpoint.

> **Every custom query sets `master: true`.** The exporter sidecar runs with
> `PG_EXPORTER_AUTO_DISCOVER_DATABASES=true`, so without that flag a block runs
> once per discovered database. Every query in `templates/monitoring.yaml` is
> either cluster-wide (`pg_stat_statements`, `pg_buffercache`, `pg_settings`,
> `pg_stat_replication`) or specific to the application database
> (`public.classes`, `public.submissions`, `public.help_requests`, the
> `pawtograder_*` functions), so per-database execution is wrong in all of them.
> Whether auto-discovery bites depends on the Postgres image. Its query is
> `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND datname != current_database()`.
> On the **currently deployed** supabase/postgres 17.4.x there is nothing to
> find — the only databases are `postgres`, `template0` and `template1`, and
> templates are excluded — so these blocks only ever run against the application
> database and are **latent**. Confirmed on the live prod exporter:
> `pg_exporter_last_scrape_error` is 0 and there is exactly one `server` label
> value (`127.0.0.1:5432`) across the whole scrape. On **17.6.x and later**
> Supabase adds `_supabase` and `storage_vectors` (verified against 17.6.1.132),
> and then `pg_stat_statements`, `public.classes`, `public.submissions` and
> `public.help_requests` would raise "relation does not exist" once per
> discovered database on every scrape, while `pawtograder_table_sizes` would run
> against the wrong databases. So `master: true` is a **prerequisite for the next
> Postgres image bump**, not a fix for a present failure. It also guards
> something worse than log noise: the `server` label is only `host:port`
> (`parseFingerprint(dsn)`, no database name), so databases on one instance are
> indistinguishable by label — the first time one of these queries returns a row
> from a second database, the result is a genuinely **duplicate** label set and
> the same HTTP 500 failure mode as the gotcha above, not merely a mis-ranked
> `topk`. A new block needs `master: true` unless it truly means something
> different per database; `charts/pawtograder/tests/render-guardrails.sh` asserts
> this and requires an explicit `ALLOW_NO_MASTER` entry for any exception.

---

## Verifying alerts are live

After install (see [production-install.md](./production-install.md)):

1. **Rules loaded.** In Prometheus → Status → Rules, the `pawtograder.backup`,
   `pawtograder.secrets`, `pawtograder.certs`, and `pawtograder.app` groups
   appear, plus `pawtograder.walg` when `postgres.walg` is enabled,
   `pawtograder.postgres` when `postgres` is deployed, and
   `pawtograder.replication` when `postgres.replica` is enabled with a running
   standby (`replica.replicas` > 0). If they don't, the
   `prometheusRules.labels` selector doesn't match — fix it first.
2. **Series exist.** Query each metric above in Prometheus and confirm it
   returns data for the release namespace.
3. **Fire a test.** Delete a synced Secret (or point an ExternalSecret at a bad
   path in a scratch namespace) and confirm the alert transitions to firing and
   routes to the expected channel. Revert.

## Suggested additions (not shipped)

Track in your cluster monitoring, out of scope for the chart today:

- Postgres disk near full. (Connection-budget saturation is now shipped — see
  `PawtograderPostgresConnections*` — and standby streaming/replay lag is now
  shipped from `pg_stat_replication` — see `PawtograderReplica*` — both in the
  alert table above.)
- Web/edge error-rate and latency SLOs off the app `/api/metrics` series.
- Realtime WebSocket connection churn.
