# Canvas LMS for Pawtograder LTI 1.3 end-to-end testing

A reusable, self-contained Canvas LMS stack used to exercise Pawtograder's
LTI 1.3 integration (OIDC login, resource-link launch, NRPS roster sync, AGS
grade passback) end-to-end.

Everything here lives under `tests/e2e/canvas/`. **No Canvas source is committed
into this repo** — it is cloned at build time into a sibling directory.

---

## 0. Run the whole thing

```bash
# Build the Canvas image once (or pull it from GHCR), then:
npm run test:e2e:canvas
```

`tests/e2e/canvas/run-e2e.sh` is the single orchestrator (used locally and in
CI): it boots Canvas + Supabase + the Pawtograder tool, seeds a course/users/
assignment + LTI 1.3 dev key, registers the platform, writes
`tests/e2e/lti/.canvas-e2e.json`, and runs `playwright.canvas.config.ts`
(`tests/e2e/lti/*.canvas.spec.ts`). Set `KEEP_UP=1` to leave the stack running.

CI runs this in a dedicated, opt-in lane (`.github/workflows/canvas-e2e.yml`):
manual dispatch or a PR labeled `e2e-canvas` — never on the normal PR E2E run.

### Canvas interop requirements (learned from live runs)

These are baked into the harness; noted here because they bite anyone wiring a
local Canvas LTI 1.3 tool:

1. **Serve Canvas on port 80, domain `localhost`** (no port). A non-default port
   leaks into Canvas's NRPS/AGS URL building and trips `URI#host=` in current
   Canvas. (`CANVAS_HOST_PORT=80`, `CANVAS_DOMAIN=localhost`.)
2. **2048-bit LTI signing keys.** Canvas's shipped dev keys are 512-bit; the JOSE
   verifier (and any modern verifier) rejects RS256 keys < 2048 bits. A real
   2048-bit JWK is in `config/dynamic_settings.yml` and bind-mounted at runtime.
3. **Privacy level `public`.** Otherwise launches omit name/email and the tool
   can't bridge a session. (Set by `scripts/create_dev_key.rb`.)
4. **Inline `public_jwk`, not `public_jwk_url`.** Canvas refuses to fetch an
   `http://` JWKS (`CanvasHttp::InsecureUriError`); the dev key embeds the tool's
   public JWK so no fetch happens. `run-e2e.sh` injects the tool's live JWK.
5. **Deploy the tool in the course context** (account-level didn't surface an
   in-course launch). `scripts/create_dev_key.rb` deploys to the seeded course
   and prints `TOOL_ID` for the launch URL.

---

## 1. What was built

| Item          | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| Canvas repo   | `instructure/canvas-lms`                                          |
| Pinned tag    | `release/2026-05-20.143` (latest stable release at build time)    |
| Pinned commit | `2e2b4a46d08e32667d4845f7b78e1214250345d3`                        |
| Base image    | `instructure/ruby-passenger:3.4-jammy`                            |
| Ruby / Rails  | Ruby 3.4 / Rails 8.0 (`CANVAS_RAILS=8.0`)                         |
| Node / Yarn   | Node 20 / Yarn 1.19.1                                             |
| Postgres      | 14 (client pinned by Canvas; server image `postgres:14-bookworm`) |
| Redis         | `redis:7-alpine`                                                  |
| `RAILS_ENV`   | **development** (see rationale below)                             |
| Image tag     | `ghcr.io/pawtograder/canvas-lms-e2e:2026-05-20.143` (+ `:latest`) |

Canvas releases are dated tags of the form `release/YYYY-MM-DD.NN`, cut roughly
every two weeks. We pinned the highest-numbered tag of the most recent release
date. Note `release/2026-05-20.143` is an **annotated** tag: its tag-object SHA
is `0e87d5c6…` and it points at commit `2e2b4a46…` — the commit is what the
image is built from.

### Why `RAILS_ENV=development`

