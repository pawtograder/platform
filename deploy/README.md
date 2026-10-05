# Self-hosted stack: Forgejo, Coder and Pawtograder

`helmfile.yaml.gotmpl` deploys three components into one Kubernetes namespace:

| Component    | Releases                      | What it is                                                                 |
| ------------ | ----------------------------- | -------------------------------------------------------------------------- |
| `forgejo`    | `forgejo`, `forgejo-runner`   | Git hosting and Forgejo Actions, with a host-mode runner for grading jobs |
| `workspaces` | `coder`                       | Cloud Workspaces: Coder, with a Kubernetes pod template                   |
| `pawtograder`| `pawtograder`                 | `charts/pawtograder` from this repo                                       |
| `database`   | one per `postgres.instances` | Postgres servers for Forgejo and Coder (`groundhog2k/postgres`)           |

Everything specific to an install lives in `environments/<name>.yaml`: namespace, kube context, hostnames, which Postgres server each app uses, image pins. `sandbox` is the Ripley tenant namespace the Cloud Workspaces team develops in; a prod environment is another file of the same shape. Secrets never go in these files.

## Requirements

- `kubectl` with a context for the target namespace (`kubeContext` in the environment file)
- `helm` 3.x or 4.x with the [helm-diff](https://github.com/databus23/helm-diff) plugin, `helmfile`, `yq`
- Node.js (`npx`) for `scripts/GenerateJwtKeys.ts`
- Docker with buildx and about 16 GB of memory for the web image build, logged in to the environment's registry
- The `coder` CLI, for pushing workspace templates

On macOS: `brew install helm helmfile yq coder`, then `helm plugin install https://github.com/databus23/helm-diff`.

## First install

```bash
cd deploy
scripts/create-secrets.sh sandbox      # every Secret, generated; re-runnable
scripts/build-web-image.sh sandbox     # web image with this install's hostnames baked in
helmfile -e sandbox apply
```

The namespace has to provide two Secrets before this: the S3 credentials (`s3.credentialsSecret`) and the wildcard TLS certificate (`tlsSecret`). `create-secrets.sh` stops if either is missing.

`helmfile apply` installs the databases first, then each app after the server it depends on. Hooks do the setup that would otherwise be manual:

- `scripts/ensure-database.sh` (presync, Forgejo and Coder) creates the app's role and database on its Postgres server.
- The `forgejo-runner` presync hook registers the runner with Forgejo.
- `scripts/bootstrap-workspaces.sh` (Coder postsync) creates the first Coder owner from Secret `coder-admin` and pushes every template under `workspaces/templates`.

To deploy one component: `helmfile -e sandbox -l component=forgejo apply`. `apply` skips releases without a diff, and their hooks with them; use `sync` to run the hooks anyway.

## Accounts

Self-signup is off on Forgejo and Coder (Coder's built-in GitHub login too). `scripts/add-user.sh` creates an account on both with one generated password, kept in Secret `user-<username>`:

```bash
scripts/add-user.sh sandbox <username> <email> [--admin]
kubectl get secret user-<username> -o jsonpath='{.data.password}' | base64 -d; echo
```

The admin accounts the stack itself uses are in Secrets `forgejo-admin` and `coder-admin`.

Coder can't change a password user's email. To change one, delete the user's workspaces and the user, then run `add-user.sh` again with the new email; it reuses the password in the Secret.

## Databases

Forgejo and Coder each name a `database.server` in the environment file: an entry under `postgres.instances`, or `pawtograder` for the Pawtograder chart's bundled Postgres.

```yaml
postgres:
  instances:
    forgejo-db: { storage: 5Gi }
    coder-db: { storage: 5Gi }
forgejo:
  database: { server: forgejo-db }      # or: pawtograder
workspaces:
  database: { server: coder-db }        # or: pawtograder
```

Either way, each app gets its own role and database, with the password in Secret `<app>-db-credentials`, and `ensure-database.sh` applies the role, password and database idempotently. Pointing both apps at one instance shares a server; pointing an app at a different server and applying moves where it connects. Data does not move with it: dump and restore by hand before switching a server that has data.

The default is a dedicated instance per app. Both upstreams advise against their built-in databases (SQLite, Coder's embedded Postgres) in production, and sharing Pawtograder's Postgres ties Git and Coder uptime to Pawtograder upgrades and adds their connections to its `max_connections`. Use `pawtograder` when quota is tight and that coupling is acceptable.

## Forgejo Actions

The namespace can't run Docker-in-Docker, so the runner executes jobs in its own container (labels `ubuntu-latest`, `ubuntu-24.04` and `ubuntu-22.04`, all `:host`). Its image, `forgejo-runner/Dockerfile`, carries what grading jobs need: JDK 21, Maven, Python 3, Node 22 and git. Build it for `linux/amd64` and push it to the environment's registry; the tag is `forgejo.runner.image`.

Bare `uses:` names (`actions/checkout@v4`, `pawtograder/assignment-action@v3`) resolve against GitHub, as they do on GitHub, through `DEFAULT_ACTIONS_URL`. Without it Forgejo resolves them against data.forgejo.org.

Job ID tokens work the way `validateOIDCToken` expects ([#1056](https://github.com/pawtograder/platform/pull/1056)). A job that sets `enable-openid-connect: true` gets an RS256 token with issuer `https://<forgejo host>/api/actions`, and the keys are at `https://<forgejo host>/api/actions/.well-known/keys`. The edge functions get `FORGEJO_URL` from the same host, so the issuer they trust always matches the one Forgejo signs with.

LFS objects, attachments, packages and Actions logs go to S3 under `forgejo/`. Repositories stay on the `forgejo-data` volume.

## Cloud Workspaces

`workspaces/templates/kubernetes` creates one pod and one home-directory PVC per workspace in the namespace coderd runs in. Pods run under runc as uid 1000, without privileges or a service account token, and declare requests and limits so the namespace ResourceQuota admits them. VS Code (code-server) opens on a one-level subdomain of `domain`, which the wildcard certificate covers.

After changing a template, run `scripts/bootstrap-workspaces.sh sandbox` (or `helmfile -e sandbox -l component=workspaces sync`).

## Pawtograder

TODO: filled in once verified in the sandbox.

## Constraints this works within

These come from Ripley's tenant namespaces, and a prod namespace is likely to share most of them:

- Pod Security `baseline`: no privileged containers, host namespaces, `hostPath` volumes or Docker-in-Docker.
- A ResourceQuota on requests and limits, and no LimitRange: every container has to declare all four. `charts/pawtograder/tests/render-guardrails.sh` checks the Pawtograder chart for this.
- No `NodePort` or `LoadBalancer` Services: everything comes in through Ingress, so git is HTTPS only.
- Ingress hosts one level under `domain`, using the existing wildcard certificate; no cert-manager objects.
- Nodes are x86_64, so images built on Apple Silicon need `--platform linux/amd64`.
