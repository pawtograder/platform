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
> Operator never loads the rules and they silently do nothing. Set it in your
> prod values:
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

---

## Alerts shipped by the chart

| Alert                                | Severity | Fires when                                                                                    | Runbook                                        |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `PawtograderBackupJobFailed`         | critical | A `*backup*` Job in the namespace has failed pods (`kube_job_status_failed > 0`) for 5m       | [disaster-recovery.md](./disaster-recovery.md) |
| `PawtograderBackupMissing`           | critical | No `*backup*` Job has completed in `backupMaxAgeHours` (default 36h), or the metric is absent | [disaster-recovery.md](./disaster-recovery.md) |
| `PawtograderExternalSecretNotReady`  | warning  | An ExternalSecret's `Ready` condition is `False` for 15m                                      | [secrets-rotation.md](./secrets-rotation.md)   |
| `PawtograderCertificateExpiringSoon` | warning  | A cert-manager Certificate is within `certExpiryWarningDays` (default 14) of expiry           | below                                          |

Tunables live under `monitoring.prometheusRules` in `values.yaml`
(`backupMaxAgeHours`, `certExpiryWarningDays`).

### Why these three

- **Backup** is the entire recovery floor (there is no WAL/PITR, §1.1/§1.2), so
  a silently failing backup is a data-loss risk that stays invisible until the
  day you need to restore. Two alerts because a stopped CronJob produces no
  _failing_ Job to catch (`PawtograderBackupMissing` covers that).
- **ExternalSecret** staleness is invisible by design: ESO serves the last-good
  value on a sync failure and only re-reads at `refreshInterval` (1h). A broken
  OpenBao path surfaces as a crash-looping pod at the _next_ restart, long after
  the store actually broke — the alert catches it at break time.
- **Cert expiry** because a lapsed Studio/ingress cert takes the app offline and
  cert-manager renewal can fail quietly (DNS-01 solver, issuer trouble).

### Dependencies

Each alert's expression depends on an exporter being present in the cluster:

- backup alerts → `kube-state-metrics` (`kube_job_status_*`).
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
   `pawtograder.secrets`, and `pawtograder.certs` groups appear. If they don't,
   the `prometheusRules.labels` selector doesn't match — fix it first.
2. **Series exist.** Query each metric above in Prometheus and confirm it
   returns data for the release namespace.
3. **Fire a test.** Delete a synced Secret (or point an ExternalSecret at a bad
   path in a scratch namespace) and confirm the alert transitions to firing and
   routes to the expected channel. Revert.

## Suggested additions (not shipped)

Track in your cluster monitoring, out of scope for the chart today:

- Postgres saturation (connections near `max_connections`, disk near full,
  replication slot lag from the `pg_replication_slots` custom query).
- Web/edge error-rate and latency SLOs off the app `/api/metrics` series.
- Realtime WebSocket connection churn.
