# Handout sync over git: build and validation plan

Companion to `handout-sync-git-worker.md`, referred to below as "the spec". Status: draft,
2026-11-01.

## How this plan is run

Claude supervises, and Jon owns the decisions and every action that is hard to reverse or
outward-facing.

- **Work packages (WPs)** are delegated to implementation agents. Each one gets its own git
  worktree under `~/work/pawtograder/platform-wt-gitsync-<wp>` and a brief that cites the spec
  sections it implements. Agents never push, open PRs, deploy or touch prod.
- **The supervisor (Claude)** writes each brief, reviews every diff against the spec, runs every
  gate below itself (an agent reporting that a gate passed is not evidence), and sends review
  rounds back until the gate passes. A delegated review uses a separate agent that is given the
  code and the spec, not the implementer's summary.
- **Jon** answers the decision points (D), merges PRs, and approves each step marked **[Jon]**.
  Claude prepares those steps and runs them only once Jon has said yes to that specific step.

Every WP ends in one PR against `staging`, stacked where noted. A PR description lists the spec
sections it implements, the gates it passed with their command output, and anything deferred.

### Gates that apply to every WP

| ID | Gate | Notes |
|---|---|---|
| G-check | `deno check` on every touched entrypoint | Compare against a `git archive` of `staging`. `github-async-worker` has known baseline errors ([[platform-isolated-test-stack]]), so only new errors fail the gate |
| G-test | `npm run test:functions` plus the WP's new tests | New tests must fail on a deliberately broken implementation at least once (the supervisor checks this by mutating one line) |
| G-lint | `npm run lint` and prettier on touched files only | Never commit drift from unrelated files ([[platform-generated-file-drift]]). Worktrees symlink `node_modules`, and the gates leave it untracked ([[platform-deno-gate-node-modules-trap]]) |
| G-review | A reviewer agent with the diff and the spec | Every CONFIRMED finding is fixed or answered in the PR |
| G-spec | Supervisor diff review | Every behavior in the WP's spec sections is either implemented and tested or listed as deferred |

## Decisions

| ID | Question | Spec | Decision (2026-11-01) |
|---|---|---|---|
| D1 | Commit date | §5.7 | The handout commit's date (deterministic) |
| D2 | Egress: plain `NetworkPolicy` or `CiliumNetworkPolicy` with `toFQDNs` | §8.5, §11.5 | Settled in WP6 after checking the prod cluster |
| D3 | Rollout flag | §10 | One deployment-wide switch: the `public.system_settings` row `handout_sync_engine` = `{"engine": "rest" \| "git", "shadow": bool}`. No per-class routing |
| D4 | `HANDOUT_SYNC_MAX_REPO_KIB` default | §8.4 | 2 GiB |
| D5 | Does the GitHub App on staging and prod have the `workflows` permission? | §8.2 | Claude checks with `GET /app` before WP3 merges. If it is missing, stop and ask |

## Phase 1: build

Dependency order: WP1 → WP2 → WP3 → WP5. WP4 and WP6 can run alongside WP2 and WP3.

```
WP1 runGit ──▶ WP2 engine ──▶ WP3 sync entry ──▶ WP5 worker ──▶ Phase 2
WP4 queue + RPCs ─────────────────────────────────▲
WP6 image + chart ────────────────────────────────┘
```

### WP1. `runGit()` and hardening (spec §8.1, §8.2 logging and environment, §8.6)

Build `_shared/gitSync/runGit.ts`: typed builders per subcommand, input validation, `-c`
hardening flags, `clearEnv` spawning, per-call timeouts, output caps, stderr redaction, and
failure classification.

Acceptance:

