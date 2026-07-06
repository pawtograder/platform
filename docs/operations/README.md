# Operations

Operational configuration guides and runbooks for running Pawtograder (primarily
the self-hosted Helm deployment on Kubernetes). Complements the deployment
bootstrap in [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) and the chart docs in
[`../../charts/pawtograder/README.md`](../../charts/pawtograder/README.md).

## Contents

- [Deployment Channels (A/B by course)](./deployment-channels.md) — run a
  different web + edge-functions build for a subset of courses against the shared
  database (staged rollouts, dogfooding), with per-course host routing.

_More operational docs and runbooks to follow._
