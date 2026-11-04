# Course Gemini API key (#1126)

Each course can store one Gemini API key, which active instructors manage from Course Settings. Two PRs deliver it:

- **#1160 (backend):** migration `20261028160000_course_gemini_api_key.sql`, its RPCs, and its tests.
- **#1161 (UI):** the settings page.

Storing a key does not validate it with Google and does not turn on AI grading. Worker credential retrieval, provider validation and AI grading are out of scope for #1126.

## Storage and access

- **Where the key lives:** only in Supabase Vault (`vault.secrets`). `course_secrets.course_gemini_api_keys` maps a class to the Vault secret it owns. The `course_secrets` schema is not exposed through PostgREST, and no client role has `USAGE` on it.
- **RPCs:** `get_course_gemini_key_status`, `set_course_gemini_key` and `remove_course_gemini_key`.
  - All three are `SECURITY DEFINER` with `search_path = ''`.
  - Each checks active instructor membership (`authorizeforclassinstructor`) before taking the class row lock, and again after it.
  - None returns key material or secret ids, and errors use fixed messages.
- **`service_role` has no path through the RPCs.** It holds `EXECUTE`, and `migrate.sh` Phase 3.5 re-grants every `public` function to it on chart deploys. But every RPC rejects a caller without `auth.uid()`, and called as `service_role` all three return `42501 Access denied`.
- **Concurrency and lifecycle:**
  - Mutators take the class row `FOR NO KEY UPDATE`, which serializes them.
  - An `AFTER DELETE` trigger on the mapping deletes the owned Vault secret, both for removal and for the cascade from `DELETE FROM classes`.
  - `TRUNCATE` of the mapping is refused.
- **Feature flag:** `gemini-api-key-setup` (course feature, default off) gates save and replace; status and removal work either way. Instructors can turn it on themselves from the Feature flags page, so it is **not** an operator kill switch.

## Rollback

Migrations are forward-only, and this one is additive. Rolling the app back leaves this schema in place (`docs/operations/rollback.md` §B); reverting the PR does not undo it.

To stop new saves and replacements, ship a forward migration:

```sql
REVOKE EXECUTE ON FUNCTION public.set_course_gemini_key(bigint, text) FROM authenticated;
```

Status and removal keep working, and stored keys and deletion cleanup are unchanged. To stop all browser access, also revoke `get_course_gemini_key_status(bigint)` and `remove_course_gemini_key(bigint)` from `authenticated`.

## Why the migration timestamp was kept

`20261028160000` sorts before `20261031120000_fail_safe_group_repo_deletes.sql`, which reached `staging` first. It was not renamed. Each claim below was checked on a disposable stack (Supabase CLI 2.105.0) built from `staging` at `3c3e3e78`:

| Path                                                                                                     | Behavior                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment migrator (`charts/pawtograder/images/migrations/migrate.sh`, used for staging and production) | Applies every version missing from `supabase_migrations.schema_migrations`, in filename order, and never compares against the newest applied version. Against a database at staging's state, run as `supabase_admin`: `applied=1 skipped=440`. A rerun gives `applied=0`. |
| CI (`e2e-local` starts a fresh stack)                                                                    | Replays all migrations in filename order with no errors.                                                                                                                                                                                                                  |
| Supabase CLI upgrading an existing local database                                                        | `supabase migration up` refuses: "Found local migration files to be inserted before the last migration". Run `supabase migration up --include-all`, or use the fresh-start sequence in `AGENTS.md`.                                                                       |
| Renaming the file                                                                                        | The previews for #1160 and #1161 already applied `20261028160000`. A renamed copy re-runs `CREATE SCHEMA course_secrets` and fails with `schema "course_secrets" already exists`. Drift detection only checks files on disk, so `resetOnDrift` does not recover it.       |

Out-of-order timestamps are routine here: `staging`'s history has more than a hundred migrations merged after a newer one.

## CI: the disposable-database marker (#1191)

The privileged specs (`tests/e2e/course-gemini-key-*.spec.ts`) connect as `postgres`. They refuse any database without the `byok-disposable-db-marker` Vault secret and the matching `BYOK_TEST_DB_*` variables.

`e2e-local` runs on `pull_request_target`, so it always uses `staging`'s copy of `.github/workflows/deploy.yml`. The step that creates the marker therefore landed on its own, in #1191, before this PR could pass CI.

