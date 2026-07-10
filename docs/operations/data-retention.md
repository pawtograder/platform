# Data Retention & Storage Sizing

Where Pawtograder keeps application data, how to size storage for it, and how
you would enforce an age-based retention policy ("delete data older than N
years"). It complements [`disaster-recovery.md`](./disaster-recovery.md) (which
is about *not losing* data). This doc is about *bounding* and *removing* it.

> **State of play.** There is **no automated deletion or read-only policy
> today.** Only the audit log self-prunes (90-day partitions, §5). Everything
> else grows monotonically. The working assumption for the Khoury-operated
> deployment is a **≥ 7-year** retention window (the college's usual), with cold
> data tiered to object storage / Azure. This doc documents the current
> mechanics and the procedure you would run; the class-level purge and the S3
> lifecycle it needs are **not built yet** — see §6.

---

## 1. Where data lives — three planes

Application data spans three independent stores. A retention action on a class
touches **all three**; deleting from one orphans the others.

| Plane | What | Anchor |
|-------|------|--------|
| **Postgres** (in-cluster) | Row metadata + inline grader text (scores, run summaries, workflow events, discussion, gradebook, audit) | `public.classes` |
| **S3** (`storage.s3.bucket`) | Submission files, grader artifacts, grader bundles, uploads, avatars | `classes/{class_id}/` prefix |
| **GitHub org repos** | Student / handout / grader repositories | the class's `github_org` |

`public.classes` is the tenant root. Note there is **no separate term/course
table** — a class row *is* the offering, and `classes.semester` (a `smallint`)
plus `classes.created_at` are the only age signals at the tenant level.

### Postgres — the bulk-growth tables
Every table below carries a `class_id` FK and a `created_at timestamptz`, so
age- and tenant-scoped deletion is feasible per table.

- **`submissions`** — one row per attempt (`assignment_id`, `profile_id`, `sha`, `repository`).
- **`grader_results`** / **`grader_result_output`** / **`grader_result_tests`** / **`grader_result_test_output`** — autograder run summary and **full stdout/stderr and per-test output stored inline as `text`**. This is the largest DB-side consumer.
- **`submission_files`** — text file bodies inline (`contents text`); binary files live in S3 referenced by `storage_key` (`file_size`, `mime_type`, `is_binary` added in `20260217000000_binary_submission_files.sql`).
- **`submission_artifacts`** — grader-produced artifacts; metadata `data jsonb`, bytes in S3.
- **`workflow_events`** / **`workflow_runs`** / **`workflow_run_error`** — GitHub Actions lifecycle log (`payload jsonb`); several rows per run.
- **`audit`** — highest write volume; day-partitioned and self-pruning (§5).
- **`notifications`**, **`discussion_threads`**, **`gradebook_column_students`** (one row per student per column), **`repository_check_runs`**, **`emails`/`email_batches`**, and the usage logs (**`llm_inference_usage`**, **`api_gateway_calls`**, **`assignment_dashboard_views`**, **`student_help_activity`**).

### S3 — one physical bucket, logical prefixes
`charts/pawtograder/templates/storage.yaml` sets `GLOBAL_S3_BUCKET` from
`storage.s3.bucket` (default `pawtograder`; prod `pawtograder-prod-storage`).
Supabase "buckets" are logical prefixes inside that one bucket:

- `submission-files` (private) — **binary submission files (bulk).**
- `submission-artifacts` (private) — **grader artifacts (bulk).**
- `graders` (private) — grader bundles/archives.
- `uploads` (**public**) — user uploads.
- `avatars` — profile images.

Object keys are class-scoped and deterministic
(`20260217000000_binary_submission_files.sql`):

```
classes/{class_id}/profiles/{profile_or_group_id}/submissions/{submission_id}/files/{filename}
```

So **all objects for a class share the prefix `classes/{class_id}/`** — a
class-scoped prefix delete is possible. There is **no timestamp in the key**;
object age comes from the owning DB row (`submissions.created_at` /
`submission_files.created_at`) or the S3 object's `LastModified`.

### PII / grades
`profiles` (`name`, `sortable_name`, `sis_user_id`, `avatar_url`, per class),
`users` (`github_username`), `user_roles` (`canvas_id`); grades in
`gradebook_column_students` (`score`, `score_override`), `grader_results.score`,
`submission_reviews`; free text in `discussion_threads.body`,
`help_request_messages.message`, `emails`, `notifications` jsonb; `audit.ip_addr`
and `audit.old/new` jsonb. `pgsodium`/`vault` encrypt **server secrets only**
(e.g. `assessment-export-pepper`, integration keys) — student grades and
submissions are plaintext columns.

## 2. Storage sizing methodology

Two pools grow on very different curves. Size them independently.

**Object store: dominant, unbounded.** Driven by submission artifacts:

```
object_store ≈ students × assignments × submissions_per_assignment × avg_artifact_size
```

Typical artifact is a ~12 MB image; repo snapshots run up to ~100 MB. It grows
monotonically (no deletion policy today), so size it for the **full retention
window** (≥ 7 years) unless you add lifecycle tiering (§6). Real anchor: all
data this year ≈ **45 GB** with submission files already moved out of Postgres
into S3 (`work/pawtograder/meetings/2026-07-09-khoury-systems-deploy-mechanics.md`);
Khoury's NetApp bucket floor is 95 GB against an 8 TB (newer 60 TB) backend.

**Postgres PVC: modest, slow.** ~20–45 GB observed for ~1,500 NU users
(`work/pawtograder/meetings/2026-06-04-cmu-timperley-hilton.md`,
`.../2026-07-09-...`). Driven by row metadata, the inline grader-output `text`
columns, and the audit log. The chart's PVC ladder is **50Gi default → 100Gi
staging → 200Gi prod** (`charts/pawtograder/values.yaml`,
`examples/values-*.yaml`); the standby PVC matches the primary. **NetApp Trident
volume expansion is supported** on the Khoury cluster (confirmed 2026-07-09), so
start at 200Gi and grow rather than over-provisioning.

**Three S3 pools, sized and kept separate** (all versioned):

| Pool | Values key | Ceiling |
|------|-----------|---------|
| App storage | `storage.s3.bucket` | full retention window (see formula above) |
| Nightly dumps | `backup.s3.bucket` | ≈ compressed `pg_dump` × `backup.retentionDays` (14 default / 30 prod) |
| WAL-G / PITR | `postgres.walg.s3Prefix` | ≈ `keepBackups` × base-backup + WAL over `intervalHours × keepBackups` (~8 days) |

Keep the WAL-G prefix in its **own bucket** — the nightly-dump job installs a
*bucket-wide* ILM expiry rule, which would otherwise prune WAL-G objects and
break PITR. See [`production-install.md`](./production-install.md) §3.

## 3. Operationalizing "delete data older than N years"

A retention purge is **per-class and multi-store**. Worked example, N = 7 years:

1. **Select classes to purge.** `SELECT id, github_org FROM public.classes WHERE created_at < now() - interval '7 years'` (or filter on `semester`). A class row is the term anchor.
2. **Delete Postgres rows, leaf → root.** There is **no single-row cascade**: only ~51 of 103 FKs to `classes(id)` are `ON DELETE CASCADE`, and the load-bearing ones are not (`submissions_class_id_fkey`, `workflow_events` are RESTRICT), so `DELETE FROM classes` fails while children exist. Reuse the ordering already encoded in the RPC **`delete_assignment_with_all_data(p_assignment_id, p_class_id)`** (`supabase/migrations/20260417140000_cleanup_individual_assignment_repositories.sql`, called by `supabase/functions/assignment-delete/index.ts`), which walks ~20 tables leaf→root (regrade comments → regrade requests → artifact comments → artifacts → file comments → files → comments → grader test output → grader tests → grader output → grader results → review assignments → reviews → submissions → check runs → workflow events → workflow errors → repositories). A class-level purge is the same shape, scoped by `class_id` instead of `assignment_id`, run for each assignment in the class and then the class-level tables. **This class-level walk does not exist yet** (§6).
3. **Delete S3 objects (separately).** DB deletion does **not** remove S3 objects (`delete_assignment_with_all_data` has no storage calls), so rows deleted in step 2 orphan their blobs. Delete the `classes/{class_id}/` prefix directly (e.g. `mc rm --recursive s3/<bucket>/classes/{class_id}/`). To avoid orphans in the other direction, reconcile against `submission_files.storage_key` and the artifact keys **before** deleting the rows, or capture the key list first.
4. **Archive/delete GitHub repos.** Mirror the `assignment-delete` behavior (archive or delete student/handout/grader repos in the class's `github_org`).

Order matters: capture S3 keys → delete/settle GitHub → delete S3 prefix → delete DB rows. Do it in a transaction per class for the DB portion, and log what was removed.

## 4. Read-only / cold tiering (alternative to deletion)

The front end already reads submission content from the S3 bucket directly, so
"cold" classes can be made effectively read-only by tiering their
`classes/{class_id}/` prefix to cheaper storage (S3 IA / Glacier, or the
approved NetApp→Azure path) rather than deleting. This preserves the ≥ 7-year
record without keeping it on hot NetApp. Not implemented — tracked in §6.

## 5. Audit log & partition maintenance

The audit trail is an **in-DB table `public.audit`**, written by `SECURITY
DEFINER` statement-level triggers on ~18 mutating tables — **not** `pgaudit`
(the extension is preloaded in `postgres.sharedPreloadLibraries` but left
unconfigured, so it emits nothing). Columns: `created_at`, `class_id`,
`user_id`, `"table"`, `old/new jsonb`, `ip_addr`. The API grants no
UPDATE/DELETE/TRUNCATE, so rows are immutable through the app.
(`supabase/migrations/20251228143943_partitioned_audit_system.sql`.)

**Partitioning.** `public.audit` is `PARTITION BY RANGE (created_at)` with **one
partition per day**, child tables named `audit_YYYYMMDD` (identified by regex
`^audit_[0-9]{8}$`).

**Maintenance.** `public.audit_maintain_partitions()` does both jobs: it creates
partitions **7 days ahead** and **drops any partition older than 90 days**
(`CURRENT_DATE - 90`, `DROP TABLE … CASCADE`). It runs from **two schedulers**
(redundant, both call the same function):

- pg_cron job `audit-partition-maintenance` at `0 0 * * *` (00:00 UTC).
- k8s CronJob `charts/pawtograder/templates/audit-partitions.yaml` (gated on `auditPartitions.enabled`, `charts/pawtograder/values.yaml:1207`) at `0 3 * * *` (03:00 UTC).

**Operator actions.**

- Run maintenance on demand: `SELECT public.audit_maintain_partitions();`
- Drop a specific old partition (destroys data): `DROP TABLE public.audit_20250101;`
- Retain the data outside the parent instead of dropping: `ALTER TABLE public.audit DETACH PARTITION public.audit_20250101;` then archive it.

**Caveats.**

- The **90-day window is hardcoded** in the function — changing it means a new migration, not a values setting.
- The pre-partition table **`audit_legacy`** was renamed "for later cleanup" and has **no automated cleanup**; drop it manually once you've confirmed it's not needed.
- If maintenance stops running for **> 7 days**, new inserts fail with `no partition of relation "audit" found for row` — monitor the CronJob.
- The audit table's 90-day window is a **separate, much shorter regime** than the ≥ 7-year class-data policy; they don't interact.

## 6. Gaps & recommendations

- **No class-level purge exists.** Generalize `delete_assignment_with_all_data` into a `delete_class_with_all_data(p_class_id)` RPC (same leaf→root walk) so §3 step 2 is one call.
- **DB deletes orphan S3.** Have the purge RPC return the affected `storage_key`s (or add a companion job) so S3 cleanup is driven off the DB, not a blind prefix delete.
- **Other tables grow unbounded.** `workflow_events`, `grader_result_output`/`grader_result_tests`, `notifications`, `api_gateway_calls`, `llm_inference_usage` are good candidates for the **same day-partition + cron-drop model** the audit table already uses.
- **Make audit retention configurable** — surface the 90-day literal as `auditPartitions.retentionDays` rather than a hardcoded migration value.
- **Add S3 lifecycle / tiering** for §4 (IA/Glacier or NetApp→Azure), keyed on the `classes/{class_id}/` prefix and class age.

## Related

- [Disaster Recovery](./disaster-recovery.md) — backup layout and restore.
- [Point-in-Time Recovery & Failover](./point-in-time-recovery.md) — WAL-G retention.
- [Production Install](./production-install.md) §3 — the three S3 buckets and their expiry rules.
- [`../../charts/pawtograder/PRODUCTION-READINESS.md`](../../charts/pawtograder/PRODUCTION-READINESS.md) — what's hardened vs deferred.
