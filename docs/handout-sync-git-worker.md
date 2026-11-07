# Handout sync over git: design spec

Status: draft, 2026-10-31. Replaces the GitHub-REST content path of `syncRepositoryToHandout`.

## 1. Problem

`sync_repo_to_handout` moves file content through an edge isolate capped at
`EDGE_WORKER_MEMORY_LIMIT_MB=256`. Every changed binary or added file is downloaded from the
template, base64-encoded and POSTed to the student repo (`copyBlobBetweenRepos`). The in-code
memory model (`~2.33×` per file, `LARGE_FILE_THRESHOLD`, `withHeavySyncLock`) is wrong: on
2026-10-26 a single serialized ~30 MB, 27-file sync of `neu-cs5004/fa26-handout-hw-img1` blew
the cap on every attempt. An OOM appears as `Uncaught null`, the isolate idles to the 480 s
wall-clock kill, the message redelivers and fails identically until it is dead-lettered. The
isolate is shared with up to 7 other messages (`drainConcurrency` 8), so one bad handout also
kills unrelated work and ages `async_calls`.

## 2. Goals and non-goals

Goals:

- No file content passes through JavaScript memory. Git moves the bytes, so the size of the
  handout bounds disk, never heap.
- A failure in one sync cannot affect any other job.
- Retrying any step is safe and converges to the same result.
- The student-work policy in `syncConflictGuard.ts` is preserved exactly, with one deliberate
  change (§6.5).
- Every scenario is testable hermetically against local bare repos, with no GitHub.

Non-goals:

- Changing the worker's row bookkeeping (`applyRepositoryUpdate`, `retireStaleSync`,
  `classifyHandoutDirection`, the `fork_merge_upstream` path). These move to the new worker
  unchanged.
- Changing what a student sees (PR title, body, branch name, commit subject).

## 3. Architecture

```
queue_repository_syncs()  ──pgmq.send──▶  handout_sync  ──▶  handout-sync-worker (k8s Deployment)
                                          handout_sync_dlq       deno + git, NOT edge-runtime
                                                                 imports processEnvelope()
                                                                 engine: git CLI + 3-5 REST calls
```

- **New pgmq queues:** `handout_sync` and `handout_sync_dlq`. `queue_repository_syncs` (and any
  other producer of `sync_repo_to_handout`, audited in §10) sends there instead of
  `async_calls`. Its dedupe check (20260915120000) reads `handout_sync`, and during the
  transition `async_calls` as well.
- **New Deployment:** `handout-sync-worker`, a long-running `deno run` process. Its entrypoint is
  a small poll loop around the existing `processEnvelope` from `github-async-worker/index.ts`,
  called with `meta.queue_name = "handout_sync"`. `scripts/RunAsyncMessagesLocally.ts` already
  proves that `processEnvelope` runs under plain Deno.
- **The engine swap happens inside `syncRepositoryToHandout`.** It keeps its signature and its
  `SyncResult` contract. Its body becomes `syncRepositoryToHandoutGit` (§5). The edge function
  never calls it once routing moves, but it can still bundle it.

### 3.1 Worker process

| Setting | Value | Why |
|---|---|---|
| Image | `denoland/deno` + git ≥ 2.45, pinned | `merge-file --object-id` needs 2.43 or later |
| Concurrency | 2 jobs per pod, 2 replicas | REST footprint is tiny; git is I/O-bound |
| Memory | request 512 Mi / limit 1 Gi | The JS heap holds metadata only; git children are bounded by pack settings |
| Disk | `emptyDir` with `sizeLimit: 20Gi` at `/work` | Template cache plus per-job scratch |
| VT | 120 s, extended with `pgmq.set_vt` every 45 s while a job runs | A dead pod's message is back within 2 min, not 480 s plus one VT |
| Job deadline | 15 min hard, enforced with an `AbortController` that kills git children | A hung push cannot hold a slot |
| Read cap | `read_ct > 5` → DLQ with the error recorded on the row | Bounds a poison message to about 10 minutes |
| Security context | non-root, read-only root filesystem, no capabilities, no service account token, restricted egress | §8.5 |

The poll loop reads up to `free_slots` messages from `handout_sync`, runs each under the
heartbeat, and archives on `true`. Anything else is left to `processEnvelope`'s existing
failure handling.