The image **does** precompile assets (Ruby gems + JS/CSS are baked in, mirroring
Canvas's own `Dockerfile.production` build steps), so boot is fast either way.
We run the app in `development` because Canvas's containerized config samples
(`docker-compose/config/*`) ship a fully-populated `development` tree that
includes **pre-stubbed LTI signing JWKs** (`dynamic_settings.yml ->
store.canvas.lti-keys`). Those keys are exactly what LTI 1.3 launches need, and
they are not present in the `production`/`test` trees. Running `production` would
additionally require wiring `SECRET_KEY_BASE` and per-deployment encryption keys
in at asset-compile time. `development` avoids that friction for a throwaway test
instance while still serving via puma. If you ever need production semantics,
rebuild from `Dockerfile.production` and supply those secrets.

### How the image was built

`build.sh` does it all (clone at the pin → stage config → `docker build`):

```bash
tests/e2e/canvas/build.sh
```

It clones into `/home/researcher/canvas-build/canvas-lms` (override with
`CANVAS_SRC`), copies `tests/e2e/canvas/config/*.yml` into the build context as
`e2e-config/`, and builds with `tests/e2e/canvas/Dockerfile`. The build takes
~45+ min (bundle install + yarn install + `bin/rails canvas:compile_assets`).
We skip API-doc generation and all-locales i18n (`COMPILE_ASSETS_API_DOCS=0`,
`RAILS_LOAD_ALL_LOCALES=0`) to shorten the build; only English is compiled.

The config files baked into the image (in `config/`):
`database.yml`, `redis.yml`, `cache_store.yml`, `security.yml`,
`dynamic_settings.yml`, `domain.yml`, `delayed_jobs.yml`, `outgoing_mail.yml`.
They are templated to read connection details / secrets from env vars
(`CANVAS_DATABASE_HOST`, `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `CANVAS_DOMAIN`).

---

## 2. Boot the stack

```bash
cd tests/e2e/canvas
docker compose up -d          # postgres, redis, web (puma), jobs (delayed_job)
```

Services:

- **web** — Canvas, puma, on host port `${CANVAS_HOST_PORT:-80}` → container 3000.
  Healthcheck hits `/health_check` (returns `canvas ok` once fully booted).
- **jobs** — `script/delayed_job run`, the async worker (needed for AGS/grade
  processing, notifications, etc).
- **postgres** — `postgres:14-bookworm`, data in the `canvas-pg` volume.
- **redis** — `redis:7-alpine`.

Key env (all overridable; defaults in `docker-compose.yml`):

| Var                         | Default                      | Purpose                               |
| --------------------------- | ---------------------------- | ------------------------------------- |
| `CANVAS_HOST_PORT`          | `80`                         | host port for Canvas                  |
| `CANVAS_DOMAIN`             | `localhost`                  | domain Canvas builds URLs/cookies for |
| `CANVAS_ENCRYPTION_KEY`     | (dev placeholder, ≥20 chars) | `security.yml` encryption key         |
| `POSTGRES_PASSWORD`         | `sekret`                     | pg password                           |
| `CANVAS_LMS_ADMIN_EMAIL`    | `canvas@example.com`         | admin login                           |
| `CANVAS_LMS_ADMIN_PASSWORD` | `canvas-password`            | admin password                        |

---

## 3. Bootstrap (DB + admin + API token)

```bash
tests/e2e/canvas/bootstrap.sh
```

Idempotent. It runs `rake db:create` + `rake db:initial_setup` (which migrates
and, because `CANVAS_LMS_ADMIN_EMAIL` / `CANVAS_LMS_ADMIN_PASSWORD` are set in
the env, creates the site admin **non-interactively**), waits for
`/health_check`, then mints an admin API token and prints:

```
CANVAS_ADMIN_TOKEN=<token>
```

The token is **printed, never written to a committed file**. Export it for the
harness:

```bash
export CANVAS_ADMIN_TOKEN=$(tests/e2e/canvas/bootstrap.sh | grep '^CANVAS_ADMIN_TOKEN=' | cut -d= -f2)
```

To mint another token later:

```bash
docker compose -f tests/e2e/canvas/docker-compose.yml run --rm --no-deps -T web \
  bundle exec rails runner "$(cat tests/e2e/canvas/scripts/mint_admin_token.rb)"
```

---

## 4. Verify

```bash
PORT=${CANVAS_HOST_PORT:-80}

# Canvas is up
curl -fsS http://localhost:$PORT/health_check          # -> "canvas ok"

# API auth works
curl -fsS -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  http://localhost:$PORT/api/v1/accounts | head -c 400
```

---

## 5. Register the Pawtograder LTI 1.3 app in Canvas (runbook)

Pawtograder exposes the standard LTI 1.3 endpoints (adjust the base host):

| Role                            | URL                             |
| ------------------------------- | ------------------------------- |
| OIDC login init                 | `<PG_TOOL_HOST>/api/lti/login`  |
| Launch / target_link / redirect | `<PG_TOOL_HOST>/api/lti/launch` |
| Public JWKS                     | `<PG_TOOL_HOST>/api/lti/jwks`   |

> From inside the Canvas containers, reach a tool running on the Docker host as
> `http://host.docker.internal:3000` (the default in the scripts).

### 5a. Scriptable path (recommended)

Create + enable the developer key and deploy it to the root account in one shot.
This uses `Lti::CreateRegistrationService` — the same service Canvas's own
UI/API uses — and sets the **NRPS + AGS** scopes:

```bash
docker compose -f tests/e2e/canvas/docker-compose.yml run --rm --no-deps -T \
  -e PG_TOOL_HOST=http://host.docker.internal:3000 \
  web bundle exec rails runner "$(cat tests/e2e/canvas/scripts/create_dev_key.rb)"
```

Output:

```
CLIENT_ID=10000000000xxx
DEPLOYMENT_ID=<id>:<opaque>
ISSUER=https://canvas.instructure.com
```

- **`CLIENT_ID`** = the developer key's global id — the LTI 1.3 `client_id`.
- **`DEPLOYMENT_ID`** = the `deployment_id` for the tool installed in the root
  account. (Install in a specific course instead by editing the script to pass a
  `Course` as the context to `new_external_tool`.)
- **`ISSUER`** = the platform issuer (`security.yml` `lti_iss`), used in launches.

Scopes granted (override `PG_*` env to change URLs/name):

```
https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly   (NRPS)
https://purl.imsglobal.org/spec/lti-ags/scope/lineitem                      (AGS line items)
https://purl.imsglobal.org/spec/lti-ags/scope/score                         (AGS scores)
https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly               (AGS results, read)
```

Canvas LTI 1.3 platform endpoints the tool will use (host = `localhost:$PORT`):

| Purpose                              | URL                           |
| ------------------------------------ | ----------------------------- |
| OIDC auth (login redirect target)    | `/api/lti/authorize_redirect` |
| Public JWKS (platform keys)          | `/api/lti/security/jwks`      |
| OAuth2 token (AGS/NRPS client-creds) | `/login/oauth2/token`         |

### 5b. Developer-key JSON (UI path / reference)

In the UI: **Admin → Developer Keys → + Developer Key → + LTI Key**, choose
"Enter URL" or "Paste JSON", paste the config below, **Save**, then flip the key
**ON**. Then **Admin → Settings → Apps → + App → By Client ID**, paste the
`client_id`, install.

```json
{
  "title": "Pawtograder",
  "description": "Pawtograder LTI 1.3 tool",
  "oidc_initiation_url": "<PG_TOOL_HOST>/api/lti/login",
  "target_link_uri": "<PG_TOOL_HOST>/api/lti/launch",
  "public_jwk_url": "<PG_TOOL_HOST>/api/lti/jwks",
  "redirect_uris": ["<PG_TOOL_HOST>/api/lti/launch"],
  "scopes": [
    "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
    "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
    "https://purl.imsglobal.org/spec/lti-ags/scope/score",
    "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly"
  ],
  "extensions": [
    {
      "platform": "canvas.instructure.com",
      "privacy_level": "public",
      "settings": {
        "placements": [
          {
            "placement": "course_navigation",
            "message_type": "LtiResourceLinkRequest",
            "target_link_uri": "<PG_TOOL_HOST>/api/lti/launch",
            "text": "Pawtograder"
          }
        ]
      }
    }
  ]
}
```

### 5c. Getting the deployment_id later

After installing the tool in a context, the `deployment_id` is
`"<external_tool_id>:<opaque_context_id>"`:

```bash
docker compose -f tests/e2e/canvas/docker-compose.yml run --rm --no-deps -T web \
  bundle exec rails runner 'r=Lti::Registration.active.where(name:"Pawtograder").first; r.deployments.each{|t| puts t.deployment_id}'
```

---

## 6. Push to GHCR

```bash
# requires: docker login ghcr.io  (PAT with write:packages)
docker push ghcr.io/pawtograder/canvas-lms-e2e:2026-05-20.143
docker push ghcr.io/pawtograder/canvas-lms-e2e:latest
```

---

## 7. Files

| File                          | Purpose                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`                  | builds the asset-precompiled Canvas dev image                                      |
| `build.sh`                    | clone @ pin + stage config + docker build                                          |
| `docker-compose.yml`          | web + jobs + postgres + redis, healthchecked                                       |
| `bootstrap.sh`                | non-interactive DB setup + admin + token                                           |
| `config/*.yml`                | Canvas config baked into the image                                                 |
| `scripts/mint_admin_token.rb` | rails runner: create admin API token                                               |
| `scripts/create_dev_key.rb`   | rails runner: create+enable LTI 1.3 dev key, deploy, print client_id/deployment_id |

```

```