#1160 no longer changes `deploy.yml`. `e2e-local` checks out the PR head but runs `staging`'s workflow, so the branch has to contain whatever that workflow calls. `staging` now runs `npm run check:delete-paths` (added in #1175), so `staging` was merged into #1160, and then into #1161. After that merge, `deploy.yml` and `package.json` match `staging`, and the workflow has exactly one marker step.

**Running the specs locally:** on a local stack without the marker they fail rather than skip; this is deliberate. To run them on a disposable stack:

1. Create the marker with the SQL from the `deploy.yml` step, `vault.create_secret(<random hex>, 'byok-disposable-db-marker', ...)`.
2. Export `BYOK_TEST_DB_URL`, `BYOK_TEST_DB_FINGERPRINT` (the marker's sha256) and `BYOK_TEST_DB_EXPECTED_PORT`.

## PostgreSQL logging (release gate)

**The disclosure.** PostgREST sends the RPC body as bind parameter `$1`. The chart sets `log_min_duration_statement: "1000"` and leaves `log_parameter_max_length` at its default, `-1`. A successful `set_course_gemini_key` that takes a second or more is therefore logged with the key in `DETAIL: Parameters: $1 = '{..."p_api_key":"..."}'`.

The likeliest cause is waiting 1 to 2 s on the class row lock, below the RPC's 2 s `lock_timeout`. This was reproduced with a synthetic key through Kong and PostgREST on a disposable stack.

The error paths, `RAISE LOG` lines, lock-wait lines and `pg_stat_statements` did not contain the key.

**Mitigation tested locally:** `log_parameter_max_length = 0`.

- The same slow save logged no key.
- The duration line, statement text, lock-wait, ERROR/STATEMENT and `RAISE LOG` lines were all still written.
- A configuration reload applied to PostgREST connections that were already open.

These tests used Postgres 17.6.1.132 with a hand-rendered copy of the chart's `postgresql.conf`. They did not use the chart's image (17.4.1.075), a Helm render, or staging.

**Why it is not in this PR.** The setting belongs in `postgres.config` in `charts/pawtograder/values.yaml`. Changing that block alters the Postgres pod's `checksum/config` annotation, so the primary and the replica both restart. That needs a chart minor version bump (enforced by `postgres-restart-gate.sh`) and a maintenance window (`docs/operations/planned-maintenance.md`). It applies to the shared database, so the approach and the rollout are Jon's decision.

**Other approaches considered, none validated for deployment:**

| Approach                                                    | Why it wasn't chosen                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ALTER ROLE authenticator SET log_parameter_max_length = 0` | Covers PostgREST only. Pooled connections keep the old value until recycled. Lost on a `pg_dump` restore. Needs a superuser on image 17.4.1.075. |
| `ALTER DATABASE ... SET`                                    | Setting this parameter requires a superuser, and `postgres` is not one on Supabase. Dropped by `pg_dump` without `--create`.                     |
| A function-level `SET` on the RPC                           | Ineffective: the duration line is written after the function's settings are restored.                                                            |
| An operator `ALTER SYSTEM` + reload                         | Takes effect without a restart, but leaves configuration outside git.                                                                            |

Until a mitigation is live in an environment, the credential write path must not be deployed there.

## Release gates (status 2026-11-04)

- [ ] **PostgreSQL logging:** Jon approves an approach; it is rolled out before this migration reaches `staging` (and later production); a staging grep of the Postgres logs after a synthetic save finds no key.
- [ ] **CI:** `e2e-local` passes on #1160 and #1161 with #1191 on `staging`. The last runs before #1191 merged failed only on the missing marker.
- [ ] **Vault recovery:** the restore and PITR drills mount the same `PGSODIUM_ROOT_KEY`, but assert only row counts. Decrypting a Vault secret after a restore has not been verified.
- [ ] **Deployment permissions:** under `migrate.sh` the RPCs are owned by `supabase_admin`. That was checked on a disposable database, not on `staging`.
- [ ] **Merge order:** #1160 first, then #1161, retargeted to `staging`.
- [ ] **Staging verification:** with a synthetic key, save, refresh, replace, disable and remove. Confirm students, graders and other courses' instructors cannot read or change the configuration. Record the deployed revision and results on #1126.