On SIGTERM the worker stops reading and waits up to `HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS`
(240 s) for in-flight jobs. It then aborts their git children and exits without archiving them.
Those messages come back after one VT and converge, because a re-run from scratch is safe
(§6.1). `terminationGracePeriodSeconds` is 300, which stays inside the 900 s drain timeout that
`maintenance.sh` allows each writer. Running jobs to the 15-minute deadline would not.

Git config, set per invocation through `-c` by `runGit()` (§8.6), alongside the hardening flags in §8.1:

- `pack.threads=1`, `pack.windowMemory=64m`, `core.packedGitLimit=128m` and
  `core.bigFileThreshold=16m` keep the memory of git children flat.
- `http.lowSpeedLimit=1000` with `http.lowSpeedTime=60` aborts a stalled transfer.
- `GIT_TERMINAL_PROMPT=0` is set in the environment.

## 4. Inputs

The same inputs the current function takes:

| Name | Source | Meaning |
|---|---|---|
| `T` | `template_repo` | Handout repo |
| `F` | `currentSyncedHandoutSha` (may be null) | Handout revision the repo was last synced to |
| `H` | `to_sha` | Target handout revision |
| `S` | `syncedRepoSha` (may be null) | Student repo commit at the last sync. If null, resolved to the current head, once (`resolveSyncBaselineSha`) |
| `R` | `repository_full_name` | Student repo |

`classifyHandoutDirection` still runs first in the handler (one metadata-only REST compare). The
engine no longer needs `diffStrategy`, because it always diffs two trees (§5.3). That is
already the correct answer for both "descendant" and "rewritten".

## 5. Algorithm

All work happens in a per-job bare repo `/work/jobs/<msg_id>.git`. Its
`objects/info/alternates` points at the template cache `/work/templates/<owner>/<repo>.git`,
so template objects are never copied. The job directory is removed in a `finally`.

### 5.1 Fetch the handout (cached)

```
git -C $TCACHE cat-file -e $H^{commit} || git -C $TCACHE fetch --depth=1 --no-tags $T_URL $H
[F] git -C $TCACHE cat-file -e $F^{commit} || git -C $TCACHE fetch --depth=1 --no-tags $T_URL $F
```

- An in-process mutex per template serializes fetches into the same cache dir. Across pods
  nothing is shared, which is fine.
- A cache dir is evicted by LRU when `/work` passes 70 % of `sizeLimit`. A pod restart wipes
  it, which is also fine.
- If `F` can't be fetched (history rewritten and GC'd), the old-handout side becomes the empty
  tree `4b825dc6…`. Tag `sync_from_sha_unfetchable`. This fails in the safe direction: every
  path the student holds classifies as theirs. It is exactly today's `fromSha = null` semantics.
- If `H` can't be fetched, the job is retryable. Once `retry_count` reaches 5 it becomes terminal
  `handout_revision_missing`.

### 5.2 Fetch the student repo

Before any fetch in §5.1 or §5.2, the worker checks the repo-size ceiling and refuses a template
that is the solution repo (§8.3, §8.4).

```
git -C $JOB fetch --depth=1 --no-tags $R_URL $S            # baseline: the tree the guard classifies, and the parent
git -C $JOB fetch --depth=1 --no-tags $R_URL refs/heads/main:refs/remotes/s/main   # lets push skip shared objects
git ls-remote $R_URL refs/heads/sync-to-${H:0:7}           # existing sync branch head, or absent
```

- These are full (not blobless) depth-1 fetches. The push has to see the objects locally to
  exclude them, and a blobless baseline makes `push` lazily fetch every inherited blob (§11.3).
- If `S` can't be fetched (the student force-pushed it away and GitHub GC'd it), fall back to
  `S := head of main`, which is the documented null-baseline behavior, and tag
  `sync_baseline_unreachable`.
- If the repo itself is missing (404), use the existing `TerminalSyncError` path.

### 5.3 Compute the handout diff

```
git diff-tree -r -z --no-renames --raw     $F_TREE $H_TREE      # status, old/new mode, old/new sha
git diff-tree -r -z --no-renames --numstat $F_TREE $H_TREE      # "-\t-" marks binary
```

Each record maps to the existing `ChangedFileShape`:

| git status | `status` | `isBinary` | `hasPatch` | `patchDeletesFile` |
|---|---|---|---|---|
| `A` | `added` | from numstat | `!isBinary` | false |
| `M` | `modified` | from numstat | `!isBinary` | false |
| `D` | `removed` | from numstat | false | false |
| `T` (type change) | `modified` | **true** | false | false |

- Entries with mode `160000` (gitlinks) are dropped and logged. The current path only ever emits
  blob modes, so this matches today.
- `patchDeletesFile` is always false. It exists only because GitHub's compare sometimes reports a
  deletion as a `+0,0` modify, and `git diff-tree` reports deletions as `D`.
- `--no-renames` turns a rename into `D` + `A`, so each side is classified independently. Today
  compare reports `renamed`, and the code handles it inconsistently. This is an improvement.
- An empty diff returns `{ success: true, no_changes: true }`, as today.

### 5.4 Classify (unchanged policy)

```
git ls-tree -r -t -z --full-tree $S      → Map<path, TreeEntry>   (student at baseline)
git ls-tree -r -t -z --full-tree $F|∅    → Map<path, TreeEntry>   (old handout)
```

`-t` includes tree entries, so `classifyStudentFile` and `findBlockingAncestor` see directories
and submodules. A local listing is never truncated, so `pathsNeedingBlobLookup`, the lookup
budget and the Redis tree cache all go away.

For each diff path, the classification loop runs exactly as `findStudentModifiedFiles` does
today: `classifyStudentFile(student.get(p), handout.get(p))`, then `findBlockingAncestor`
unless the path is in `removedPaths`. Then `decideFileAction(shape, reason)` for each file.

### 5.5 Resolve each file to an index update

