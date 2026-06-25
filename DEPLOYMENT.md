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

| Field                                                      | Value                                                                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub App name**                                        | e.g. `Pawtograder` (the slug becomes part of install URLs — see `GITHUB_APP_SLUG` below).                                                                                                     |
| **Homepage URL**                                           | Your deployment URL, e.g. `https://pawtograder.example.edu`.                                                                                                                                  |
| **Callback URL**                                           | `https://<api-host>/auth/v1/callback` (the GoTrue callback — see note below). Add a second callback for the App's own OAuth if you use it.                                                    |
| **Request user authorization (OAuth) during installation** | Optional; leave unchecked unless you want install-time auth.                                                                                                                                  |
| **Webhook → Active**                                       | **On** (see [Subscribe to events](#3-subscribe-to-webhook-events) and [AWS EventBridge](#aws-eventbridge-webhook-ingress-optional-strongly-recommended) for the URL).                         |
| **Webhook → URL**                                          | Your webhook ingress — see [AWS EventBridge](#aws-eventbridge-webhook-ingress-optional-strongly-recommended) (the Edge Function only accepts the EventBridge envelope, not raw GitHub POSTs). |
| **Webhook → Secret**                                       | A random string. This becomes `GITHUB_WEBHOOK_SECRET`.                                                                                                                                        |

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

These values are read at runtime by the Edge Functions. How you deliver them
depends on how you run the functions:

**Kubernetes / Helm (production).** Provision the bundle into
`pawtograder-edge-functions` (and the OAuth client id/secret into
`pawtograder-web` for GoTrue) using whichever path the chart README describes —
OpenBao + ESO is recommended:

```sh
scripts/setup-openbao-edge-functions.sh \
  --env production \
  --bundle github-app \
  --from-file .secrets/github-app-production.env
```

**Local / self-managed `supabase functions serve`.** The edge runtime reads a
dotenv file (`supabase functions serve --env-file supabase/functions/.env`).
Copy the template and fill it in:

```sh
cp supabase/functions/.example.env supabase/functions/.env
# then edit supabase/functions/.env:
#   GITHUB_APP_ID=...
#   GITHUB_OAUTH_CLIENT_ID=...
#   GITHUB_OAUTH_CLIENT_SECRET=...
#   GITHUB_WEBHOOK_SECRET=...
#   EVENTBRIDGE_SECRET=...
#   GITHUB_PRIVATE_KEY_STRING="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

`supabase/functions/.env` is git-ignored — never commit it. As noted above, the
PEM must be single-lined with literal `\n` escapes (the `--env-file` parser
rejects multi-line quoted values). This same file is where you'll add the
Discord, SMTP, Sentry, and Redis vars from the sections below.

### 6. Configure GitHub sign-in (GoTrue) — required

Logging in with GitHub is not optional plumbing; students and staff authenticate
through it. Enabling it is a two-part job (the chart README covers this under
"Single sign-on (SSO)"):

1. **Provider (GoTrue).** Enable the `github` external provider and give it the
   App's OAuth credentials. In the Helm chart:

   ```yaml
   auth:
     external:
       github: { enabled: true } # reads GITHUB_OAUTH_CLIENT_ID / _SECRET
   ```

   Put `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` in the
   `pawtograder-web` Secret (same values as the `github-app` bundle). For a
   non-chart deploy, set the standard GoTrue env vars instead:
   `GOTRUE_EXTERNAL_GITHUB_ENABLED=true`,
   `GOTRUE_EXTERNAL_GITHUB_CLIENT_ID`, `GOTRUE_EXTERNAL_GITHUB_SECRET`, and
   `GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI`.

2. **Redirect/callback URL.** GoTrue's callback must be registered on the GitHub
   App (the **Callback URL** field from step 1). It is the API gateway origin +
   `/auth/v1/callback` — with the chart default (`global.apiOnSeparateHost: true`)
   that's `https://api.<hostname>/auth/v1/callback`; with path-based routing it's
   `https://<hostname>/auth/v1/callback`. The web app's sign-in button calls
   `supabase.auth.signInWithOAuth({ provider: "github" })`, so it carries no
   client secret itself — GoTrue holds the credentials and performs the redirect.

If the provider is enabled but the callback URL doesn't match, sign-in fails with
an OAuth redirect error; if the callback is registered but the provider is
disabled, the button errors on click.

**Local stack (`npx supabase start`).** GoTrue is configured from
`supabase/config.toml`, not env/Helm values. Add a provider block and read the
secret from your `.env` (the CLI expands `env(...)`):

```toml
[auth.external.github]
enabled = true
client_id = "env(GITHUB_OAUTH_CLIENT_ID)"
secret = "env(GITHUB_OAUTH_CLIENT_SECRET)"
# Local GoTrue callback (the API gateway runs on 54321):
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
```

Register that `redirect_uri` on the GitHub App, restart the stack
(`npx supabase stop && npx supabase start`) to pick up config changes, and the
same block shape works for `[auth.external.discord]`.

### 7. Install the App on each org

Each course's GitHub org must have the App installed. Instructors do this from
within Pawtograder (the app surfaces an install deep-link when it detects the App
isn't installed on an org), or directly via
`https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`. Grant it access to
the repositories/org it should manage.

---

## GitHub Actions runners for grading

Autograding runs **in GitHub Actions** inside each student repo: a
`.github/workflows/grade.yml` workflow invokes the
[`pawtograder/assignment-action`](https://github.com/pawtograder/assignment-action),
which clones the grader, runs the tests, and posts results back to Pawtograder's
Edge Functions (authenticated by the job's GitHub OIDC token, validated in
`autograder-create-submission`).

**You must provide runners with enough capacity for your grading load.** Standard
GitHub-hosted runners work, but most institutions self-host for cost, custom
toolchains, and network access to internal services. **We suggest
[Actions Runner Controller (ARC)](https://github.com/actions/actions-runner-controller)**
— a Kubernetes operator that autoscales ephemeral self-hosted runners — which can
run in the same cluster as the Helm deployment. **Standing up runners is out of
scope for this guide** (see the ARC docs); what is in scope is the two
`grade.yml` settings that must match your deployment. The
[stock template `grade.yml`](https://github.com/pawtograder/template-assignment-handout/blob/main/.github/workflows/grade.yml)
ships with Khoury's values:

```yaml
jobs:
  grade:
    runs-on: khoury-course-runners # (1) change to your runner labels
    steps:
      - name: Collect Submission and Run Grader
        uses: pawtograder/assignment-action@v3
        with:
          grading_server: "https://api.pawtograder.com" # (2) change to your API host
          action_ref: "${{ github.action_ref }}"
          action_repository: "${{ github.action_repository }}"
```

1. **`runs-on`** must target your runners' labels (e.g. `self-hosted` or an ARC
   runner-set name) instead of `khoury-course-runners`.
2. **`grading_server`** is the API destination — set it to your deployment's
   **API gateway origin** (the same host as the GoTrue callback:
   `https://api.<hostname>` by default, or `https://<hostname>` with path-based
   routing), **not** `https://api.pawtograder.com`. The action appends the Edge
   Function path itself, so give it the host root, not a `/functions/v1` path.

Set both in your **template repos** so every new assignment inherits them (see
[Default template repositories](#default-template-repositories-admin)) — the
admin "Edit template repo files" editor below is the easiest place to do it.

> Students must not edit `grade.yml`: Pawtograder hashes it against the handout's
> copy when registering a submission and rejects tampered workflows, so these two
> values are fixed by you in the template, not per student.

---

## Default template repositories (admin)

New assignment repos are created from **template repositories**. Out of the box
these are hardcoded to `pawtograder/template-assignment-handout` and
`pawtograder/template-assignment-grader` — which live in the upstream
`pawtograder` org your deployment can't push to. **Self-hosted deployments must
point these at templates in their own GitHub org.**

A **platform admin** sets the org-wide defaults through the app's admin UI:

1. Go to **Admin → GitHub Orgs** (`/admin/github-orgs`).
2. Click the org name to open `/admin/github-orgs/<org>`.
3. Under **"Default template repositories"** ("Used for new assignment repos in
   classes that don't override them"), fill in:

   - **Default handout template repository** — `your-org/template-assignment-handout`
   - **Default solution (grader) template repository** — `your-org/template-assignment-grader`

   (Values must be exactly `owner/repo`.) Click **Save defaults**.

Resolution order when creating an assignment repo is: per-class override
(`classes.handout_template_repo` / `solution_template_repo`, set by instructors)
→ org default (`github_orgs.default_handout_template_repo` /
`default_solution_template_repo`, set here) → the hardcoded `pawtograder/*`
fallback. Defaults persist via the `admin_upsert_github_org` RPC (global-admin
only) into the `github_orgs` table.

**Edit the template files in place.** The same page has an **"Edit template repo
files"** card (tabs: _Handout template_ / _Solution template_) with a live-validated
editor for each template's **`.github/workflows/grade.yml`** and
**`pawtograder.yml`**. This is where you set the grading workflow's
[`runs-on` and API destination](#github-actions-runners-for-grading). (Editing
requires at least one course in the org, to authorize GitHub access.)

---

## AWS EventBridge webhook ingress (optional, strongly recommended)

In production we **strongly recommend** routing GitHub's webhook deliveries
through **Amazon EventBridge** before they reach the `github-repo-webhook` Edge
Function.

**Why:** EventBridge decouples GitHub's delivery from your Edge Function's
availability. It buffers and retries deliveries (with backoff and a dead-letter
queue), smooths bursts so a wave of `push`/`workflow_run` events can't overwhelm
the function, and gives you a durable audit trail and replay. A direct webhook
that fails while your function is briefly unavailable depends solely on GitHub's
limited redelivery window; an EventBridge-fronted one survives much longer
outages.

**How authentication works — two distinct secrets.** They guard different hops:

- `GITHUB_WEBHOOK_SECRET` is the secret you set on the **GitHub App's webhook**.
  GitHub signs every delivery with it (`X-Hub-Signature-256`). Verify that
  signature at your **ingress** (the API Gateway / Lambda that receives GitHub's
  POST and republishes it onto the event bus) before trusting the payload.
- `EVENTBRIDGE_SECRET` guards the **last hop into the Edge Function**. The
  function's entry handler does **not** re-verify the GitHub HMAC — it dispatches
  the EventBridge envelope via `eventHandler.receive()` (no signature check) and
  instead rejects any request whose `Authorization` header isn't exactly
  `EVENTBRIDGE_SECRET`. The EventBridge **API destination** injects that header.
  See
  [`supabase/functions/github-repo-webhook/index.ts`](./supabase/functions/github-repo-webhook/index.ts)
  (the `Authorization !== EVENTBRIDGE_SECRET` gate and `eventHandler.receive`).

Because the function authenticates the **envelope** (not a raw GitHub payload),
you cannot point the GitHub App's webhook URL straight at the Edge Function — the
request would lack the `Authorization` header and wouldn't carry the
EventBridge `detail-type` / `detail` envelope the handler reads. The ingress (or
EventBridge) is what produces both.

> **The `|| "secret"` literal default** in `github-repo-webhook/index.ts` (and
> `GitHubWrapper.ts`) is a convenience fallback for local/dev only — set a real
> `GITHUB_WEBHOOK_SECRET` (matching the GitHub App's webhook secret) and a real
> `EVENTBRIDGE_SECRET` in production. For local dev/CI both are just shared
> constants — see `.github/workflows/deploy.yml`
> (`EVENTBRIDGE_SECRET=some-eventbridge-secret`).

**Wiring (high level):**

1. Stand up an **ingress** that receives GitHub's webhook POST, verifies
   `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`, and publishes the event
   onto an EventBridge bus — e.g. API Gateway + Lambda, or a GitHub **partner
   event source** (AWS Console → EventBridge → Partner event sources → GitHub).
2. Create an **API destination** pointing at your Edge Function URL
   (`https://<api-host>/functions/v1/github-repo-webhook`), with a **connection**
   whose authorization adds the header `Authorization: <EVENTBRIDGE_SECRET>`.
3. Add a **rule** on the bus that matches the GitHub events and targets the API
   destination. Attach a **dead-letter queue** (SQS) and a retry policy.
4. Set `EVENTBRIDGE_SECRET` (a random string) in the `github-app` bundle so the
   Edge Function and the EventBridge connection agree.
5. Point the GitHub App's **Webhook URL** at the ingress from step 1.

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
webhook path — see [Discord notifications](#discord-notifications) below.

---

## Email (SMTP)

Pawtograder sends email through **two independent SMTP configurations** — they are
separate on purpose and use different variable names:

### 1. GoTrue (authentication email)

Signup confirmation, magic-link, and password-recovery mail. Configured on the
**auth** service. In the Helm chart, enable `auth.smtp.enabled=true` and provide
the `pawtograder-smtp` Secret:

| Var                | Meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `SMTP_HOST`        | SMTP server hostname.                                         |
| `SMTP_PORT`        | Port (e.g. `587`).                                            |
| `SMTP_USER`        | SMTP username.                                                |
| `SMTP_PASS`        | SMTP password (**note: `SMTP_PASS`, not `SMTP_PASSWORD`**).   |
| `SMTP_ADMIN_EMAIL` | The `From:` address (e.g. `noreply@pawtograder.example.edu`). |

See the chart README ("Deploying staging" → SMTP) for the exact Secret/OpenBao
shape.

### 2. In-app notifications (Edge Functions)

Help-request, regrade, and other in-app notification emails are sent by the
`notification-queue-processor` Edge Function
([`supabase/functions/notification-queue-processor/index.ts`](./supabase/functions/notification-queue-processor/index.ts)).
This uses the edge-functions `smtp` bundle (its own variable names):

| Var             | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `SMTP_HOST`     | SMTP server hostname. If unset/empty, notification email is skipped.       |
| `SMTP_PORT`     | Port; defaults to `465` (TLS).                                             |
| `SMTP_USER`     | SMTP username.                                                             |
| `SMTP_PASSWORD` | SMTP password (**note: `SMTP_PASSWORD` here, vs `SMTP_PASS` for GoTrue**). |
| `SMTP_FROM`     | `From:` address — sent as `Pawtograder <SMTP_FROM>`.                       |
| `SMTP_REPLY_TO` | Default `Reply-To:` address.                                               |

```sh
scripts/setup-openbao-edge-functions.sh \
  --env production --bundle smtp \
  --from-file .secrets/smtp-production.env
```

(Locally these go in `supabase/functions/.env`; port `54325` targets the
Supabase Inbucket mail catcher.)

### Local stack (`npx supabase start`)

The local stack ships **Inbucket**, a built-in mail catcher — no real SMTP needed
for dev. Mail GoTrue would send is captured and viewable at
`http://localhost:54324`; `supabase/config.toml` already enables it:

```toml
[inbucket]
enabled = true
port = 54324
smtp_port = 54325
```

- **GoTrue auth mail** is caught by Inbucket automatically. To send through a
  real provider instead, fill in the `[auth.email.smtp]` block in
  `supabase/config.toml` (`host`, `port`, `user`, `pass`, `admin_email`,
  `sender_name`) and restart the stack.
- **In-app notifications** are sent by the Edge Function, so point its
  `supabase/functions/.env` at Inbucket to see them locally:

  ```sh
  SMTP_HOST=host.docker.internal
  SMTP_PORT=54325
  SMTP_USER=test
  SMTP_PASSWORD=test
  SMTP_FROM=noreply@pawtograder.local
  SMTP_REPLY_TO=support@pawtograder.local
  ```

  (`SMTP_PORT=54325` is the sentinel the function uses to recognize the local
  Inbucket catcher; see `supabase/functions/.example.env`.)

---

## Discord notifications

The Discord bot integration lets staff receive real-time notifications about help
requests and regrade requests in Discord channels. The bot automatically creates
channels for assignments, labs, and office-hours queues, and posts notifications
when requests are created or updated. It is **optional** — skip this section if
you don't use Discord.

### Prerequisites

1. **Discord Application**: create one at the [Discord Developer Portal](https://discord.com/developers/applications).
2. **Discord Bot**: add a bot user and note the bot token.
3. **OAuth2**: configure an OAuth2 redirect URI in the application settings.

### Environment variables

Discord touches three places (the variable names below are what the current code
actually reads — verified against `app/api/discord/*`, `discord-async-worker`, and
the chart's `auth.yaml`):

**Web app** (`pawtograder-web` Secret / `.env.local`):

- `DISCORD_PUBLIC_KEY` — the application's public key; verifies signatures on the
  `/api/discord/interactions` endpoint. Hex-encoded.
- `DISCORD_WEBHOOK_PUBLIC_KEY` — the webhook's public key; verifies ed25519
  signatures on `/api/discord/webhook`. Hex-encoded, with or without `0x`.

**GoTrue** (account linking — "Connect Discord" uses Supabase's `discord` OAuth
provider, the same mechanism as GitHub sign-in):

```yaml
auth:
  external:
    discord: { enabled: true } # reads DISCORD_OAUTH_CLIENT_ID / _SECRET
```

Put `DISCORD_OAUTH_CLIENT_ID` / `DISCORD_OAUTH_CLIENT_SECRET` in the
`pawtograder-web` Secret. GoTrue's redirect URI is the API gateway origin +
`/auth/v1/callback` (same rule as GitHub above) — that is the URL to register as
the Discord application's OAuth2 redirect.

**Edge Functions** (`discord-async-worker`; `discord` bundle):

- `DISCORD_BOT_TOKEN` — bot token (Bot section of the Developer Portal).
- `DISCORD_APPLICATION_ID` — the application ID.
- (Optional) `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — distributed
  rate limiting; falls back to a local limiter if unset (see
  [Redis / Upstash](#redis--upstash-for-rate-limiting-optional-strongly-recommended)).

### Discord application configuration

1. **Create the application** — note the Application ID
   (`DISCORD_APPLICATION_ID`) and, under General Information, the **Public Key**
   (`DISCORD_PUBLIC_KEY`).
2. **Create the bot user** — reset/copy the token (`DISCORD_BOT_TOKEN`). Enable
   the **Server Members Intent** privileged gateway intent if you use user
   mentions.
3. **Configure OAuth2** — copy the Client ID / Client Secret into
   `DISCORD_OAUTH_CLIENT_ID` / `DISCORD_OAUTH_CLIENT_SECRET`, and under
   **Redirects** register GoTrue's callback (not an app route):
   - Separate API host (default): `https://api.<your-domain>/auth/v1/callback`
   - Path-based routing: `https://<your-domain>/auth/v1/callback`
4. **Bot permissions** when inviting the bot to a server: Manage Channels, Send
   Messages, Read Message History, Mention Everyone, Manage Roles, and
   (optional) Use External Emojis / Add Reactions. Generate an invite via the
   OAuth2 URL Generator, or:

   ```text
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=268896336&scope=bot
   ```

5. **Configure the webhook** (for automatic role assignment) under the
   application's Webhooks section. Set the URL to:

   - Local: `http://localhost:3000/api/discord/webhook` (use ngrok or similar)
   - Production: `https://<your-domain>/api/discord/webhook`

     Copy the webhook's **public key** into `DISCORD_WEBHOOK_PUBLIC_KEY`.

### Per-class setup (instructors)

1. **Link Discord account** (staff): on the course page, click "Connect Discord"
   to link via OAuth (lets the system @-mention you).
2. **Configure the server**: at `/course/[course_id]/manage/discord`, enter your
   Discord Server ID (right-click server → Copy Server ID; requires Developer
   Mode), optionally a Channel Group ID, then save.
3. **Enable Developer Mode** in Discord (Settings → Advanced) to copy IDs.

### How it works

Once configured, the bot auto-creates channels for assignments/labs/queues,
posts help requests with live status updates, posts regrade requests to
`#regrades` (@-mentioning the grader), updates messages as status changes, shows
resolution feedback, and escalates appealed regrades to instructors. The
`discord-async-worker` Edge Function processes Discord API calls asynchronously
with rate limiting and retries; the `/api/discord/webhook` Next.js route verifies
ed25519 signatures and triggers role assignment.

---

## Error reporting (Sentry / self-hosted Bugsink)

Pawtograder reports errors through the Sentry SDK, but the client is configured
for a **Sentry-compatible** backend and the web app is wired specifically for
[**Bugsink**](https://www.bugsink.com/) — a lightweight, single-container,
self-hostable error tracker. If you have only minimal resources, **self-hosting
Bugsink is the recommended option** (it speaks the Sentry DSN protocol, so the
same SDK config works against either).

Two surfaces, two variables:

- **Web app (build-time).** `NEXT_PUBLIC_BUGSINK_DSN` (and
  `NEXT_PUBLIC_BUGSINK_HOST`) are `NEXT_PUBLIC_*` vars, so they are **baked into
  the web image at build time** — pass them as `docker build --build-arg`s, not
  runtime env. When the DSN is unset the Sentry webpack integration is skipped
  entirely (fine for local dev). The client posts through a `/api/tunnel` route
  and runs with no Sentry integrations (Bugsink doesn't support them).
- **Edge Functions (runtime).** `SENTRY_DSN` (and optional `SENTRY_DEBUG`) are
  read at runtime from the `sentry` bundle:

  ```sh
  scripts/setup-openbao-edge-functions.sh \
    --env production --bundle sentry \
    --from-file .secrets/sentry-production.env
  ```

`SENTRY_RELEASE` / `SENTRY_ENVIRONMENT` are optional on both surfaces for tagging
releases and environments. Leave everything unset to disable error reporting.

---

## Other integrations

These are configured the same way — a bundle of env vars provisioned into the web
and/or edge-functions Secret. See
[`scripts/setup-openbao-edge-functions.sh --list`](./scripts/setup-openbao-edge-functions.sh)
for the full set and the [chart README](./charts/pawtograder/README.md) for how
they're mounted:

- **AWS Chime** (office-hours video) — `aws-chime` bundle.
- **Canvas / SIS** roster sync — `canvas` / `sis` bundles.
- **LLM / MCP** hints — `mcp` bundle.