- Unit tests:
  - Each validator rejects `-x`, `--upload-pack=…`, `ext::sh -c id`, `file:///etc`, `a/b/c`,
    `../x`, empty input, a 39-character SHA, and an uppercase SHA. A spawn spy proves nothing
    was spawned.
  - With a planted `SUPABASE_SERVICE_ROLE_KEY` and `GIT_TRACE=1` in the parent environment, a
    child that prints its environment (test-only command injection) shows neither.
  - Redaction removes a planted `ghs_…` token, an `AUTHORIZATION:` header and `https://x:y@`
    userinfo from stderr and from error messages.
  - Timeout and output cap kill the child and report a signal.
  - Each known git failure string maps to the right error type in spec §7.
- An integration test against a local bare repo that contains a `.gitattributes` with
  `* merge=evil diff=evil filter=evil` runs every builder. A canary file that a driver would
  create never appears.
- G-* gates.

Size: small. No dependencies.

### WP2. The engine (spec §5.1–§5.8, §6.1, §6.3, §6.5, §8.3 isolation)

Build `_shared/gitSync/engine.ts`, a function from the spec §4 inputs to a `SyncPlan`:
`{ commit, tree, unresolved, changedFiles, pushAction }` plus the push itself. It uses only
`runGit()` and `syncConflictGuard.ts`, and does no REST. Remotes come from an injected
`remoteUrlFor()`. The template cache and alternates layout follows spec §5.

Acceptance:

- The hermetic suite in spec §9.1, run against `file://` bare repos built per case by a fixture
  helper (`GIT_ALLOW_PROTOCOL=file` in tests only). Every row of the tables in spec §5.3, §5.5
  and §5.8 has a case.
- **Crash convergence.** For each phase boundary (after fetch, classify, tree, commit, push), a
  run that throws there and is then re-run from scratch produces the same commit sha and the
  same remote state as an uninterrupted run.
- **Determinism.** Two runs on fresh job directories produce identical commit shas.
- **Cross-student isolation (spec §8.3).** After syncs for students A and B against the same
  template cache, the objects reachable on A's remote contain nothing that exists only in B.
- **No working tree.** After every test, the job directory contains only bare-repo layout, and
  the job directory is gone after the `finally`.
- **Memory.** A fixture with 30 MB of binaries (mirroring `fa26-handout-hw-img1`: one 8.4 MB
  PPM and 11 × 2 MB PNGs) and one with a 90 MB file both complete. Peak RSS of the Deno process
  stays under 150 MB, measured with `/usr/bin/time -v`.
- **Policy parity.** `syncConflictGuard.test.ts` passes untouched. The guard module itself has
  no diff, other than removals the spec lists for Phase 3.
- G-* gates.

Also covered, from the WP1 review:

- The template cache's stale-lock cleanup (spec §5.1).
- The merge size cap (spec §5.5).
- The no-`main` and non-UTF-8 terminals (spec §5.2, §5.3).
- Cases: a template cache holding a stale `shallow.lock`; a student repo with no `main`; a
  student file above the merge cap.

Size: large. Depends on WP1. The supervisor reviews in two rounds: first the fixtures and the
§5.3 and §5.4 mapping, then tree building, commit and push.

### WP3. `syncRepositoryToHandoutGit` (spec §4, §5.9, §7, §8.2 scoped token, §8.3 grader-repo check, §8.4 size check)

Wire the engine into a function with the same signature and `SyncResult` contract as
`syncRepositoryToHandout`. It covers:

- the repo-size and solution-repo pre-checks
- `getScopedInstallationToken()` in `GitHubWrapper.ts`
- the PR lookup before creation, PR creation and auto-merge, with only these calls under the
  content limiter
- the blocked-recheck path
- the terminal error mapping

WP1's errors are separate types, because importing `GitHubSyncHelpers.ts` would load Redis,
Sentry, Supabase and Bottleneck. WP3 maps `GitSyncTerminalError` onto `TerminalSyncError`
(same `reason`), because the handler branches on `instanceof`.

The queue decides the engine (D3): the handler takes the git path when `meta.queue_name` is
`handout_sync` and the REST path otherwise, which stays untouched.

Acceptance:

- **Contract tests.** Each `SyncResult` shape the handler branches on (`no_changes`,
  `blocked_by_student_changes`, merged, open PR with `unresolved_paths`, `terminal_reason` for
  each new reason) is produced by a scenario, with octokit stubbed only for the PR and merge
  calls.
- **Matched-pair regression (spec §5.9).** A crash after the merge followed by a retry returns
  `merged: true` with `merge_sha`, never `no_changes`.
- **Token scope.** A test asserts the token request names exactly the two repos and the three
  permissions.
- The handler diff is limited to the engine switch. A reviewer confirms that
  `applyRepositoryUpdate` and `retireStaleSync` are untouched.
- G-* gates.

Size: medium. Depends on WP2.

### WP4. Queue, routing and RPCs (spec §3, §10 producer audit)

One migration:

- `handout_sync` and `handout_sync_dlq` queues
- `pgmq_public.set_vt` (or an equivalent wrapper), granted to service_role only, because the
  heartbeat needs it and `pgmq_public` does not expose it today
- seeding the `system_settings` row `handout_sync_engine` with
  `{"engine": "rest", "shadow": false}`, and `queue_repository_syncs` routing on it (D3). With
  `shadow` on, it also sends a copy to `handout_sync` marked `shadow: true`. The copy carries the inputs
  the REST job will use (`from_sha`, `synced_repo_sha`) as read at enqueue time, so the shadow
  run is not racing the REST job's row updates
- a `handout_sync_shadow_results` table (`repository_id`, `to_sha`, inputs, `predicted_tree`,
  `predicted_commit_parent`, `unresolved`, `error`, `created_at`), service_role only
- dedupe across `handout_sync` and `async_calls`

Plus an audit, written into the PR, of every SQL and TypeScript producer of
`sync_repo_to_handout`.

Acceptance:

- Applied on an isolated scratch Supabase stack ([[platform-isolated-test-stack]]). The SQL
  tests show:
  - With `engine: "rest"`, routing is unchanged.
  - With `engine: "git"`, sync messages land in `handout_sync` only.
  - With `shadow: true`, the REST message is unchanged and a marked copy lands in
    `handout_sync`. The dedupe ignores shadow copies.
  - A missing or malformed setting row routes to `rest`.
  - Dedupe holds when a duplicate sits in either queue.
  - `set_vt` is denied to `anon` and `authenticated`.
- `tests/manual/per_org_async_leases/10_scenarios.sql` still passes.
- Types are regenerated from the isolated stack only.
- The PR description includes the deploy step `NOTIFY pgrst, 'reload schema'`, because a new
  RPC is invisible to PostgREST until the schema reloads ([[postgrest-schema-cache-deploy-race]]).
- G-* gates.

Size: medium. No dependency on WP1–WP3.

### WP5. Worker process (spec §3.1)

`handout-sync-worker/main.ts` covers:

- the poll loop on `handout_sync` with `free_slots` concurrency
- the heartbeat (`set_vt` every 45 s)
- the job deadline with `AbortController`
- SIGTERM drain
- the read cap to the DLQ
- a `/metrics` endpoint: job duration, outcome by result, fetch and push bytes, `/work` usage
- a `/healthz` endpoint

It calls `processEnvelope` with `queue_name: "handout_sync"`.

Carried over from the WP4 audit:

- `sendToDeadLetterQueue` in `github-async-worker/index.ts` hardcodes `async_calls_dlq`. A
  poison `handout_sync` message must land in `handout_sync_dlq`, so it has to follow
  `meta.queue_name`.
- `processEnvelope` has no shadow guard. Add one that refuses a message marked `shadow`, as a
  backstop to the routing in the worker.
- `get_queue_metrics` (20260811120200) has fixed columns and omits `handout_sync` and its DLQ.
  WP6's alerts need them.
