# Deploying Pawtograder

This document covers deploying Pawtograder as a **self-hosted production service**:
the supported deployment target, how to register and wire up the **GitHub App**
that powers repo/org integration, and two strongly-recommended optional pieces —
an **AWS EventBridge** webhook ingress and an **Upstash/Redis** rate limiter.

If you only want to hack on the frontend or run end-to-end tests, you don't need
any of this — see [README.md](./README.md) ("Quick start for local development"
and "Setting up Supabase locally") instead.

> **⚠️ `docker compose` is NOT a supported or tested production deployment path.**
> The Docker-based stack you get from `npx supabase start` (and any
> `docker-compose`-style assembly of the Supabase images) is intended for **local
> development and CI only**. It has no high availability, no backup/restore
> verification, no network policies, no resource limits, and bakes
> dev-only defaults. It is **not** hardened, load-tested, or supported for
> production use. For production, deploy the Helm chart on Kubernetes (below).

## Supported production deployment: the Helm chart

The supported way to run Pawtograder in production is the Helm chart under
[`charts/pawtograder/`](./charts/pawtograder/). It bundles the Next.js web app
together with the Supabase services it depends on (Postgres, GoTrue, PostgREST,
Realtime, Storage, Kong, the Edge Functions runtime, etc.).

Start with the chart docs — they are the source of truth for cluster setup,
secrets, ingress, storage, monitoring, and image builds:

- [`charts/pawtograder/README.md`](./charts/pawtograder/README.md) — install, secrets, values reference.
- [`charts/pawtograder/PRODUCTION-READINESS.md`](./charts/pawtograder/PRODUCTION-READINESS.md) — what's hardened and what's still deferred (Postgres HA, WAL/PITR).
- [`charts/pawtograder/examples/values-prod.yaml`](./charts/pawtograder/examples/values-prod.yaml) — a documented production template to copy into your deployment repo.

The rest of this document is about the **integration credentials** the chart
mounts into the web pod and the Edge Functions runtime — chiefly GitHub. Where
those credentials physically live (a hand-provisioned Kubernetes Secret, or
OpenBao + External Secrets Operator) is covered in the chart README under
"Required Secrets" and "Edge-function credentials via OpenBao + ESO". This doc
explains **what each credential is and how to obtain it.**

---

## GitHub App setup

Pawtograder integrates with GitHub through a **single GitHub App** (not a classic
OAuth App, and not a personal access token). One App serves three purposes:

1. **Sign-in** — students and staff log in with GitHub (via Supabase GoTrue's
   `github` external provider).
2. **Repo & org automation** — creating assignment repos from templates, forking
   handouts, syncing org teams (`<class-slug>-staff` / `<class-slug>-students`),
   managing branch rulesets, dispatching the grading workflow, and posting check
   runs. These use the App **installation** token for each org.
3. **Webhook ingestion** — receiving `push`, `pull_request`, `check_run`,
   `workflow_run`, `deployment_status`, and org/membership events that drive
   submission processing.

Because a GitHub App can act as an OAuth provider _and_ hold installation
permissions, you do **not** need a separate OAuth App. The App's client ID /
client secret are reused for GoTrue sign-in.

### 1. Register the App

GitHub → your **organization** (or user) → **Settings** → **Developer settings**
→ **GitHub Apps** → **New GitHub App**. Registering it under the org that will own
courses is recommended; you can make it public later if multiple orgs install it.

Key fields:

| Field                                                      | Value                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub App name**                                        | e.g. `Pawtograder` (the slug becomes part of install URLs — see `GITHUB_APP_SLUG` below).                                                                             |
| **Homepage URL**                                           | Your deployment URL, e.g. `https://pawtograder.example.edu`.                                                                                                          |
| **Callback URL**                                           | `https://<api-host>/auth/v1/callback` (the GoTrue callback — see note below). Add a second callback for the App's own OAuth if you use it.                            |
| **Request user authorization (OAuth) during installation** | Optional; leave unchecked unless you want install-time auth.                                                                                                          |
| **Webhook → Active**                                       | **On** (see [Subscribe to events](#3-subscribe-to-webhook-events) and [AWS EventBridge](#aws-eventbridge-webhook-ingress-optional-strongly-recommended) for the URL). |
| **Webhook → URL**                                          | Either the Edge Function directly, or your EventBridge ingress — see below.                                                                                           |
| **Webhook → Secret**                                       | A random string. This becomes `GITHUB_WEBHOOK_SECRET`.                                                                                                                |

> **Callback URL for sign-in:** the GoTrue `github` provider's redirect URI
> depends on your chart's `global.apiOnSeparateHost`. With the default
> (`apiOnSeparateHost: true`) it is `https://api.<hostname>/auth/v1/callback`;
> with path-based routing it is `https://<hostname>/auth/v1/callback`. This is the
> same mechanic the chart README documents for any OAuth provider under "Single
> sign-on (SSO)".

### 2. Permissions

Pawtograder's handlers call the endpoints below, which map to these App
permissions. Grant exactly these (least privilege):

**Repository permissions**

| Permission                      | Access       | Why                                                                                                    |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| **Administration**              | Read & write | Repo settings, branch rulesets, collaborators, Actions permissions.                                    |
| **Contents**                    | Read & write | Git data (blobs/trees/commits/refs), template generation, forks, `merge-upstream`, reading repo files. |
| **Checks**                      | Read & write | Create/update check runs for grading status.                                                           |
| **Actions**                     | Read & write | Dispatch the grading workflow; set Actions permissions on new repos.                                   |
| **Pull requests**               | Read & write | Create PRs, read PR/comments for submission ingestion.                                                 |
| **Issues**                      | Read         | Read issue comments.                                                                                   |
| **Webhooks** (Repository hooks) | Read & write | Legacy per-repo webhook management (being phased out in favor of the App-level hook).                  |
| **Deployments**                 | Read         | Ingest `deployment_status` into `github_deployments` (PR-submission mode).                             |
| **Metadata**                    | Read         | Mandatory baseline.                                                                                    |

**Organization permissions**

| Permission         | Access       | Why                                                              |
| ------------------ | ------------ | ---------------------------------------------------------------- |
| **Members**        | Read & write | Create teams, add/remove team memberships, send org invitations. |
| **Administration** | Read         | Resolve org metadata for install deep-links.                     |

**Account permissions** — email address (read) is enough for sign-in identity.

### 3. Subscribe to webhook events

Under **Permissions & events → Subscribe to events**, check exactly the events
the handlers expect. The authoritative list lives in code at
[`supabase/functions/github-repo-configure-webhook/index.ts`](./supabase/functions/github-repo-configure-webhook/index.ts)
(`GITHUB_APP_WEBHOOK_EVENTS`) — keep the App subscription in sync with it:

- **Push**
- **Pull request**
- **Check run**
- **Workflow run**
- **Membership**
- **Organization**
- **Deployment status** (and **Deployment** — required for `github_deployments`
  ingestion; see [AGENTS.md](./AGENTS.md) "GitHub App webhook subscription").

When you add a new handler in `supabase/functions/github-repo-webhook/index.ts`,
add the event to `GITHUB_APP_WEBHOOK_EVENTS` **and** subscribe the App to it.

### 4. Generate the credentials

After creating the App, collect:

| Env var                      | Where to find it                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`              | App settings → "App ID".                                                                                                                                          |
| `GITHUB_APP_SLUG`            | The URL slug of the App (e.g. `pawtograder`). Optional — the code falls back to `GET /app` — but setting it avoids an extra API call when building install links. |
| `GITHUB_PRIVATE_KEY_STRING`  | App settings → "Private keys" → **Generate a private key**. Downloads a `.pem`; this var holds its contents.                                                      |
| `GITHUB_WEBHOOK_SECRET`      | The webhook secret you set above.                                                                                                                                 |
| `GITHUB_OAUTH_CLIENT_ID`     | App settings → "Client ID".                                                                                                                                       |
| `GITHUB_OAUTH_CLIENT_SECRET` | App settings → "Generate a new client secret".                                                                                                                    |

The same `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` are used both by
GoTrue (sign-in, in the `pawtograder-web` Secret) and by the Edge Functions
(`github-app` bundle / `pawtograder-edge-functions` Secret).

> **Private key formatting in env files.** Supabase's
> `functions serve --env-file` (and the chart's env injection) does not support
> multi-line quoted values. Single-line the PEM with literal `\n` escapes — the
> Octokit/GitHub-App SDK unescapes them at runtime. See `.github/workflows/deploy.yml`
> for the exact `awk` one-liner, and `.env.local.staging` for the shape. When
> provisioning via OpenBao, use the `_FILE` suffix
> (`GITHUB_PRIVATE_KEY_STRING_FILE=/path/to/key.pem`) — see
> [`scripts/setup-openbao-edge-functions.sh`](./scripts/setup-openbao-edge-functions.sh).

### 5. Provision the secrets

The `github-app` bundle carries:

```
GITHUB_APP_ID
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
GITHUB_PRIVATE_KEY_STRING
GITHUB_WEBHOOK_SECRET
EVENTBRIDGE_SECRET        # see "AWS EventBridge" below
```

Provision it into `pawtograder-edge-functions` (and the OAuth client id/secret
into `pawtograder-web` for GoTrue) using whichever path the chart README
describes — OpenBao + ESO is recommended:

```sh
scripts/setup-openbao-edge-functions.sh \
  --env production \
  --bundle github-app \
  --from-file .secrets/github-app-production.env
```

Then enable GitHub sign-in in your values overlay:

```yaml
auth:
  external:
    github: { enabled: true } # reads GITHUB_OAUTH_CLIENT_ID / _SECRET
```

### 6. Install the App on each org

Each course's GitHub org must have the App installed. Instructors do this from
within Pawtograder (the app surfaces an install deep-link when it detects the App
isn't installed on an org), or directly via
`https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`. Grant it access to
the repositories/org it should manage.

---

## AWS EventBridge webhook ingress (optional, strongly recommended)

GitHub can POST webhooks straight at the `github-repo-webhook` Edge Function. In
production we **strongly recommend** routing them through **Amazon EventBridge**
instead.

**Why:** EventBridge decouples GitHub's delivery from your Edge Function's
availability. It buffers and retries deliveries (with backoff and a dead-letter
queue), smooths bursts so a wave of `push`/`workflow_run` events can't overwhelm
the function, and gives you a durable audit trail and replay. A direct webhook
that fails while your function is briefly unavailable depends solely on GitHub's
limited redelivery window; an EventBridge-fronted one survives much longer
outages.

**How it authenticates.** The Edge Function does not verify GitHub's HMAC on the
EventBridge path; instead it requires an `Authorization` header equal to
`EVENTBRIDGE_SECRET`. The EventBridge **API destination** is configured with a
connection that injects exactly that header. (GitHub itself can't set an
arbitrary `Authorization` header, which is precisely why this is an
EventBridge-only ingress.) See
[`supabase/functions/github-repo-webhook/index.ts`](./supabase/functions/github-repo-webhook/index.ts)
(`Deno.env.get("EVENTBRIDGE_SECRET")`).

**Wiring (high level):**

1. Create a GitHub **partner event source** in EventBridge (AWS Console →
   EventBridge → Partner event sources → GitHub), or push GitHub webhooks into a
   custom event bus via API Gateway/Lambda if you prefer. Associate it with an
   event bus.
2. Create an **API destination** pointing at your Edge Function URL
   (`https://<api-host>/functions/v1/github-repo-webhook`), with a **connection**
   whose authorization adds the header `Authorization: <EVENTBRIDGE_SECRET>`.
3. Add a **rule** on the bus that matches the GitHub events and targets the API
   destination. Attach a **dead-letter queue** (SQS) and a retry policy.
4. Set `EVENTBRIDGE_SECRET` (a random string) in the `github-app` bundle so the
   Edge Function and the EventBridge connection agree.
5. Point the GitHub App's **Webhook URL** at the ingress that feeds the bus.

> If you skip EventBridge, point the App's webhook URL directly at the Edge
> Function and still set `EVENTBRIDGE_SECRET` (the function gates on it
> regardless). For local dev/CI the value is just a shared constant — see
> `.github/workflows/deploy.yml` (`EVENTBRIDGE_SECRET=some-eventbridge-secret`).

---

## Redis / Upstash for rate limiting (optional, strongly recommended)

The GitHub and Discord async workers throttle outbound API calls (via
Bottleneck) and the webhook handler does distributed coordination. Without a
shared store, each Edge Function instance rate-limits **in-process only** — fine
for a single instance, but with multiple replicas you can collectively blow
through GitHub's secondary rate limits. A shared Redis gives you **cluster-wide**
rate limiting.

Pawtograder's Redis layer ([`supabase/functions/_shared/Redis.ts`](./supabase/functions/_shared/Redis.ts))
supports two backends, selected by which env vars are present:

| Backend                  | Env vars                                             | Notes                                                                |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------- |
| **Upstash (REST)**       | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Serverless Redis over HTTPS — simplest for managed/edge deployments. |
| **Standard Redis (TCP)** | `REDIS_URL` (e.g. `redis://…`)                       | Use any Redis you operate, including the chart's in-cluster Redis.   |

If neither is set, the code falls back to a local in-process limiter (acceptable
only for single-instance or dev).

- **Managed:** create an [Upstash](https://upstash.com/) Redis database and put
  its REST URL/token in the `redis` bundle:

  ```sh
  scripts/setup-openbao-edge-functions.sh \
    --env production --bundle redis \
    --from-file .secrets/redis-production.env
  ```

- **In-cluster:** the chart can run a shared Redis — see
  [`charts/pawtograder/examples/shared-redis/`](./charts/pawtograder/examples/shared-redis/)
  and set `REDIS_URL` to its in-cluster address.

The same Upstash variables also enable distributed rate limiting for the Discord
webhook path — see the Discord section in [README.md](./README.md).

---

## Other integrations

These are configured the same way (a bundle of env vars provisioned into the web
and/or edge-functions Secret). See [`scripts/setup-openbao-edge-functions.sh --list`](./scripts/setup-openbao-edge-functions.sh)
for the full set and the [chart README](./charts/pawtograder/README.md) for how
they're mounted:

- **Discord** notifications — full setup walkthrough in [README.md](./README.md) ("Discord Bot Setup").
- **AWS Chime** (office-hours video) — `aws-chime` bundle.
- **Canvas / SIS** roster sync — `canvas` / `sis` bundles.
- **SMTP** (GoTrue mail) — `smtp` bundle.
- **LLM / MCP** hints — `mcp` bundle.
- **Sentry** error reporting — `sentry` bundle.

---

## Checklist

- [ ] Helm chart deployed per [`charts/pawtograder/README.md`](./charts/pawtograder/README.md) (NOT docker compose).
- [ ] GitHub App registered with the permissions and events above.
- [ ] App private key, webhook secret, app id, OAuth client id/secret in the `github-app` bundle.
- [ ] GitHub sign-in enabled (`auth.external.github.enabled: true`) with OAuth creds in `pawtograder-web`.
- [ ] App installed on each course org.
- [ ] (Recommended) EventBridge ingress wired, `EVENTBRIDGE_SECRET` set on both sides.
- [ ] (Recommended) Upstash/Redis configured for cluster-wide rate limiting.
- [ ] Production values reviewed against [`PRODUCTION-READINESS.md`](./charts/pawtograder/PRODUCTION-READINESS.md) (note deferred items: Postgres HA, WAL/PITR).
      </content>
      </invoke>
