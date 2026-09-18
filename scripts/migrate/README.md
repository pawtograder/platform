# Managed → self-hosted migration

One-time copy of Pawtograder from the managed supabase.com project to the
Khoury self-hosted chart (`pawtograder-prod` on the Rancher cluster). Full copy,
**UUIDs preserved**, so GitHub SSO on the new host reuses each user's identity
and all history stays linked. No downtime on managed and no read-only freeze:
`pg_dump` snapshots consistently without blocking writers, and the only writes
not captured are the summer class you are not migrating.

## Prerequisites

- `pg_dump`, `pg_restore`, `psql` (client v15+), `kubectl`, `node` (run from
  `platform/`, which has `@supabase/supabase-js` + `.env.local`).
- `prod-charts/kubeconfig` present (used automatically).
- **Managed direct Postgres URL** (the dedicated IPv4, port **5432**, _not_ the
  Supavisor pooler). Put it in `scripts/migrate/managed.env` (gitignored):
  ```
  MANAGED_DB_URL=postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres?sslmode=require
  ```
  Managed API URL + service-role key are read from `platform/.env.local`.

## Preconditions on the target

- Chart deployed and healthy (schema built by the migrations image + GoTrue +
  storage-api; the three storage buckets already exist).
- **Do NOT run `bootstrap-admin.sql` first** — load onto an empty `auth.users`
  so the migrated admin doesn't collide. (`20-` aborts if it finds users; set
  `FORCE=1` only if you know why.)
- Managed and target must be at the **same public migration head** — `10-` prints
  managed's; compare to the deployed chart's Pawtograder image tag. Reconcile
  before loading.

## Run order (from `platform/`)

```bash
scripts/migrate/10-dump-managed.sh          # auth+public dump + storage object list
CONFIRM=1 scripts/migrate/15-wipe-selfhosted.sh   # OPTIONAL: clear test data first
scripts/migrate/20-load-selfhosted.sh       # port-forward + data-only restore
scripts/migrate/30-sync-storage.sh          # copy bytes via the Storage API
```

Run `15-` only if the target already has test data — it TRUNCATEs all `public`

- `auth` tables (keeps schema, buckets, `auth.schema_migrations`). Destructive;
  requires `CONFIRM=1`.
  Everything lands in `scripts/migrate/.work/` (gitignored). Review
  `.work/restore.log` — only duplicate-key warnings on benign seed rows are
  expected.

## Verify

- Log in on the new host as a real GitHub user → same profile, history visible,
  avatar renders (storage), a class page loads.
- `SELECT count(*)` parity on `classes`, `user_roles`, `submissions` vs managed.

## Known managed↔chart schema drift (fixups after 20-)

Managed and the deployed chart report the **same migration head** (382 / head
`20260707130000`) but managed's actual schema has drifted from it: managed's
build carries features the deployed chart lacks. `pg_restore` therefore skips a
few things (exit 1, "errors ignored"). Verified impact and fixups:

- **`assignments` — the one real blocker.** Managed has 8 phantom columns not in
  the chart schema (`grading_default_profile_id`, `auto_assign_*`,
  `late_grading_*`); the whole COPY was rejected → 0 rows. The columns hold no
  real data (feature toggles all off; the rest are just non-null defaults), so
  reload against the chart's column set:
  ```sh
  COLS='<the 49 chart columns>'  # select col list from information_schema on the target
  psql "$MANAGED_DB_URL" -c "\copy (select $COLS from public.assignments) to stdout" \
    | admin_psql -c "set session_replication_role=replica" -c "\copy public.assignments ($COLS) from stdin"
  ```
- **`assignment_leaderboard`** — 1 legacy row violates the chart's
  `check_score_bounds (autograder_score <= max_score)`. Reload the valid rows:
  `... where autograder_score <= max_score`. (It's a regenerable cache.)
- **Harmless / empty:** `grading_assignment_default_profiles`,
  `assignment_grading_automation_state`, `auth.custom_oauth_providers`,
  `auth.webauthn_*` (all 0 rows); `workflow_events_archive` (97k rows, a manual
  archive table not in the app schema).

> **Strategic note:** the deployed chart is effectively an older/different build
> than managed (missing late-grading-reminders, reviewer auto-assign, newer
> GoTrue). If you want those features, redeploy a chart built from the same
> platform ref as managed and re-run the migration — a migration-head string
> match does NOT guarantee schema parity.

## What is intentionally NOT copied

- **`auth.sessions` / `refresh_tokens`** — users just re-auth; identities
  (UUID + provider subject) are what carry over.
- **`lti_tool_keys`** (encrypted with the managed `LTI_KEY_ENCRYPTION_SECRET`) —
  regenerate on first use. Add the new host's `/api/lti/{login,launch}` redirect
  URIs to the Canvas Developer Key.
- **`public.audit*`** (partitioned audit log + all daily partitions) — churn,
  and data-only dumps of partitioned tables restore badly.
- **`storage.*` schema rows** — rebuilt by the Storage API uploads in step 3.
- The **summer class** still runs on managed. Do not enable the self-hosted
  GitHub App on that org, so managed keeps ingesting/grading it untouched.

## Cutover model (no in-flight disruption)

Grading destination is pinned per-repo by `grade.yml`'s `grading_server`:

- New assignments → new repos inherit the self-hosted host from the org/class
  template defaults → grade on self-hosted.
- Existing repos keep the managed `grading_server` → in-flight assignments
  finish on managed. Do nothing to them.
- Decommission managed only after the summer class ends **and** in-flight
  migrated-class assignments have finished grading there.
