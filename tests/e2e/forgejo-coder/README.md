# Sign in to Forgejo and Coder with Pawtograder (CW-04)

An end-to-end lane that runs Pawtograder, Forgejo and Coder together and walks the sign-in journeys
in a real browser. Pawtograder is the identity provider: Supabase Auth's OAuth 2.1 server issues the
tokens, and the consent page at `app/(auth-pages)/oauth/consent` asks the user to approve each app.

Owner: @nourshoreibah.

## Run it

```bash
npm run test:e2e:forgejo-coder        # boot everything, run the suite, tear down
KEEP_UP=1 npm run test:e2e:forgejo-coder   # leave the stack up afterwards
npm run test:e2e:forgejo-coder:only   # re-run the spec against a KEEP_UP stack (uses its Supabase keys, not .env.local)
```

Re-run faster with `SKIP_SUPABASE=1`, `SKIP_APPS=1`, `SKIP_BUILD=1` (reuse `.next`) or `SKIP_TOOL=1`. Extra arguments go to
Playwright (`run-e2e.sh --grep Coder`). It works on macOS (Docker Desktop) and on the Linux
`pawtograder-e2e` runner. In CI, run `.github/workflows/forgejo-coder-e2e.yml` with "Run workflow"
on the branch.

To run the same spec against a deployed release (the chart's `auth.oauthServer`, `coder.oidc` and
`forgejo.gitea.oauth` on, `scripts/setup-sso-clients.sh` run), use `run-remote.sh` with `kubectl`
access to its namespace. It creates `e2e-ignore-*` classes and users in that release's database:

```bash
tests/e2e/forgejo-coder/run-remote.sh --namespace cs4535-workspaces \
  --app-url https://app.workspaces.cs4535.ripley.cloud --api-url https://app-api.workspaces.cs4535.ripley.cloud \
  --forgejo-url https://git.workspaces.cs4535.ripley.cloud --coder-url https://coder.workspaces.cs4535.ripley.cloud
```

## What run-e2e.sh does

1. Starts its own Supabase from a copy of `supabase/` in `SSO_E2E_WORKDIR` (default
   `$TMPDIR/pawtograder-sso-e2e`, outside the repo so test runners don't pick up the copy) with project id
   `pawtograder-sso-e2e`, every port shifted by `SB_PORT_OFFSET` (default 2000, so the API is on 56321) and `site_url` set to the lane's Next server. GoTrue sends the browser to `site_url` for
   consent, so the lane can't share a developer's stack, whose `site_url` is their own dev server.
2. Registers Forgejo and Coder as OAuth clients (`tests/e2e/sso/register-oauth-clients.ts`).
3. Starts Forgejo and Coder (`docker-compose.yml`), creates the Forgejo admin and the `pawtograder`
   login source, and creates Coder's first owner.
4. Builds Pawtograder and serves it with `next start` on `PAW_PORT` (default 3300).
5. Writes `tests/e2e/sso/.forgejo-coder-e2e.json` and runs `playwright.forgejo-coder.config.ts`.

| Service     | Browser URL                    |
| ----------- | ------------------------------ |
| Pawtograder | http://127.0.0.1:3300          |
| Issuer      | http://127.0.0.1:56321/auth/v1 |
| Forgejo     | http://127.0.0.1:3100          |
| Coder       | http://127.0.0.1:7080          |

## Journeys

`tests/e2e/sso/sso.forgejo-coder.spec.ts`, run in order:

1. Forgejo, already signed in to Pawtograder. The user approves on the consent page and Forgejo
   creates an account bound to the `pawtograder` login source.
2. Forgejo, cold start. With no Pawtograder session, consent sends the user to sign in and back.
3. Forgejo, deny. No account is created.
4. Forgejo, repeat sign-in. GoTrue remembers the consent and the user gets the same account.
5. Coder, already signed in. Coder creates an `oidc` account.
6. Coder, cold start and deny.
7. GoTrue refuses an authorize request whose `redirect_uri` isn't registered.

## Things this lane found

- **GoTrue requires PKCE on every authorize request**, with no setting to turn that off
  (`validatePKCEParams` in supabase/auth). Coder sends PKCE. Forgejo 15 sends it for
  `openidConnect` sources, except on the first sign-in after a source is added through the CLI: the
  running server registers the provider lazily, after it has already decided there is no provider to
  generate a challenge for. That first user gets an error. `run-e2e.sh` makes one warm-up request
  after adding the source; any production bootstrap has to do the same, or restart Forgejo.
- **Forgejo `DISABLE_REGISTRATION: true` (the chart's setting) doesn't block sign-in.** OAuth
  auto-registration is gated only by `[oauth2_client] ENABLE_AUTO_REGISTRATION`.
- **GoTrue puts the email in the `name` claim**, because Pawtograder users have no name in
  `user_metadata`. Forgejo derives the username from the email (`[oauth2_client] USERNAME = email`).
- **The installed supabase-js predates `auth.oauth.*`**, so `lib/oauthServer.ts` and the client
  registration script call GoTrue's REST API directly.

## Networking

The ID token's `iss` must equal the issuer URL that Forgejo and Coder discover, and the browser has to
reach the same URL. Forgejo and Coder share the network namespace of the `loopback` container, where
socat listens on `127.0.0.1:<SB_API_PORT>` and forwards to the host. Inside those containers
`127.0.0.1:56321` is the same Supabase the browser uses, without `network_mode: host` (which Docker
Desktop doesn't support well).

Every service uses `127.0.0.1`, so the browser sends all cookies for that host to every port. The
apps' cookie names don't collide.

## Out of scope

Coder workspaces (the chart's template needs Kubernetes), mapping course roles to Forgejo teams or
Coder groups (`custom_access_token_hook` adds no role claims yet), binding the accounts that #1083
pre-provisions, and single sign-out.