- The shadow handler writes with `insert … on conflict (msg_id) do nothing`.
- The queue gauges for `handout_sync` and `handout_sync_dlq` need `get_queue_metrics` and
  `metrics/index.ts`, and the parity guardrail requires both. WP6's alerts read
  `pawtograder_queue_depth` and `pawtograder_queue_oldest_message_seconds`, and stay silent
  until they exist.
- The generated types give `pgmq_public.set_vt` an `unknown[]` return, so the heartbeat needs
  its own row type.
- Read the env knobs WP6 defined (`HANDOUT_SYNC_*`, including
  `HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS`) and emit the metric names in WP6's table.
- `/healthz` reports whether the poll loop is alive, not job progress. Set V8's
  `--max-old-space-size` inside the 1 Gi limit.

Shadow messages never reach `processEnvelope`, because it writes `sync_data` and the sync
columns on the `repositories` row. The worker routes a message marked `shadow` to a plan-only
engine call: no push, no PR, no REST writes, and the token is scoped to `contents: read`. It
records the result in `handout_sync_shadow_results` and archives the message.

Acceptance:

- Against the isolated stack, with GitHub replaced by `file://` remotes through the same
  `remoteUrlFor()` seam:
  - A message runs end to end and is archived.
  - `kill -9` mid-push leaves the message visible again within 120 s, and the re-run converges.
  - SIGTERM finishes in-flight jobs and reads nothing new.
  - A job past its deadline kills its git children (no orphan `git` processes remain).
  - `read_ct > 5` moves the message to `handout_sync_dlq` with the error on the row.
  - A shadow message leaves the `repositories` row byte-identical, pushes nothing to its
    `file://` remote, and writes one `handout_sync_shadow_results` row.
- `/metrics` is scraped by a gzip-sending client, not curl ([[prometheus-scrape-sends-gzip]]).
- G-* gates.

Size: medium. Depends on WP3 and WP4.

### WP6. Image and chart (spec §3.1, §8.5)

Build `charts/pawtograder/images/handout-sync-worker/Dockerfile` (Deno and a pinned git
≥ 2.45, non-root UID, no shell tools beyond what git needs) and add it to
`release-images.yml`. The chart gets:

- a Deployment with the §8.5 security context, the `emptyDir` with `sizeLimit`,
  `automountServiceAccountToken: false`, and the environment from the existing edge-functions
  secrets, limited to the keys the worker uses
- a NetworkPolicy (D2)
- a PodDisruptionBudget
- `PawtograderQueueOldestMessageAging` for `handout_sync`, keyed on drain rate
  ([[async-queue-aging-alert-bulk-release]]), with a DLQ-depth alert and a `/work` usage alert
- values for staging and prod, with replicas at 0 in prod until Phase 2

Acceptance:

- `render-guardrails.sh` shows no new failures against the staging baseline (staging already
  fails on `backup.image.tag`).
- `promrules-unit.sh` covers the new alerts: a bulk release of 300 that drains does not fire,
  and a stuck message does.
- `helm template` output shows the security context and that no service account token is
  mounted.
- The image runs `git --version` at or above the pin, as a non-root user, on a read-only root
  filesystem.
- G-* gates.

Size: medium. No dependency on WP1–WP5.

## Phase 2: validate on staging, then prod

Every step below changes shared infrastructure or GitHub state, so each needs **[Jon]** before
it runs. Claude prepares the commands and runs them only after that approval.

### S1. Deploy to staging **[Jon]**

Merge WP1–WP6 into `staging` and deploy. Run `NOTIFY pgrst`. Check the worker's `/healthz`,
check that the metrics are scraped, and check that no service account token is mounted. The
image has no shell or `ls`, so use
`kubectl exec … -- deno eval 'Deno.statSync("/var/run/secrets/kubernetes.io")'` (it must throw
NotFound) or `kubectl debug` with a separate image.

### S2. Shadow comparison on staging (no pushes)

Precondition: the deployed worker image includes WP5's shadow routing and the `processEnvelope`
shadow guard. A shadow copy is a complete, valid sync envelope, so a consumer without the
guard would run it as a real second sync of the same revision.

