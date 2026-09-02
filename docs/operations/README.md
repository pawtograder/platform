# Operations

Operational configuration guides and runbooks for running Pawtograder (primarily
the self-hosted Helm deployment on Kubernetes). Complements the deployment
bootstrap in [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) and the chart docs in
[`../../charts/pawtograder/README.md`](../../charts/pawtograder/README.md).

## Go-live runbooks

- [Production Install](./production-install.md): ordered first bring-up on a
  Rancher-managed cluster (storage, ESO/OpenBao, image builds, install, smoke).
- [Disaster Recovery](./disaster-recovery.md): backup layout, restore procedure
  (scratch and in-place), RTO/RPO, and `backup-verify` failure triage.
- [Point-in-Time Recovery & Failover](./point-in-time-recovery.md): WAL-G
  continuous archiving (PITR), the streaming standby, manual promote, and the
  promotion drill.
- [Planned Maintenance](./planned-maintenance.md): planned node/DB bounce as a
  short full-downtime window (why not read-only), the PDB + fast-shutdown that
  make it clean, and when to promote instead.
- [Rollback](./rollback.md): rolling a bad release back with forward-only
  migrations ("roll app back, leave schema forward").
- [Secrets Rotation](./secrets-rotation.md): rotating OpenBao/ESO-backed secrets
  and what breaks while you do.
- [Monitoring & Alerting](./monitoring-alerting.md): the alerts the chart ships
  (backup, ESO, cert) and how they're wired into kube-prometheus-stack.
- [Incident Response](./incident-response.md): severity definitions, first
  response, and per-component triage.
- [Data Retention & Storage Sizing](./data-retention.md): where data lives
  (Postgres / S3 / GitHub), how to size storage, how to enforce an age-based
  ("delete after N years") policy, and audit-log partition maintenance.

## Configuration

- [Deployment Channels (A/B by course)](./deployment-channels.md): run a
  different web + edge-functions build for a subset of courses against the shared
  database (staged rollouts, dogfooding), with per-course host routing.

## Related

- [`../../charts/pawtograder/PRODUCTION-READINESS.md`](../../charts/pawtograder/PRODUCTION-READINESS.md):
  what's hardened in the chart and what's deferred (Postgres HA, WAL/PITR).
- [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md): integration credentials (GitHub
  App, LTI, Discord, SMTP, EventBridge).
