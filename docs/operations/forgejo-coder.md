# Cloud Workspaces operations on staging

The staging configuration checked in at `1696ad7a` (chart 0.4.13). Production
leaves both apps off. Run the [live checks](#live-checks) first. Chart
reference: "Forgejo and Coder (optional)" in
[`charts/pawtograder/README.md`](../../charts/pawtograder/README.md).

| Component                      | Runs as                                                                     | Namespace                        |
| ------------------------------ | --------------------------------------------------------------------------- | -------------------------------- |
| Forgejo 15.0.9                 | Deployment `pawtograder-forgejo`, 20Gi PVC, Recreate strategy               | `pawtograder-staging`            |
| Coder 2.37.3                   | Deployment `coder`, hook Job `pawtograder-coder-bootstrap`                  | `pawtograder-staging`            |
| Forgejo and Coder databases    | Databases `forgejo` and `coder` on `pawtograder-postgres`                   | `pawtograder-staging`            |
| Actions dispatcher             | Deployment `pawtograder-forgejo-runner`                                     | `pawtograder-staging`            |
| Actions job pods               | One pod per job, label `app.kubernetes.io/component=forgejo-job`            | `pawtograder-staging-actions`    |
| Workspaces                     | Pods and PVCs made by Coder, label `app.kubernetes.io/name=coder-workspace` | `pawtograder-staging-workspaces` |
| Reconciler, webhook, workspace | Edge functions in Deployment `pawtograder-functions`                        | `pawtograder-staging`            |

```bash
NS=pawtograder-staging   # the release must be named pawtograder
kubectl -n "$NS" exec -it pawtograder-postgres-0 -c postgres -- psql -U supabase_admin -d postgres
# One function's logs across all functions pods, stable and canary (a selector otherwise keeps 10 lines per pod).
kubectl -n "$NS" logs -l 'app.kubernetes.io/instance=pawtograder,app.kubernetes.io/component in (functions,functions-canary)' \
  --since=2h --tail=-1 --prefix --max-log-requests=20 | grep '<function-name>'
```

Per-function HTTP counts are in
`pawtograder_edge_requests_total{function="<name>",status="<code>"}`. They
can't tell a skipped or failed operation that answered 200 from a success.

Run the commands in this document one at a time and read each output. They
aren't scripts and don't stop on an error. A command that prints an error has
failed, however the lines after it look. Comparisons print hashes, never
secrets. `e3b0c442…` is the hash of an empty read, which means the read
failed. In `psql`, `\g` submits the query above it.

## Live checks

1. Every stable and canary functions pod needs the values below. Compare
   `FORGEJO_AUTH_SOURCE_ID` to the ID of the `pawtograder` login source. Staging
   sets `forgejo.authSourceId: 1`. Check the live ID before relying on it.
   The chart sets the app URLs and reads Forgejo's admin credentials from
   `pawtograder-forgejo-admin`. With Forgejo on, the render refuses
   `FORGEJO_URL`, `FORGEJO_ADMIN_USERNAME`, `FORGEJO_ADMIN_PASSWORD` and
   `FORGEJO_AUTH_SOURCE_ID` in `edgeFunctions.extraEnv`. GitHub workspace
   support adds `CODER_GITHUB_AUTH_ID` from `coder.externalAuth.github.id`.
   The check prints only names, presence and the two provider IDs.

```bash
kubectl -n "$NS" rollout status deploy/pawtograder-functions --timeout=60s
kubectl -n "$NS" rollout status deploy/pawtograder-functions-canary --timeout=60s
kubectl -n "$NS" get deploy pawtograder-functions pawtograder-functions-canary
SEL='app.kubernetes.io/instance=pawtograder,app.kubernetes.io/component in (functions,functions-canary)'
kubectl -n "$NS" get pod -l "$SEL"
for p in $(kubectl -n "$NS" get pod -l "$SEL" -o name)
do
  echo "== $p"
  kubectl -n "$NS" exec "$p" -c functions -- sh -c 'for v in FORGEJO_URL FORGEJO_ADMIN_USERNAME FORGEJO_ADMIN_PASSWORD \
      FORGEJO_WEBHOOK_SECRET CODER_URL CODER_API_TOKEN
    do
      [ -n "$(printenv "$v")" ] && echo "$v ok" || echo "$v MISSING"
    done
    echo "FORGEJO_AUTH_SOURCE_ID=$(printenv FORGEJO_AUTH_SOURCE_ID)"
    echo "CODER_GITHUB_AUTH_ID=$(printenv CODER_GITHUB_AUTH_ID)"' || echo "exec FAILED"
done
kubectl -n "$NS" exec deploy/pawtograder-forgejo -c forgejo -- forgejo admin auth list
```

The check passes only when no command printed an error, both rollouts report
`successfully rolled out`, each Deployment's `READY` column shows a desired
count that isn't 0 and is fully ready (`2/2`, not `0/0` or `1/2`), the pod
list holds that many pods for each, every pod in the list is `Running` and
Ready, each pod has an `==` block with six `ok` lines and no `exec FAILED`,
and every `FORGEJO_AUTH_SOURCE_ID` equals the ID in the `pawtograder` row of
the last table. Check that every `CODER_GITHUB_AUTH_ID` is `github`. Treat an
empty pod list, a blank ID or a missing `pawtograder` row as a failed check.

2. In the course organization's settings, find the active JSON push hook at
   `https://api.staging.pawtograder.net/functions/v1/forgejo-repo-webhook`.
   Provisioning checks or creates it when it calls `ensureOrg` with the
   webhook Secret set. An existing org with no provisioning work may need
   the hook checked by hand. Check recent deliveries after changing it.

When an authenticated call finds `FORGEJO_URL`, the admin credentials or a
positive source ID missing, the reconciler logs `Skipped: FORGEJO_URL, admin
credentials or auth source id unset` and answers 200. Without
`FORGEJO_WEBHOOK_SECRET` the webhook answers 500. Without `CODER_API_TOKEN` the
workspace functions answer 503. For a Forgejo repository, the staff file tools
(`repository-get-file`, `repository-list-files`, `repository-write-file`) and
Test Assignment's "Create my test repo" answer 503 `Forgejo is not set up on
this deployment` without the Forgejo values.

To supply the two edge Secrets, write OpenBao with
`scripts/setup-openbao-edge-functions.sh --env staging --bundle forgejo-webhook --from-file <file>`
(key `FORGEJO_WEBHOOK_SECRET` at `kv/apps/pawtograder/forgejo-webhook-staging`)
or `--bundle coder-api` (key `CODER_API_TOKEN` at
`kv/apps/pawtograder/coder-api-staging`). Add ExternalSecrets
`pawtograder-forgejo-webhook` and `pawtograder-coder-api` outside the chart.
Once `kubectl -n "$NS" get externalsecret` shows them synced, restart both
functions Deployments and wait for each:

```bash
kubectl -n "$NS" rollout restart deploy/pawtograder-functions deploy/pawtograder-functions-canary
kubectl -n "$NS" rollout status deploy/pawtograder-functions
kubectl -n "$NS" rollout status deploy/pawtograder-functions-canary
```

Then repeat check 1 and test a push and a workspace request.

## Forgejo

Students can't sign in, clone or push to `https://git.staging.pawtograder.net`,
or `deploy-staging` in `release-images.yml` fails with Forgejo unready.

```bash
curl -fsS https://git.staging.pawtograder.net/api/v1/version
kubectl -n "$NS" describe deploy pawtograder-forgejo
kubectl -n "$NS" describe pod -l app.kubernetes.io/name=forgejo          # init container statuses
kubectl -n "$NS" logs <forgejo pod> -c <failing container> --previous   # --previous after a restart
PVC=$(kubectl -n "$NS" get deploy pawtograder-forgejo \
  -o jsonpath='{.spec.template.spec.volumes[?(@.name=="data")].persistentVolumeClaim.claimName}')
kubectl -n "$NS" describe pvc "$PVC"
```

Forgejo keeps its database `forgejo` on `pawtograder-postgres` and its
repositories, `app.ini` and avatars on the PVC. An init container that fails
every start usually means `pawtograder-forgejo-oauth` is missing or
`https://api.staging.pawtograder.net/auth/v1/.well-known/openid-configuration`
doesn't answer 200. Or the database refuses Forgejo: read
`kubectl -n "$NS" logs job/pawtograder-app-databases-<revision> -c forgejo`
(`get jobs -l app.kubernetes.io/component=app-databases`). Finished Jobs go
after a day. `\du forgejo` shows role attributes, not whether the password
works. Rotate a password in the order under "Secrets" in the chart README.
`PawtograderPostgresUnavailable` fires after the primary StatefulSet has had
no ready replica for 5 minutes, if kube-state-metrics is scraped.

`kubectl -n "$NS" rollout restart deploy/pawtograder-forgejo` takes Forgejo
down until the new pod is ready. Pushes then fail and succeed on retry. For a
bad release, decide with [rollback.md](./rollback.md) and review the staging
manifest and any schema change before applying.

Database. `postgres.walg` and the standby cover `forgejo` and `coder`, which
write to the same primary as Pawtograder. **There is no tested database
recovery procedure with Forgejo and Coder running.**
[point-in-time-recovery.md](./point-in-time-recovery.md) and
[planned-maintenance.md](./planned-maintenance.md) predate both apps and are
written for production. Until someone works out a staging procedure and runs
it as a drill, treat the points below as constraints any recovery must meet,
not as steps:

- **Namespace and values.** Set `NS=pawtograder-staging` and use staging
  values everywhere. Never copy the runbooks' `pawtograder-prod` or production
  values files. `maintenance.sh` without `-n "$NS"` acts on
  `pawtograder-prod`.
- **Both apps write to the primary.** Stop them before the writer fence, and
  keep them at zero until the cutover is done:

```bash
kubectl -n "$NS" get deploy pawtograder-forgejo coder        # record the replica counts
kubectl -n "$NS" scale deploy pawtograder-forgejo coder --replicas=0
kubectl -n "$NS" get pod -l 'app.kubernetes.io/name in (forgejo,coder)'   # repeat until none remain
```

- **Every `helm upgrade` in those runbooks touches both apps.** That covers
  the maintenance page, the bounce and migrations. Each runs the Coder
  bootstrap and Forgejo mirror hooks, which need the apps up, and the
  `app-databases` Job, which writes roles to the primary. Stage the page
  before stopping the apps, and wait for its hooks and Job to finish. If the
  primary is already down, stop both apps and skip the page. Don't run a
  fenced upgrade with the apps enabled until a procedure says how.
- **A restore can rewind credentials.** The `forgejo` and `coder` roles,
  Pawtograder's OAuth clients and the stored tokens can go back to older
  values while the Kubernetes Secrets keep the current ones. Before reopening,
  run the live checks, then the checks under
  [Sign in with Pawtograder](#sign-in-with-pawtograder-oidc), then verify
  Forgejo user secrets and GitHub external auth under [Coder](#coder). Check
  the runner tokens under
  [Forgejo Actions runner](#forgejo-actions-runner).
- **What is lost.** After a promotion, unreplicated writes are lost from all
  three databases. After a point-in-time restore, writes after the target are
  lost. Coder forgets workspaces created after it, but their pods and homes
  stay.
- **Before writes resume,** compare Forgejo's on-disk repositories, and
  Coder's pods and homes, with the recovered records. Lift Pawtograder's fence
  first, because Forgejo and Coder sign in through Auth. Then scale both back
  to the recorded counts.

Volume. The nightly `pawtograder-backup-forgejo` Job writes a matching
`daily/forgejo-<TS>.dump` and `daily/forgejo-<TS>.tar.gz` to the staging backup
bucket. The archive holds the on-volume repositories, `app.ini` and other
local data. `pawtograder-backup-coder` dumps the Coder database. Workspace
home PVCs need their own backup.

```bash
kubectl -n "$NS" get cronjob pawtograder-backup-forgejo pawtograder-backup-coder pawtograder-backup-verify
kubectl -n "$NS" get jobs --sort-by=.metadata.creationTimestamp
VERIFY_JOB='<replace-with-job-name>'
kubectl -n "$NS" logs job/"$VERIFY_JOB"
```

Choose the latest Job owned by the verifier CronJob. The verifier checks
dump age and readability,
looks for the repository root and `app.ini` in the Forgejo archive, and
fails on a set with an `.incomplete` marker. Use the same timestamp for the
dump and archive. The chart README section "Restoring Forgejo" covers the
volume restore. The optional restore drill checks throwaway databases and
repository connectivity. Staging has verify on and the restore drill off.

## Sign in with Pawtograder (OIDC)

Students see Forgejo's or Coder's sign-in error page. Check
`https://api.staging.pawtograder.net/auth/v1/.well-known/openid-configuration`
answers 200, then match each app's client ID (key `key` of
`pawtograder-forgejo-oauth`, `CODER_OIDC_CLIENT_ID` of `pawtograder-coder-oidc`)
to a live row. Other releases may reuse the client names.

```sql
-- Both live (deleted_at null). Forgejo: .../user/oauth2/pawtograder/callback. Coder: named Coder, .../api/v2/users/oidc/callback.
SELECT id, client_name, redirect_uris, deleted_at FROM auth.oauth_clients WHERE id::text IN ('<forgejo id>', '<coder id>') \g
```

GoTrue's OAuth server signs users in to Forgejo (login source `pawtograder`)
and Coder (`CODER_OIDC_*`, issuer `https://api.staging.pawtograder.net/auth/v1`).
Sign-in reaches only existing accounts: the reconciler creates course users,
and the chart creates the Forgejo admin from `pawtograder-forgejo-admin`.
Forgejo's `/user/login` follows its only OAuth link unless the page shows an
error. `?password_login=1` reaches the admin login. The access token hook adds
`coder_email` for a live client named `Coder` whose redirect ends
`/api/v2/users/oidc/callback`, and Coder matches a first sign-in by that email.
`PawtograderExternalSecretNotReady` fires after an ExternalSecret is
`Ready=False` for 15 minutes, if ESO's `externalsecret_status_condition` series
is scraped, but a broken login can leave the Secret healthy.

To replace a client, pass only the affected app's URL, so the other app's
users don't have to sign in or consent again. The script defaults to
namespace `pawtograder`.

```bash
# Forgejo's client only
NAMESPACE="$NS" scripts/setup-sso-clients.sh --api-url https://api.staging.pawtograder.net \
  --forgejo-url https://git.staging.pawtograder.net
# Coder's client only
NAMESPACE="$NS" scripts/setup-sso-clients.sh --api-url https://api.staging.pawtograder.net \
  --coder-url https://coder.staging.pawtograder.net
```

It writes OpenBao (`BAO_ADDR`/`BAO_TOKEN`), waits for the Secret and the app's
rollout, then revokes the old client. A failed revoke exits non-zero and leaves
that client to delete by hand. Retry sign-ins in flight. New clients need
consent again where auto-approval is off. No repository or home is touched.

## Coder

Workspaces at `https://coder.staging.pawtograder.net` don't open or clone, or
the deploy fails on the bootstrap Job or on coderd exiting. The bootstrap Job
is a post-upgrade hook, and the staging upgrade runs without `--atomic`, so
when it fails the upgraded workloads are already running. A red deploy doesn't
mean the new version didn't ship. Check what is serving before you redeploy
(#1357).

```bash
helm -n "$NS" history pawtograder --max 3
kubectl -n "$NS" get deploy -o wide                     # IMAGES shows the tags serving now
kubectl -n "$NS" get deploy,pod -l app.kubernetes.io/name=coder
kubectl -n "$NS" logs deploy/coder -c first-owner
kubectl -n "$NS" logs deploy/coder --since=1h
kubectl -n "$NS" logs job/pawtograder-coder-bootstrap   # kept only after a failure
kubectl -n "$NS" get externalsecret,secret pawtograder-coder-external-auth
curl -fsS https://coder.staging.pawtograder.net/healthz
kubectl -n pawtograder-staging-workspaces get pod,pvc -l app.kubernetes.io/name=coder-workspace
```

The `first-owner` init container creates the owner from
`pawtograder-coder-admin`. The `pawtograder-coder-bootstrap` hook pushes the
`kubernetes` template and its schedule on every install, upgrade and rollback.
With GitHub external auth enabled, coderd and `first-owner` need the App
client in `pawtograder-coder-external-auth`. Forgejo credentials come from
Coder user secrets. Each path has its own checks below.

For one workspace, sign in as the owner (`pawtograder-coder-admin`) and read
its build and agent logs. Restart with `kubectl -n "$NS" rollout restart
deploy/coder`, also needed after any OIDC or external auth change. If the hook
can't log in, `pawtograder-coder-admin`'s email and username must still be the
first owner's. Fix the cause and reapply the release to rerun the hook.

### Forgejo user secrets

On create or restart through Pawtograder, `workspace-open` looks up the
student's Forgejo login on the configured instance. It records the grant in
`forgejo_repo_tokens`, mints a token scoped to that repo, and uses a short-lived
Coder user key to write `git_credentials_repo_<repository id>` and `git_email`.
Coder writes them at startup to `/home/coder/.git-credentials-<owner>--<repo>`
and `/home/coder/.git-email`. Coder puts all of the owner's secrets in each of
their workspaces. Each Forgejo token is scoped to its own repo.

For `credentials_unavailable`, check the student's Forgejo login, live check
1 and the `workspace-open` Sentry event for token mint or Coder secret errors.
For a clone error, check that the expected file exists and is nonempty without
reading its contents. A running workspace needs a restart to receive a new
secret. Open it again from Pawtograder after correcting the cause. The
reconciler revokes dropped students' tokens and tokens idle for 14 days.

### GitHub external auth

With `coder.externalAuth.github.enabled`, provider 0 has ID `github`.
The Pawtograder GitHub App needs
`https://coder.staging.pawtograder.net/external-auth/github/callback` as a
callback and access to the course repo. The student accepts the course org
invite and links GitHub in Coder. The Coder agent supplies the token through
`GIT_ASKPASS`. This link is optional in the template, so it only matters for
GitHub repos. Coder sign-in itself still uses Pawtograder OIDC.

Compare the Secret hash pairs below with the configured OpenBao path. If they
match and Coder still can't authenticate, verify the credentials belong to
the configured GitHub App and confirm the callback URL. If the App credentials
changed, update both fields at `forgejoCoderSecrets.externalSecret.coderExternalAuthPath`,
wait for ESO, compare the hashes, then restart Coder. A missing client ID
prevents Coder from starting. A bad secret, callback or App grant breaks GitHub
linking or the clone.

```bash
kubectl -n "$NS" get secret pawtograder-coder-external-auth -o jsonpath='{.data.CODER_EXTERNAL_AUTH_0_CLIENT_ID}' | base64 -d | sha256sum
bao kv get -mount=kv -field=client_id apps/pawtograder/coder-external-auth-staging | sha256sum
kubectl -n "$NS" get secret pawtograder-coder-external-auth -o jsonpath='{.data.CODER_EXTERNAL_AUTH_0_CLIENT_SECRET}' | base64 -d | sha256sum
bao kv get -mount=kv -field=client_secret apps/pawtograder/coder-external-auth-staging | sha256sum
kubectl -n "$NS" rollout restart deploy/coder
kubectl -n "$NS" rollout status deploy/coder
```

Restarting the Coder Deployment leaves workspace pods and homes in place. A stop deletes the workspace pod and
keeps its home PVC, losing files outside `/home/coder`. Unpushed work lives only
on that PVC, which nothing backs up and which is deleted with the workspace.

## Forgejo Actions runner

Jobs sit "Waiting" in the Actions tab, or the deploy fails on the
`pawtograder-forgejo-action-mirrors` hook.

```bash
kubectl -n "$NS" logs deploy/pawtograder-forgejo-runner --since=1h
kubectl -n "$NS" get externalsecret,secret pawtograder-forgejo-runner-token pawtograder-forgejo-mirror-token
kubectl -n pawtograder-staging-actions get pod -l app.kubernetes.io/component=forgejo-job
kubectl -n pawtograder-staging-actions get events --sort-by=.lastTimestamp | tail -20
kubectl -n "$NS" logs job/pawtograder-forgejo-action-mirrors -c mirrors   # kept only after a failure
```

The dispatcher polls Forgejo and starts one pod per waiting job in
`pawtograder-staging-actions`. Bare `uses:` names resolve to mirrors kept by
the hook. A refused pod create (quota) leaves the job queued. For Forgejo
errors, check the dispatcher Secret synced and its token is valid with
`write:admin`. For a failed mirror hook, check the entry's `url` and `ref`
before retrying the upgrade. A dispatcher restart leaves job pods and queued
jobs alone. If a job starts but grading fails, check the handout has
`.github/workflows/grade.yml` with `enable-openid-connect: true` and the public
API as `grading_server`. The edge function reads the submission archive from
Forgejo and fetches the grader from GitHub. For a single rerun, the selected
commit needs the workflow file. Bulk reruns dispatch on the repository's host.

Tokens live in `kv/apps/pawtograder/forgejo-runner-staging`. For first setup,
run the first command without `--rotate`. To rotate, run the steps in order. Old
tokens stay valid until step 4. In step 3, a job already running uses its own
ephemeral token and proves nothing.

```bash
# 1. Mint new tokens.
scripts/setup-forgejo-runner-tokens.sh --env staging --forgejo-url https://git.staging.pawtograder.net --rotate
# 2. Once ESO syncs, each pair of hashes must match, and none may be e3b0c442….
kubectl -n "$NS" get secret pawtograder-forgejo-runner-token -o jsonpath='{.data.token}' | base64 -d | sha256sum
bao kv get -mount=kv -field=dispatcher_token apps/pawtograder/forgejo-runner-staging | sha256sum
kubectl -n "$NS" get secret pawtograder-forgejo-mirror-token -o jsonpath='{.data.token}' | base64 -d | sha256sum
bao kv get -mount=kv -field=mirror_token apps/pawtograder/forgejo-runner-staging | sha256sum
# 3. Restart, wait, then queue a new job and confirm a pod starts for it.
kubectl -n "$NS" rollout restart deploy/pawtograder-forgejo-runner
kubectl -n "$NS" rollout status deploy/pawtograder-forgejo-runner
```

Revoke the old tokens only after both hash pairs matched in step 2, the
rollout finished, and a newly queued job started in step 3. On a nonzero exit,
check the token names it reports and run it again on its own.

```bash
# 4. Revoke the old tokens.
scripts/setup-forgejo-runner-tokens.sh --env staging --forgejo-url https://git.staging.pawtograder.net --revoke-old
```

## forgejo-reconciler (accounts and repositories)

The roster's Forgejo Username column shows "Not created yet", a student or
group has no repository, or the assignment page lists a Forgejo repository as
"(waiting for access)" (`is_github_ready` false). Sentry events carry
`function=forgejo-reconciler`.

```sql
-- Did pg_cron enqueue the pass? Success here says nothing about the function.
SELECT status, return_message, start_time FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'forgejo-reconciler') ORDER BY start_time DESC LIMIT 5 \g
-- Eligible account candidates, capped at 10,000, excluding claims under 10 minutes old.
SELECT count(*) FROM public.forgejo_accounts_needed('https://git.staging.pawtograder.net', 10, 10000) \g
-- Student repositories still owed (forgejo_group_repos_needed has the same arguments).
SELECT * FROM public.forgejo_repos_needed('https://git.staging.pawtograder.net', 50) \g
```

Then `grep forgejo-reconciler` in the logs for the summary line and errors,
which keep Forgejo's status and a known reason such as `e-mail already in use`.

One pass creates up to 50 accounts, 50 student repositories and 50 group
repositories, fills up to 50 missing `grade.yml` hashes and processes up to
100 workspace token revocations. pg_cron enqueues a
pass at minute 41 hourly (job `forgejo-reconciler`). Triggers enqueue one when
someone joins a flagged class, the flag turns on, a Forgejo assignment is
released, a group gains a member, or an enrollment with tokens is disabled
or removed. Any repository needs a released Forgejo
assignment with `repo_mode = 'template_only_staff'` and a `template_repo`
marked as a template in the class's Forgejo organization (`classes.forgejo_org`,
or the slug). A student repository also needs an active student with a Forgejo
login, and either an `individual` assignment or a `both` assignment where the
student is in no group. Group repositories need `group_config` `groups` or
`both`. No pass makes a staff member's Test Assignment repository.
`autograder-create-repos-for-student` makes it the same way when they press
"Create my test repo", with them as the writer.

Failures send one Sentry event per kind per pass, fingerprinted
`forgejo-reconciler` plus `provision-failed`, `repo-failed` (with
`assignment_id` and `profile_id`), `group-repo-failed` or
`workflow-hash-failed` or `revoke-failed`, with up to 20 IDs. A pass that throws sends one event
and answers 500. A skip sends nothing.

- `The template repo isn't in the class's Forgejo org`: move the handout or
  correct `template_repo` or `classes.forgejo_org`.
- `The Forgejo org has an owner other than Pawtograder's admin`: also raised
  when the configured admin isn't an owner. Confirm it's the intended course
  org, then make the configured admin its sole owner, or point
  `classes.forgejo_org` at a dedicated org if the existing owners must keep
  access.
- `The handout has no .github/workflows/grade.yml`: add it.

Then submit `SELECT public.invoke_forgejo_reconciler_background_task()` in `psql` and read
the next summary line. A pass adopts existing accounts, repositories and
grants, so confirm the course organization and inspect any unexpected
repository first. A failed account is retried once its claim is 10 minutes
old. 300 new accounts take at least six successful passes.

## Push webhook (`forgejo-repo-webhook`)

A student's commit history in Pawtograder is missing pushes. Read the hook's
recent deliveries in Forgejo, the function's logs,
`pawtograder_edge_requests_total{function="forgejo-repo-webhook",status=~"4..|5.."}`,
and Sentry events tagged `webhook_source=forgejo`. Only handler errors,
ambiguous repository names and a missing head commit reach Sentry (the last two
answer 200), so a missing Secret, a wrong secret or a missing hook leaves no
trace there.

Forgejo calls this function on each push. It checks the HMAC signature
against `FORGEJO_WEBHOOK_SECRET`, finds the repository by
`git_provider = 'forgejo'` and name, and writes one `repository_check_runs` row
per default-branch commit, one commit at a time: the student's commit history.
Forgejo Actions runs grading separately.

| Response                                                   | Cause                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 500 `Forgejo webhooks are not configured`                  | `FORGEJO_WEBHOOK_SECRET` or `FORGEJO_URL` unset in the pod                                                              |
| 401 `Unauthorized`                                         | The signature is missing or doesn't match the hook's secret                                                             |
| 400 `Body is not JSON` / `Not a push payload`              | The hook sends a form body, or the payload is malformed                                                                 |
| 403 `Repository is not on the configured Forgejo instance` | `html_url` isn't under `FORGEJO_URL`                                                                                    |
| 500 `Error processing webhook`                             | Handler failure. See Sentry. Commits before the failing one may already be recorded                                     |
| 200, no row                                                | Not a push or student repository, other branch, pull-request mode, an assignment mode with no repository, or SHA exists |

Fix the Secret or the course org hook. Restart the functions after a new
Secret, then verify the hook uses it. A pass that provisions a repo in that
org refreshes the matching hook. There is no commit backfill. Take the commit SHAs from the failed delivery and check
which are recorded, before and after redelivering it from Forgejo if it still
has it. Recording is idempotent. The commits stay in Forgejo. Only
Pawtograder's history is incomplete.

```sql
SELECT sha FROM public.repository_check_runs
WHERE repository_id = <affected repository id> AND sha IN ('<commit SHA 1>', '<commit SHA 2>') \g
```

## Workspaces (`workspace-open`, `workspace-status`, template)

`workspace-open` returns an error or one of the statuses below. Sentry events
carry `function=workspace-open` or `function=workspace-status`.

```sql
SELECT a.coder_user_id, a.coder_username, w.coder_workspace_name, w.coder_workspace_id,
       w.restart_phase, w.restart_started_at, w.superseded_at
FROM public.coder_accounts a
LEFT JOIN public.coder_workspaces w ON w.user_id = a.user_id AND w.instance_url = a.instance_url
WHERE a.user_id = '<user id>' AND a.instance_url = 'https://coder.staging.pawtograder.net' \g
```

| Status or error                                                     | Meaning                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 503 `Coder workspaces are not set up on this deployment`            | `CODER_URL` or `CODER_API_TOKEN` is missing                                                                                                                  |
| 503 `Forgejo workspaces are not set up on this deployment`          | The Forgejo configuration is incomplete when opening a Forgejo repo. See live check 1                                                                        |
| 400 `This deployment can't open GitHub repositories in a workspace` | `CODER_GITHUB_AUTH_ID` is missing when opening a GitHub repo                                                                                                 |
| 403 `Cloud workspaces are not enabled for this course`              | The class flag is off                                                                                                                                        |
| 404 `You don't have a repository for this assignment yet`           | No repository row matches the caller, assignment and group                                                                                                   |
| `needs_linking`                                                     | The student needs to sign in to Coder, or to link their GitHub account for a GitHub repository                                                               |
| `needs_org_invite`                                                  | Accept the GitHub course organization invitation, then try Open in Coder again                                                                               |
| `credentials_unavailable`                                           | The Forgejo account is missing, or the function couldn't deliver the repo credentials or commit email. Read `message` and check Coder user secrets           |
| `not_started`, `starting`, `restarting`, `ready`                    | Workspace is stopped or absent, starting, finishing a restart, or ready with an editor URL                                                                   |
| `account_conflict`                                                  | An existing Coder user can't be safely bound to this login. See below                                                                                        |
| `failed`, step `clone`, `Git Clone failed: ...`                     | Check repo access, the Forgejo credentials file or GitHub link, and network reachability. The clone times out after 5 minutes. Log lines are in the response |
| `failed`, step `build`                                              | Read `message` and the build log in Coder, then describe the pod if one exists                                                                               |

`workspace-open` checks enrollment, the class flag, and that the assignment and
repository are on supported hosts. It creates the caller's Coder user
(`<user id>@coder.pawtograder.invalid`) and workspace `repo-<repository id>`, or
starts or restarts an existing one, recording both in `coder_accounts` and
`coder_workspaces`. `workspace-status` creates nothing but posts the start of a
restart `workspace-open` began. "Git Clone" clones `repo_url` into
`/home/coder/<repo>` on first start. Deploys pin `coder-workspace:staging-<sha>`.
`redeploy-staging.sh` uses `:staging-latest`. The assignment page's Open in
Coder card calls `workspace-open` and reads `workspace-status` for enrolled
students with a repository in a flagged course.

A request has 20 seconds including auth. Running out answers 504, or
`restarting` mid-restart. A thrown error reaches Sentry unless it answers 400
or 404. These handlers keep the defaults, so user-visible and security errors
are reported too. `failed`, `needs_linking`, `needs_org_invite`,
`credentials_unavailable` and `account_conflict` answer 200. Workspace-open
also reports caught credential-delivery failures to Sentry.

For a 401 or 403 from Coder, check the response, the deployed
`CODER_API_TOKEN`, the Coder it targets and its owner's permissions. Opening
again retries a failed build or start and takes over a restart claim older than
60 seconds. A folder at `/home/coder/<repo>` that isn't a checkout of `repo_url`
fails the clone on purpose. The student moves it aside.

For `account_conflict`, a Coder owner checks the conflicting user's ID, login
and workspaces. It may be someone else's. Remove it only if obsolete, after
saving unpushed work from its workspaces (push, or copy it off the home PVC),
since deleting a workspace deletes its home. Then the student opens again.

## Course flag and repository host picker

Instructors see no GitHub/Forgejo picker, or "Enable cloud-workspaces for this
course before selecting Forgejo". Nothing monitors the flag. Set it in SQL,
since the Feature flags page doesn't list it (#1091):

```sql
SELECT id, slug, forgejo_org, public.cloud_workspaces_enabled(features) FROM public.classes WHERE id = <class id> \g
-- Replaces every existing entry. Use false to turn it off.
UPDATE public.classes
SET features = coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(
                           CASE WHEN jsonb_typeof(features) = 'array' THEN features ELSE '[]'::jsonb END) f
                         WHERE f->>'name' IS DISTINCT FROM 'cloud-workspaces'), '[]'::jsonb)
               || '[{"name": "cloud-workspaces", "enabled": true}]'::jsonb
WHERE id = <class id> \g
```

The first `cloud-workspaces` entry in `classes.features` decides, and only a
JSON `true` counts. With it on, assignment forms show the picker for code
assignments (#1313), and the roster, reconciler and `workspace-open` act on the
class. Turning it on enqueues a pass. With it off, an assignment already on
Forgejo still shows the picker. A fork keeps its source's host, and no
assignment changes host once it has a handout, grader or repository. A Forgejo
assignment can't be deleted. To delete one, first switch it to GitHub, which
requires no repositories, no `template_repo` and no grader repository. Its
fork source, and every assignment forked from it, must also be on GitHub.

## Flags at `1696ad7a`

| Setting                                                       | Staging               | Turning it off                                                                                                                                                                               |
| ------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud-workspaces` in `classes.features`                      | per class             | No new Forgejo assignments, accounts or repos. `workspace-open` answers 403. Existing access, webhook recording and hash fills continue.                                                     |
| `forgejo.enabled`                                             | `true`                | Removes Forgejo and `FORGEJO_URL`. Turn off the runner first to pass render. Restarts Postgres and the standby. Check PVC retention and verify the backup. GitHub workspaces can still open. |
| `coder.enabled`                                               | `true`                | Removes Coder. Workspace functions answer 503. Restarts Postgres and the standby. Workspace pods keep running: keep their PVCs, then delete the pods.                                        |
| both apps off                                                 |                       | The `app-databases` Job stops, so set the old roles `NOLOGIN` yourself (chart README, "Databases").                                                                                          |
| `forgejo.database` / `coder.database`                         | `pawtograder`         | `own` connects the app to an empty database and restarts Postgres and the standby. Move the data first.                                                                                      |
| `forgejoRunner.enabled`                                       | `true`, capacity 2    | Deletes running job pods and their data. Rerun those jobs. Restart Forgejo afterwards.                                                                                                       |
| `forgejoRunner.actions.source`                                | `mirrors`             | `upstream` sends bare `uses:` names to github.com after a Forgejo restart.                                                                                                                   |
| `auth.oauthServer.enabled`                                    | `true`                | Render fails while auto-approval or Coder OIDC is on. Otherwise Forgejo's init container fails, so Forgejo won't start.                                                                      |
| `auth.oauthServer.autoApproveFirstParty`                      | `true`                | Users never approved see the consent page.                                                                                                                                                   |
| `auth.customAccessTokenHook.enabled`                          | `true` (default)      | Tokens lose Pawtograder's claims and `coder_email`.                                                                                                                                          |
| `coder.oidc.enabled`                                          | `true`                | No new Pawtograder OIDC sign-ins to Coder. Users already bound can still open workspaces if their repo credentials are available.                                                            |
| `coder.externalAuth.github.enabled`                           | `true`                | Removes `CODER_GITHUB_AUTH_ID`. The workspace API refuses new GitHub opens. Forgejo workspaces use Coder user secrets.                                                                       |
| `coderBootstrap.enabled`                                      | `true` (default)      | Template pushes and schedule updates stop.                                                                                                                                                   |
| `coderBootstrap.schedule.defaultTTL` / `activityBump`         | `1h` / `1h` (default) | `defaultTTL` is copied into new workspaces, and `0` never stops them. `activityBump: 0` stops extending the stop time but doesn't remove it.                                                 |
| `forgejo.signInRedirect`                                      | `true` (default)      | Forgejo shows its login page. Restart Forgejo to apply.                                                                                                                                      |
| `coder.oidc.allowSignups`, Forgejo `ENABLE_AUTO_REGISTRATION` | off                   | Already off. On, anyone who can sign in to Pawtograder gets an account (on Coder, with compute).                                                                                             |
| `networkPolicy.cilium.enabled`                                | `true`                | Render refuses the runner and Coder while meta and Studio run.                                                                                                                               |
| `forgejoCoderSecrets.externalSecret.enabled`                  | `true`                | ESO deletes the admin, database and runner-token Secrets, breaking each app's next start. OAuth, OIDC and external auth Secrets stay.                                                        |
| `forgejo.gitea.config.webhook.PAYLOAD_COMMIT_LIMIT`           | `2048` (default)      | Lower values record only the listed commits. `0` records only the head commit.                                                                                                               |

## Course risks, in priority order

1. Job and workspace isolation is unverified. The chart README says Ripley
   isn't safe for real students until the Cilium deny passes "Isolating jobs
   and workspaces". Staging enables it. Before enrolling students, confirm
   `pawtograder-forgejo-jobs-egress-deny` and
   `pawtograder-coder-workspaces-egress-deny` exist (`get ciliumnetworkpolicy`
   in each namespace), then run that check, and again after policy changes.
2. Verify that Forgejo's dump and volume archive are both current and complete.
   Repositories created, renamed or deleted during a backup can differ from the
   dump. See [Forgejo](#forgejo) and use the restore drill to check the set.
3. There is no tested database recovery with Forgejo and Coder running.
   See Database under [Forgejo](#forgejo). Any drill must confirm all writer
   pods and active write Jobs, including `audit-partitions`, have stopped.
   Check that `pg_cron` stays paused until the recovery fence lifts.
4. The reconciler revokes workspace tokens after a student leaves but keeps
   Forgejo accounts and collaborator grants. As the admin, list each Forgejo
   repository's collaborators (Settings, Collaborators, or
   `GET /api/v1/repos/<owner>/<repo>/collaborators`) and compare them with the
   expected writers below. Any other collaborator keeps access it shouldn't,
   including one with no enrollment row at all:

   ```sql
   -- Expected writers: the repo's active owner (a student, or staff for a test repo) or its group's active members.
   SELECT r.repository, string_agg(ga.login, ' ' ORDER BY ga.login) AS expected_writers
   FROM public.repositories r
   LEFT JOIN public.assignment_groups_members m ON m.assignment_group_id = r.assignment_group_id
   LEFT JOIN public.user_roles ur ON ur.class_id = r.class_id AND NOT ur.disabled
     AND ur.private_profile_id = coalesce(r.profile_id, m.profile_id)
   LEFT JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
     AND ga.instance_url = 'https://git.staging.pawtograder.net'
   WHERE r.class_id = <class id> AND r.git_provider = 'forgejo'
   GROUP BY r.repository ORDER BY r.repository \g
   ```

5. The reconciler can skip every pass and answer 200. See live check 1.
6. Nothing pages on a Forgejo, Coder or runner outage. Students notice first.
   Deploy failures, `PawtograderExternalSecretNotReady` and the Postgres alerts
   are indirect. A failed deploy means a hook failed, not that the app is down,
   since the staging upgrade runs without `--atomic`. A release left in `failed`
   isn't cleared by "Recover stuck helm release", which handles only
   `pending-*`, so it stays red until someone intervenes (#1357).
7. A failed webhook delivery can leave commit history missing or incomplete.
   Check the delivery's SHAs and redeliver if available ([Push webhook](#push-webhook-forgejo-repo-webhook)).
8. Workspace homes have no backup or cleanup (#1223), and stopped workspaces
   keep their quota. Check `kubectl -n pawtograder-staging-workspaces get pvc`.
9. A failed startup script is a workspace status. Check the build and agent
   logs under [Workspaces](#workspaces-workspace-open-workspace-status-template).
10. The flag is SQL-only (#1091), and the first entry decides. See
    [Course flag](#course-flag-and-repository-host-picker).