| action | condition | index update | mode |
|---|---|---|---|
| `noop` | | none | |
| `skip` | | none (base supplies the student's file); add to `unresolved` | |
| `write` | `removed` | delete `p` | |
| `write` | handout-owned path | `H`'s entry for `p` | `H`'s mode |
| `write` | anything else | `H`'s entry for `p` | `modeFor` (§5.5.1) |
| `attempt_patch` | | `git merge-file --object-id -L yours -L handout-before -L handout <S:p> <F:p> <H:p>`: exit 0 → the printed oid; exit > 0 (conflicts) → skip with `content_differs`; child killed by signal or exit < 0 → skip with `content_differs` and tag `merge_file_failed` | student's mode |

- `write` for a non-student file is simply the new handout blob. That is exactly what today's
  `applyPatch(base, patch)` produces when base equals the old handout, which is what
  "unmodified" means. The fallback-to-template branch is the same. Both become one line.
- `merge-file --object-id` writes the merged blob straight into `$JOB`'s object store. Nothing is
  materialized in JS.
- A merge-file child killed by the cgroup OOM killer degrades one file to "left to the student".
  It never fails the sync. That is the resilience property for pathological text files.

#### 5.5.1 `modeFor`

Ported verbatim: a student-owned file keeps its own mode, otherwise the handout's mode is used,
otherwise whichever mode is known, otherwise `100644`. The student's mode comes from the
baseline `ls-tree`.

### 5.6 Build the tree

```
export GIT_INDEX_FILE=$JOB/sync.index
git read-tree $S
git update-index -z --index-info  < removals      # "0 0000…0000\t<path>\0" per deleted path
git update-index -z --add --replace --index-info < writes   # "<mode> <oid>\t<path>\0"
TREE=$(git write-tree)
```

- Removals go first so that a directory→file swap (the handout deleted `foo/*` and added `foo`)
  doesn't collide in the index. `--replace` handles the reverse case, file→directory.
- If `TREE == tree(S)`, nothing survived. Go to `blockedByStudentChanges` (§6.3) and push
  nothing. The current code creates the ref before examining any file and then has to delete
  the empty branch with a compare-and-swap. Here no ref exists yet, so that whole cleanup path
  disappears.

### 5.7 Commit (deterministic)

```
GIT_AUTHOR_NAME="$APP_SLUG[bot]"   GIT_AUTHOR_EMAIL="$APP_BOT_ID+$APP_SLUG[bot]@users.noreply.github.com"
GIT_COMMITTER_NAME=…same…          GIT_COMMITTER_EMAIL=…same…
GIT_AUTHOR_DATE=GIT_COMMITTER_DATE=<committer date of H>
COMMIT=$(git commit-tree $TREE -p $S -F msg.txt)
```

- **The parent is `S`, not the current head.** This preserves today's model: GitHub's PR merge
  does the 3-way merge against anything the student committed after `S`.
- **The message is the current commit message, byte for byte.** The subject must keep matching
  `SYNC_COMMIT_SUBJECT_RE`, which `isOurSyncCommit` and the `github-repo-webhook` "this push is
  not a submission" path both depend on.
- **The commit is deterministic.** Identity, date, tree, parent and message are all functions of
  the inputs, so a retry produces the same `COMMIT` sha. That is what makes the job idempotent
  without a persisted step machine (§6.1). Tradeoff: the commit shows the handout's commit time,
  not the time of the sync.
- **Bot identity.** `$APP_BOT_ID` is the bot user's id (`GET /users/<slug>[bot]`), resolved once
  per process. GitHub attributes a commit to the App's bot account by that noreply email, which
  keeps `authorType` and `committerType` = `Bot` on the compare API. That is the "we built it,
  unsigned" branch of `isOurSyncCommit`. **Verify on staging (§9.3).**

### 5.8 Push (compare-and-swap)

The branch is `B = sync-to-${H:0:7}`, and `X` is its head from `ls-remote` (§5.2).

| `X` | Action |
|---|---|
| absent | `git push --force-with-lease=refs/heads/$B: $R_URL $COMMIT:refs/heads/$B` (an empty lease means "must not exist") |
| `== COMMIT` | Skip the push. This is a retry of a job that already pushed. |
| `== S` | `git push --force-with-lease=refs/heads/$B:$S …` |
| other | `assertSyncBranchSafeToReset(R, B, S)` (REST compare, unchanged), then `git push --force-with-lease=refs/heads/$B:$X …` |

- `--force-with-lease` is a real server-side compare-and-swap. It replaces
  `updateRefWithExpectedHead`, `assertBranchStillAt` and the PATCH and delete+create fallbacks.
- A lease rejection means someone pushed between the read and the write. It is retryable, and
  the next attempt re-reads `X` and re-runs the safety check.
- A push rejected with `GH001` (a file over 100 MB) becomes `TerminalSyncError("file_too_large")`
  with the path from the remote message. It is the only size limit left, and GitHub enforces it.
- The REST compare for branch safety stays. It runs only when a foreign-looking branch exists,
  it is metadata-only, and replicating GitHub's commit attribution and signature verification
  locally would be a new place to get it wrong.

### 5.9 PR and merge (REST; the only remaining REST writes)

Everything here is unchanged (`createPullRequest`, `findExistingSyncPR`, `attemptAutoMerge`,
`resolveAutoMerge`, the PR body), with one fix for idempotency:

- **Before `createPullRequest`, call `findExistingSyncPR(R, B)`.** If it returns a merged PR whose
  head is `COMMIT`, return `{ merged: true, merge_sha }`. Today a crash after the merge but
  before the row update gets "No commits between" on retry, returns `no_changes` with no
  `repo_head_sha`, and advances `synced_handout_sha` without `synced_repo_sha`, which breaks the
  matched pair.
- Only these calls go through `getCreateContentLimiter(org).schedule`. Today the slot is held for
  the whole sync, including every fetch. The git work no longer touches the content limiter at
  all.

## 6. Correctness properties

### 6.1 Idempotency

Every step is either read-only, content-addressed, or a compare-and-swap:

- Fetches and `ls-tree` are read-only.
- `merge-file` and `commit-tree` are deterministic.
- The push is skipped when `X == COMMIT`, and otherwise leased.
- The PR lookup comes before creation.
- The merge is already idempotent.

So a retry from scratch after a crash at any point converges, and no progress needs to be
persisted. `sync_data.phase` (`fetch | classify | push | pr | merge`) is written only for
observability.

### 6.2 Matched pair

`repo_head_sha` is reported only where it is today: the blocked-recheck path (§6.3), from the
head that path read. Nothing new reads the head afterwards.

### 6.3 Blocked recheck

`blockedByStudentChanges` keeps its logic. Its `findStudentModifiedFiles(head, H, paths)`
becomes a local `ls-tree` of a depth-1 fetch of `main`, which §5.2 already fetched, against
`H`'s tree.

### 6.4 Concurrency between jobs for the same repo

Unchanged. The row-level guarded writes in the handler (`synced_handout_sha` and
`desired_handout_sha` predicates, plus the `msg_id` marker) still arbitrate. The push lease
protects the branch.

### 6.5 Deliberate behavior change: `merge-file` replaces jsdiff `applyPatch`

- jsdiff applies the handout's hunks with fuzz. `merge-file` is a true 3-way merge with no fuzz,
  and it treats adjacent edits as a conflict.
- Expect somewhat more files to land in "Files this update did not change" and fewer silent
  mis-merges.
- For any file the student didn't touch the outcome is unchanged, because those never merge
  (§5.5).

## 7. Error taxonomy

| Condition | Class | Result |
|---|---|---|
| Network or 5xx from GitHub, `git` exit with `RPC failed` / `early EOF` | retryable | throw; redelivered after VT |
| Push lease rejected | retryable | throw |
| `ENOSPC` on `/work` | retryable | throw; evict the template cache; alert on the `disk_full` tag |
| Job deadline hit | retryable | kill children, throw |
| `H` unfetchable after 5 retries | terminal `handout_revision_missing` | `sync_blocked_at` set |
| Push `GH001` | terminal `file_too_large` | names the path |
| Student or template repo over `HANDOUT_SYNC_MAX_REPO_KIB` | terminal `repo_too_large` | checked before fetching (§8.4) |
| `template_repo` is the solution repo | terminal `template_is_solution_repo` | §8.3 |
| Repo name or SHA fails validation | terminal `invalid_sync_input` | nothing is spawned (§8.1) |
| Foreign commits on the sync branch | terminal `sync_branch_not_ours` (existing) | unchanged |
| Repo 404 / not granted | terminal (existing) | unchanged |
| `F` unfetchable / `S` unfetchable | degraded, not an error | tagged; safe-direction fallback (§5.1, §5.2) |
| `merge-file` conflict / killed | degraded, per file | file left to the student |

Terminal errors flow through the existing `TerminalSyncError` → `terminal_reason` path, so the
handler records them without pausing the org.

## 8. Security

The worker never checks out a working tree, never runs repo hooks, and never builds or runs
anything from a repo. That property does not hold by default: git can run commands with no
checkout, and repo names, SHAs and file contents all come from instructors or students. Every
item below is enforced in one place, a `runGit()` wrapper (§8.6), and nothing else in the worker
calls `git`.

### 8.1 Inputs that reach git

| Vector | Exposure | Enforcement |
|---|---|---|
| Remote URL transport (`ext::sh -c …`, `fd::`, `file::`) | `template_repo` is configurable per class and per assignment, so an instructor-controlled string reaches git | Stored strings never become URLs. `owner/repo` must match `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$` and must not be `.` or `..`. The URL is built as `https://github.com/<owner>/<repo>.git`. `GIT_ALLOW_PROTOCOL=https` is set (tests override it to `file`, §9.1) |
| Argument injection (`fetch <url> --upload-pack=<cmd>`) | A "sha" or repo name starting with `-` becomes an option | SHAs must match `^[0-9a-f]{40}$`. Branch names are built from a validated SHA. Positionals follow `--` wherever the subcommand accepts it. Paths never appear in argv: `update-index` reads them from stdin with `-z`, and `merge-file` takes object ids |
| Hooks | Fetch never copies hooks, and the worker creates every repo | `core.hooksPath=/dev/null` as a backstop |
| Repo-supplied config | Fetch never copies `.git/config` | git runs only in directories the worker created. `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` keep image or host config out |
| `.gitattributes` drivers (merge, diff, textconv, filter) | Attributes can only name a driver, and the worker defines none. None of the builders consults attributes for a driver: `--numstat` runs no textconv, `merge-file` ignores attributes, and job repos have an unborn HEAD | Defense in depth, since no builder is exposed today: `attr.tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904` (the empty tree), `core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, and `--no-ext-diff --no-textconv` where they apply. WP1's tests show `attr.tree` alone stops a driver if a builder ever gains `-p --textconv`. It also keeps a student's `-diff` attribute from changing binary detection |
| Submodules | Gitlinks are dropped (§5.3) and never fetched | `fetch.recurseSubmodules=false`, `submodule.recurse=false` |
| Path traversal (`../`, `.git/…`, symlink tricks such as CVE-2024-32002) | Needs a working tree, and the worker never writes one. Symlink blobs (`120000`) are only stored | Never add a checkout step. A test asserts that no job directory contains anything outside the bare repo layout |
| Bugs in git's own pack and object parsing | Student repos are untrusted input to git | Pin git in the image and rebuild for every git security release. The pod hardening in §8.5 limits what an exploit can reach |

### 8.2 Credentials

- **Git children get a clean environment.** The worker process holds the Supabase service-role
  key and the GitHub App private key, because `processEnvelope` needs both. `runGit()` spawns
  with `Deno.Command({ clearEnv: true, env })`. `env` contains only `PATH`, `HOME` (the job
  directory), `LANG=C`, the hardening variables from §8.1 and §8.6, and the job's auth header.
  `GIT_TRACE*` and `GIT_CURL_VERBOSE` are never passed, so nothing can print
  the header.
- **The installation token is scoped per job.** `getScopedInstallationToken(org, repos,
  permissions)` (new, `GitHubWrapper.ts`) calls `POST /app/installations/{id}/access_tokens` with
  `repositories: [<student repo>, <template repo>]` and
  `permissions: { contents: "write", pull_requests: "write", workflows: "write" }`. `workflows`
  is required to push `.github/workflows/grade.yml`. A leaked token reaches two repos for at most
  an hour, not the whole org. The PR and merge calls in §5.9 use an octokit built from the same
  token.
- **Where the token lives.** It is passed only through `GIT_CONFIG_COUNT`/`KEY`/`VALUE`
  (`http.https://github.com/.extraheader = AUTHORIZATION: basic <base64(x-access-token:TOKEN)>`).
  It never appears in argv, in a URL or in any `.git/config`, so it stays out of `ps` and of
  captured command lines. `credential.helper=` (empty) keeps git from caching it.
- **Logging.** `runGit()` logs the subcommand, the redacted argv and the exit status. It never
  logs the environment. Before stderr is logged or put into an error, it is redacted for
  `x-access-token`, `AUTHORIZATION`, `ghs_…`/`ghp_…` patterns and any `https://…@` userinfo.
  This is the class of leak #1144 fixed.

### 8.3 Isolation between repos

- **Student content never mixes.** Each job has its own bare repo. `objects/info/alternates`
  points only at that job's template cache. Student objects are fetched into the job repo, never
  into the cache. Template fetches run in a separate `runGit()` call against the cache directory,
  and that call never names a student remote. A test pushes from student A's job and asserts that
  no object unique to student B reaches A's remote.
- **The template must not be the grader.** If `template_repo` is ever misconfigured to the
  solution/grader repo, every sync pushes hidden tests into every student repo. The worker
  compares `template_repo` case-insensitively against `autograder.grader_repo` for the
  assignment (`autograder.id` is the assignment id) and against the class's resolved
  `solution_template_repo`. A match is terminal `template_is_solution_repo`.
- **Commit spoofing does not escalate.** A student can set their commit email to the bot's
  noreply address so that `isOurSyncCommit` reads their commit as ours, and a later sync resets
  over it. The only branch at risk is their own, and the REST check has the same exposure today.

### 8.4 Denial of service from student content

- **Repo size.** Before fetching, the worker reads `size` (KiB) from `GET /repos/{owner}/{repo}`
  for the student repo and the template. Either one above `HANDOUT_SYNC_MAX_REPO_KIB` (default
  2 GiB) is terminal `repo_too_large`. Without the check, a 10 GB commit fills `/work`, returns
  ENOSPC and retries forever. GitHub's `size` approximates the packed size, so the ceiling is a
  coarse guard and `/work` keeps headroom above it.
- **Timeouts per git child.** Fetch and push get 10 min. `merge-file`, `ls-tree`, `diff-tree`
  and `update-index` get 60 s each. A timeout on `merge-file` degrades that one file (§5.5).
  Anywhere else it fails the job as retryable, bounded by the job deadline and the read cap
  (§3.1).
- **Bounded output.** `runGit()` caps captured stdout at 64 MiB and stderr at 1 MiB and kills
  the child past either. The largest legitimate stdout is an `ls-tree -r` of a large repo.

### 8.5 Pod hardening

- `runAsNonRoot: true`, a fixed UID, `readOnlyRootFilesystem: true` with only `/work` and
  `/tmp` writable, `capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`,
  `seccompProfile: RuntimeDefault`.
- `automountServiceAccountToken: false`. The worker needs no Kubernetes API.
- **Egress.** The pod may reach Kong (PostgREST), Redis and GitHub on 443, and nothing else. The
  chart ships plain `NetworkPolicy`, which cannot match on hostnames. So the GitHub rule is
  "443 to anything outside the cluster CIDRs", and in-cluster egress is limited to Kong and
  Redis. If the prod cluster's Cilium supports `toFQDNs`, a `CiliumNetworkPolicy` narrows that to
  `github.com`, `api.github.com` and `codeload.github.com`. Decide when writing the chart (§11).
- **Disk.** Each pod gets its own `emptyDir` with a `sizeLimit`, so exceeding it evicts this pod,
  not a neighbor.

### 8.6 `runGit()`

The only code path that spawns git. Each call:

1. Takes a typed request, never a raw argv. Each subcommand the engine uses (`fetch`,
   `ls-remote`, `push`, `diff-tree`, `ls-tree`, `merge-file`, `read-tree`, `update-index`,
   `write-tree`, `commit-tree`, `cat-file`, `init`, `count-objects`) has its own builder, and
   validates repo names and SHAs per §8.1 before building argv.
2. Prepends `-c` flags for every config in §3.1 and §8.1: `core.hooksPath=/dev/null`,
   `attr.tree=<empty>`, `credential.helper=`, `fetch.recurseSubmodules=false`,
   `submodule.recurse=false`, `protocol.allow=never`, `protocol.https.allow=always`,
   `core.fsmonitor=false`, `safe.directory=<job dir>`, plus the pack and HTTP limits.
3. Spawns with `clearEnv: true` and the environment from §8.2, a per-call timeout and an
   `AbortSignal` tied to the job deadline.
4. Returns `{ code, signal, stdout, stderr }` with stderr redacted, and classifies known failure
   text (`GH001`, `stale info` from a lease, `not our ref`, `RPC failed`) into the error types of
   §7.

Its unit tests assert that `-`-prefixed and `ext::` inputs are rejected before any spawn, that
the spawned environment contains none of the parent's variables, and that redaction removes a
planted token from stderr.

## 9. Testing

### 9.1 Hermetic engine tests (new, most of the coverage)

The engine takes `remoteUrlFor(fullName)`. Tests point it at `file://` bare repos built per
case, with no GitHub mock. One case per row of §5.3, §5.5 and §5.8, plus every scenario in the
current `GitHubSyncHelpers.test.ts` and `syncConflictGuard.test.ts` comments:

- initial sync (`F` null) into a pristine repo and into one with colliding paths
- student-untouched modify / add / delete
- student-edited text: clean merge, conflicting merge
- student-edited binary
- student deleted a file the handout modifies; both deleted
- directory→file and file→directory, untouched and student-blocked
- mode-only student change; handout makes a script executable
- `grade.yml` add/remove against a student edit
- rewritten handout history; unfetchable `F`; unfetchable `S`
- existing sync branch: absent / at `S` / at `COMMIT` / ours-stale / foreign / lease race
- retry after each phase converges to the same `COMMIT` and the same row write

### 9.2 Unit tests kept

`syncConflictGuard.test.ts` runs unchanged. The policy is the same module.

### 9.3 Staging acceptance (before any prod routing)

1. Replay the `fa26-handout-hw-img1` revision (8.36 MB PPM plus ~11 × 2 MB PNGs) into 7 repos.
   Record peak pod RSS and job duration.
2. Run a 250-repo bulk release on one handout. Check drain rate against the edge path and
   confirm the content limiter is not saturated.
3. **Attribution.** After a git-built sync commit, `GET /compare` shows
   `author.type == committer.type == "Bot"`, and a second sync to a new `H` passes
   `assertSyncBranchSafeToReset` (it resets an ours-stale branch).
4. The sync push creates no submission (the `github-repo-webhook` subject marker), mirroring
   `tests/e2e/push-no-autograder.test.tsx`.
5. Kill the pod mid-push and mid-merge. The message redelivers within 2 min and converges.

## 10. Rollout

1. **Phase 0 (now, independent of this spec):** use `RunAsyncMessagesLocally.ts` for stuck
   messages, or as a stopgap send `sync_repo_to_handout` to the existing worker with
   `drainConcurrency=1`.
2. **Phase 1:** engine, worker Deployment and chart, the `handout_sync` queue migration, and
   hermetic tests. Routing is one deployment-wide switch: the `public.system_settings` row
   `handout_sync_engine`, with value `{"engine": "rest" | "git", "shadow": bool}` and default
   `{"engine": "rest", "shadow": false}`. `queue_repository_syncs` reads it when enqueueing, so
   flipping it needs no deploy. The queue decides the engine: the edge worker on `async_calls`
   always runs the REST path, and the worker on `handout_sync` always runs git. Messages already
   in `async_calls` keep draining on the edge path.
3. **Phase 2:** turn it on for staging and run §9.3. In prod, run shadow mode, then flip the
   switch.
   Add `PawtograderQueueOldestMessageAging` for `handout_sync`, keyed on drain rate, not oldest
   age alone ([[async-queue-aging-alert-bulk-release]]).
4. **Phase 3:** delete the REST content path (§10.1) once `async_calls` holds no
   `sync_repo_to_handout` messages for 7 days.

Producer audit for Phase 1: every SQL path that sends `sync_repo_to_handout`
(`queue_repository_syncs`, the retry-blocked and forced-queueing migrations from 2026-09-11 and
2026-09-13) and `requeueWithDelay` (already queue-parameterized). The per-org lease allocator
(`async_worker_slots`) doesn't need to cover `handout_sync`, because the remaining REST
footprint is 3–5 calls per sync and already goes through the per-org Bottleneck.

### 10.1 Deleted in Phase 3

From `GitHubSyncHelpers.ts`:

- `copyBlobBetweenRepos`, `fetchTextBlobFromRepo`, `fetchTextFileAtRef`
- `getRepoTree`, `fetchRepoTree`, `cacheRepoTree` and the Redis tree cache
- `fetchTreeEntryAtRef`, `resolvePathsInParallel`, `assertLookupBudget`
- `getChangedFiles` and its Redis cache
- `createBranchAndCommit`, `updateRefWithExpectedHead`, `assertBranchStillAt`
- `isRepoAlreadyInSync` (no callers)
- `MAX_SYNC_*`, `LARGE_FILE_THRESHOLD`, `withHeavySyncLock`, `HandoutDiffStrategy`

`GitHubTextEncoding.ts` goes if it has no other callers.

From `syncConflictGuard.ts`: `pathsNeedingBlobLookup`, `encodeRepoTree`, `decodeRepoTree` and
`REPO_TREE_CACHE_VERSION`.

`syncRepositoryToHandout` is the only entry point anything imports (the worker and
`scripts/PushChangesToRepoFromHandout.ts`), so nothing else depends on the deleted code.

## 11. Open questions

1. ~~Commit date.~~ Decided 2026-11-01: `H`'s committer date (§5.7).
2. **`merge-file` conflict style.** Should `diff3` labels show up anywhere a student can see
   them? Today they never do, because conflicted output is discarded. Keep it that way.
3. **Blobless student fetch.** §5.2 uses full depth-1 fetches so `push` can exclude shared
   objects. A student who committed large files makes that download large (disk, not memory).
   Evaluate `--filter=blob:none` with `push.negotiate=true` as an optimization once the baseline
   path is proven.
4. **Moving `classifyHandoutDirection` local.** It could use `git merge-base --is-ancestor`
   against a treeless template fetch (`--filter=tree:0`, full history), which removes the last
   REST compare from the forward path. Not needed for resilience, so it's deferred.
5. **Egress policy.** Plain `NetworkPolicy` (443 to anything outside the cluster CIDRs) or a
   `CiliumNetworkPolicy` with `toFQDNs` for GitHub's hostnames (§8.5). This depends on what the
   prod cluster's Cilium allows for a namespace-scoped policy.
