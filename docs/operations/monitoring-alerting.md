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

Routing (who gets paged, which channel) is Alertmanager config and lives with
the cluster monitoring stack, not this chart. Map `severity: critical` to a page
and `severity: warning` to a chat channel per your on-call setup — see
[incident-response.md](./incident-response.md).

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
| `PawtograderPostgresConnectionsHigh`      | warning  | (`postgres.enabled`) backends exceed `connectionUsagePercentWarning` (default 80%) of `max_connections` for 15m                  | [incident-response.md](./incident-response.md)           |
| `PawtograderPostgresConnectionsSaturated` | critical | backends exceed `connectionUsagePercentCritical` (default 90%) of `max_connections` for 5m — new connections about to be refused | [incident-response.md](./incident-response.md)           |
| `PawtograderExternalSecretNotReady`       | warning  | An ExternalSecret's `Ready` condition is `False` for 15m                                                                         | [secrets-rotation.md](./secrets-rotation.md)             |
| `PawtograderCertificateExpiringSoon`      | warning  | A cert-manager Certificate is within `certExpiryWarningDays` (default 14) of expiry                                              | below                                                    |

Tunables live under `monitoring.prometheusRules` in `values.yaml`
(`backupMaxAgeHours`, `certExpiryWarningDays`).

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
  supavisor, GoTrue, realtime, storage, and the exporter. As backends approach
  the ceiling, new connections are refused and every tier 5xxes at once, so the
  warning fires with headroom (80%) and the critical close to the wall (90%).
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
- ESO alert → the External Secrets Operator's `/metrics`
  (`externalsecret_status_condition`).
- cert alert → cert-manager's `/metrics`
  (`certmanager_certificate_expiration_timestamp_seconds`).

If an exporter is absent, that series is simply missing and the alert never
fires (it does not error). Confirm the series exist in your Prometheus before
relying on the alert.

---

## Verifying alerts are live

After install (see [production-install.md](./production-install.md)):

1. **Rules loaded.** In Prometheus → Status → Rules, the `pawtograder.backup`,
   `pawtograder.secrets`, and `pawtograder.certs` groups appear, plus
   `pawtograder.walg` when `postgres.walg` is enabled and `pawtograder.postgres`
   when `postgres` is deployed. If they don't, the `prometheusRules.labels`
   selector doesn't match — fix it first.
2. **Series exist.** Query each metric above in Prometheus and confirm it
   returns data for the release namespace.
3. **Fire a test.** Delete a synced Secret (or point an ExternalSecret at a bad
   path in a scratch namespace) and confirm the alert transitions to firing and
   routes to the expected channel. Revert.

## Suggested additions (not shipped)

Track in your cluster monitoring, out of scope for the chart today:

- Postgres disk near full, and replication slot lag from the
  `pg_replication_slots` custom query. (Connection-budget saturation is now
  shipped — see `PawtograderPostgresConnections*` in the alert table above.)
- Web/edge error-rate and latency SLOs off the app `/api/metrics` series.
- Realtime WebSocket connection churn.