Set `shadow: true` on staging **[Jon]**. For each message marked `shadow`, the worker runs
the engine through tree building, records `{ predicted_tree, unresolved }` in a table, and
pushes nothing. The REST path still does the real sync. A comparison script reads the tree of
each commit the REST path pushed and diffs it against the prediction.

The script compares a shadow row only with a REST push that was built from the same inputs:
its `from_sha` and `synced_repo_sha` must equal the REST job's actual handout base and branch
parent. A shadow copy carries the inputs read at enqueue time. When a second revision is queued
before the first one lands, the REST job for the later revision builds from a different base, so
those pairs are reported as skipped, not compared.

Pass criteria:

- Over at least 50 real staging syncs, every mismatch is explained: either a file that
  `merge-file` left to the student where jsdiff merged it (expected, spec §6.5) or a rename
  (spec §5.3).
- Any other mismatch is a bug and blocks.

### S3. Acceptance scenarios on staging **[Jon]**

These are spec §9.3, run with the git engine actually pushing for one staging class:

1. Replay the `fa26-handout-hw-img1` revision into 7 repos. Record peak RSS and duration.
2. Run a 250-repo bulk release. Compare its drain rate with the REST path's last comparable
   release. Confirm that `create_repo` and invitations are not slowed.
3. **Attribution.** The compare API shows `Bot` for both author and committer on a git-built
   commit, and a second sync resets an ours-stale branch. If this fails, stop and revise spec
   §5.7 before going further.
4. The sync push creates no submission.
5. `kubectl delete pod` during a push and during a merge. Each message converges within 2 min
   of the pod coming back.
6. **Security checks on the live pod:**
   - Using `kubectl debug` (the image has no `ps`), the process list during a push shows no
     token in any git argv.
   - `/proc/<git pid>/environ` holds no Supabase or App keys.
   - The token's `GET /installation/repositories` lists exactly the two repos.
   - An egress attempt to a non-GitHub external host fails.
   - A template set to a grader repo is refused with `template_is_solution_repo`.

### S4. Prod shadow **[Jon]**

Deploy to prod with replicas at 2 and set `{"engine": "rest", "shadow": true}`. Run the S2
comparison on 7 days of prod traffic.

### S5. Prod cutover **[Jon]**

If S4 is clean, set `{"engine": "git", "shadow": false}`. This is the one switch: every class
moves at once, and setting `engine` back to `rest` is the rollback. Edge-path sync messages
already in `async_calls` drain on their own. Watch for 14 days:

- outcomes by result
- DLQ depth
- `/work` usage
- attribution on the first branch reset

## Phase 3: delete the REST path **[Jon approves the PR]**

Starts once `async_calls` has held no `sync_repo_to_handout` message for 7 days. It removes the
list in spec §10.1, the shadow mode, and the engine switch.

Acceptance:

- G-* gates.
- A grep shows no remaining references to the deleted symbols.
- The edge-functions image builds and its eszip bundle for `github-async-worker` shrinks. Record
  the size.

## Operational notes

- With `engine: "git"` the worker must be running. With replicas at 0, syncs queue
  indefinitely, and an assignment delete can refuse (55006) while a stale marker matches a
  queued `handout_sync` msg_id. Never set `engine: "git"` with the worker scaled to 0.
- Bump the chart version when the WP6 PR merges.

## Stop conditions

The supervisor halts the plan and reports to Jon if any of these happen:

- An S2 or S4 mismatch with no spec explanation.
- In S5, a rise in terminal or DLQ'd syncs over the REST baseline. Roll back by setting
  `engine` to `rest`, then report.
- The attribution check (S3.3) fails.
- Any security check in S3.6 fails.
- A gate fails three review rounds in a row on the same issue. The spec is probably wrong
  there, and the agents should not keep patching around it.
- Any step would need prod access, a push or a PR action that Jon has not approved for that
  step.
