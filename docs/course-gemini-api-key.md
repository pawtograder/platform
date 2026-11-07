# Course Gemini API key (#1126)

Each course can store one Gemini API key, which active instructors manage from Course Settings. Two PRs deliver it:

- **#1160 (backend):** migration `20261028160000_course_gemini_api_key.sql`, its RPCs, and its tests.
- **#1161 (UI):** the settings page.

Storing a key does not validate it with Google and does not turn on AI grading. Worker credential retrieval, provider validation and AI grading are out of scope for #1126.

## Storage and access

- **Where the key lives:** only in Supabase Vault (`vault.secrets`). `course_secrets.course_gemini_api_keys` maps a class to the Vault secret it owns. The `course_secrets` schema is not exposed through PostgREST, and no client role has `USAGE` on it.
- **RPCs:** `get_course_gemini_key_status`, `set_course_gemini_key` and `remove_course_gemini_key`.
  - All three are `SECURITY DEFINER` with `search_path = ''`.
  - `set_course_gemini_key` and `remove_course_gemini_key` check active instructor membership (`authorizeforclassinstructor`) before taking the class row lock and again after it. `get_course_gemini_key_status` is read-only: it checks once and takes no lock.
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

## Privileged database tests

The privileged specs (`tests/e2e/course-gemini-key-*.spec.ts`) connect as `postgres`. They refuse any database without the `byok-disposable-db-marker` Vault secret and the matching `BYOK_TEST_DB_*` variables.

**Running the specs locally:** on a local stack without the marker they fail rather than skip; this is deliberate. To run them on a disposable stack:

1. Create the marker with the SQL from the `deploy.yml` step, `vault.create_secret(<random hex>, 'byok-disposable-db-marker', ...)`.
2. Export `BYOK_TEST_DB_URL`, `BYOK_TEST_DB_FINGERPRINT` (the marker's sha256) and `BYOK_TEST_DB_EXPECTED_PORT`.

## PostgreSQL logging (accepted limitation)

**Decision (2026-11-04).** Jon asked that the PostgreSQL logging configuration stay as it is: "Please don't change `log_parameter_max_length=0`, it's fine as it is" ([#1160 comment](https://github.com/pawtograder/platform/pull/1160#issuecomment-6637901261)). The chart is unchanged, so the disclosure below still applies. It is a documented limitation, not a merge or deployment gate for #1126. The tested mitigation and the alternatives are kept here for future infrastructure work; none of them is deployed.

**The disclosure.** PostgREST sends the RPC body as bind parameter `$1`. The chart sets `log_min_duration_statement: "1000"` and leaves `log_parameter_max_length` at its default, `-1`. A successful `set_course_gemini_key` that takes a second or more is therefore logged with the key in `DETAIL: Parameters: $1 = '{..."p_api_key":"..."}'`.

The likeliest cause is waiting 1 to 2 s on the class row lock, below the RPC's 2 s `lock_timeout`. This was reproduced with a synthetic key through Kong and PostgREST on a disposable stack.

The error paths, `RAISE LOG` lines, lock-wait lines and `pg_stat_statements` did not contain the key.

**Mitigation tested locally:** `log_parameter_max_length = 0`.

- The same slow save logged no key.
- The duration line, statement text, lock-wait, ERROR/STATEMENT and `RAISE LOG` lines were all still written.
- A configuration reload applied to PostgREST connections that were already open.

These tests used Postgres 17.6.1.132 with a hand-rendered copy of the chart's `postgresql.conf`. They did not use the chart's image (17.4.1.075), a Helm render, or staging.

**Why it is not in this PR.** The setting belongs in `postgres.config` in `charts/pawtograder/values.yaml`. Changing that block alters the Postgres pod's `checksum/config` annotation, so the primary and the replica both restart. That needs a chart minor version bump (enforced by `postgres-restart-gate.sh`) and a maintenance window (`docs/operations/planned-maintenance.md`). It applies to the shared database, so the decision was Jon's (see above).

**Other approaches considered, none validated for deployment:**

| Approach                                                    | Why it wasn't chosen                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ALTER ROLE authenticator SET log_parameter_max_length = 0` | Covers PostgREST only. Pooled connections keep the old value until recycled. Lost on a `pg_dump` restore. Needs a superuser on image 17.4.1.075. |
| `ALTER DATABASE ... SET`                                    | Setting this parameter requires a superuser, and `postgres` is not one on Supabase. Dropped by `pg_dump` without `--create`.                     |
| A function-level `SET` on the RPC                           | Ineffective: the duration line is written after the function's settings are restored.                                                            |
| An operator `ALTER SYSTEM` + reload                         | Takes effect without a restart, but leaves configuration outside git.                                                                            |

While the current configuration is in place, anyone who can read an environment's PostgreSQL server logs may see keys saved there by a slow `set_course_gemini_key` call.
