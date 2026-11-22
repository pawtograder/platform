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

Re-run faster with `SKIP_SUPABASE=1`, `SKIP_APPS=1`, `SKIP_BUILD=1` (reuse `.next-sso-e2e` if its `NEXT_PUBLIC_*` values still match) or `SKIP_TOOL=1`. Extra arguments go to
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

`tests/e2e/sso/sso.forgejo-coder.spec.ts`, run in order. The lane runs as the chart does with
`auth.oauthServer.autoApproveFirstParty` and `forgejo.signInRedirect` on: `run-e2e.sh` sets
`OAUTH_FIRST_PARTY_REDIRECT_URIS` to both apps' callbacks and mounts `files/forgejo/header.tmpl` into
Forgejo. Nothing clicks Authorize for Forgejo or Coder, so reaching the app shows no consent page
stopped the flow. `run-remote.sh` reads both settings from the release and runs the journeys that fit.

1. Forgejo, already signed in to Pawtograder. `/user/login` goes straight to Pawtograder and Forgejo
   creates an account bound to the `pawtograder` login source.
2. Forgejo, cold start. With no Pawtograder session, the user signs in and goes on to Forgejo.
3. Forgejo, deny. No account is created. Runs only without auto-approval.
4. Forgejo, repeat sign-in. The user gets the same account.
   4b. `/user/login?password_login=1` keeps Forgejo's own sign-in page.
5. Coder, already signed in. The test first creates the user's Coder account the way
   `workspace-open` does (#1222): an `oidc` user whose email is `<user id>@coder.pawtograder.invalid`.
   The sign-in lands on that account and binds it to the user's id.
6. Coder: cold start; deny, which leaves the account unbound and runs only without auto-approval;
   and a new Pawtograder account that took another user's old email. That user's Coder account still
   has the real email, and the new account doesn't get it: Coder refuses the sign-in.
7. GoTrue refuses an authorize request whose `redirect_uri` isn't registered.
8. A third client named `Coder` with its own callback still gets the consent page, and Deny sends
   `error=access_denied` back to it.

`tests/e2e/sso/forgejo-provisioning.forgejo-coder.spec.ts` (#1092, #1093) runs first:

1. One `forgejo-reconciler` pass creates a student's Forgejo account and their repo for a released
   Forgejo assignment, with write access. A second pass changes nothing. The lane has no edge
   runtime, so the spec runs the pass with `deno` (`supabase/functions/forgejo-reconciler/run-pass.ts`).
2. The student's first sign-in lands on that account and shows the repo.

## Cloud workspaces journey

`tests/e2e/sso/cloud-workspaces-journey.forgejo-coder.spec.ts` (#1103, #1105) runs first, once for a Forgejo
assignment and once for a GitHub one: the instructor turns Cloud workspaces on from Feature flags, the student
gets their repository, clicks Open in Coder, follows the link to sign in to Coder (and, for GitHub, to link the
GitHub account), opens again and watches the progress card reach ready, with the repository cloned in the
workspace at its head. Then the student pushes a `#submit` commit from the workspace (`coder ssh`). On Forgejo
the org's push hook reaches `forgejo-repo-webhook`, which records the commit. On GitHub the submission is
created and graded through `autograder-create-submission` and `autograder-submit-feedback`, and the score shows
on the assignment page. Last, the instructor turns the flag off and Open in Coder is gone.

What the lane adds for it (`run-e2e.sh`, `docker-compose.yml`):

- **`functions`**: the edge functions the journey reaches, unmodified, under Deno (`functions-router.ts`), in
  the loopback container's network namespace, on `FUNCTIONS_PORT` (3150). The lane still has no edge runtime
  behind Kong, so the spec routes the browser's `<SUPABASE_URL>/functions/v1/**` calls to it, and the
  reconciler pass gives each class org a push hook to it (`SUPABASE_PUBLIC_URL`, `FORGEJO_WEBHOOK_SECRET`).
- **A `kubernetes` template** (`coder-template/main.tf`): the chart's template with its parameters, clone.sh,
  startup script and code-server app, but no pod. Terraform hands each workspace's agent token and init script
  to the **`workspace`** container (the chart's `coder-workspace` image) through `/agents`, and
  `workspace-agents.sh` runs the agent. Agent logs land in `.logs/agents/`.
- **GitHub, played by Forgejo.** GitHub can't be reached, so Coder's GitHub external-auth slot
  (`CODER_GITHUB_AUTH_ID=github`) is a `gitea` provider backed by a Forgejo OAuth app, and `GITHUB_URL` is the
  same Forgejo under `http://localhost:3100`, a different origin from the Forgejo host, as github.com is. The
  GitHub assignment's repository and its `repositories` row are seeded where GitHub would have created them.
  The GitHub push webhook's check run row and the Actions run's job token are the suite's usual e2e stand-ins
  (`E2E_MOCK_GITHUB`, the `pawtograder-playground/test-e2e-student-repo` prefix).
- **`E2E_ENABLE=true` on the lane's Next server**, for `/api/e2e/revalidate-course`, which stands in for the
  classes cache webhook after each flag change.

Not covered: grading a Forgejo push, which needs a Forgejo Actions runner to run grade.yml (marked `fixme`),
and workspaces on Kubernetes. The workspace image is amd64-only, so on Apple Silicon it runs under emulation.

The lane's Coder uses the chart's OIDC settings (`charts/pawtograder/templates/app-databases.yaml`):
sign-ups off, and the email read from the access token's `coder_email` claim
(`CODER_OIDC_EMAIL_FIELD`, `CODER_OIDC_ACCESS_TOKEN_CLAIMS`, `CODER_OIDC_IGNORE_USERINFO`,
`CODER_OIDC_EMAIL_DOMAIN`, `CODER_OIDC_USERNAME_FIELD=sub`). Change them in both places.

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

Workspaces on Kubernetes (the journey runs the chart's template's workspace in a container), mapping course roles to Forgejo teams or
Coder groups (`custom_access_token_hook` adds no role claims yet), and single sign-out.
