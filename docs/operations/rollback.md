# Rollback (app rollback with forward-only migrations)

How to roll a bad prod release back safely when migrations are **forward-only**.
This is the runbook PRODUCTION-READINESS §5 tracks as missing ("roll app back,
leave schema forward").

The central constraint: Pawtograder migrations have **no down step**. The
migration runner (`charts/pawtograder/images/migrations/migrate.sh`) applies
`supabase/migrations/*.sql` in order, records each in
`supabase_migrations.schema_migrations` with a content hash, and on re-run
**skips** anything already applied. It never reverses a migration. So "rollback"
means *roll the application image back and leave the schema where it is* — which
is safe only when the newer schema is backward-compatible with the older app.

---

## Decision: is this a safe app-only rollback?

```
Did the bad release ship a schema migration?
├── No  → plain app rollback (§A). Safe, fast.
└── Yes → Is that migration backward-compatible with the previous app?
          (additive only: new nullable columns / new tables / new functions,
           no drops, no renames, no NOT NULL added to an existing column,
           no type narrowing)
          ├── Yes → app-only rollback, leave schema forward (§B).
          └── No  → schema is NOT safely reversible (§C):
                    forward-fix, or restore from backup accepting data loss.
```

The migrations changed in a release are the `supabase/migrations/*.sql` files
added in that release's diff. Read them before deciding — an "additive" release
is only additive if **every** new migration is.

---

## A. Plain app rollback (no schema change)

Re-pin the previous known-good image tags and re-apply the chart. Images are
pinned by tag in the prod values file (never a floating `*-latest` tag — the
prod render guard refuses those).

```bash
# In the prod values overlay, set the web/edge/migrations image tags back to
# the last-good release, then:
helm upgrade <release> charts/pawtograder \
  -n "$NS" -f <your-prod-values>.yaml --wait
```

`--wait` blocks until the rolled-back pods are Ready. The migrations Job re-runs
(its name is keyed to the Helm revision) but is idempotent: with no new
migration files it applies nothing and exits `applied=0`. Finish with the
[smoke checklist](./production-install.md#smoke-test).

> **`helm rollback` vs. re-pinning tags.** `helm rollback <release> <rev>`
> restores the previous *release manifest*, which also reverts the pinned image
> tags — so it works too. Prefer editing the values file and `helm upgrade`
> when the values file is your source of truth (GitOps), so the committed state
> matches the cluster. Either way a fresh migrations Job runs; that is safe
> (idempotent, forward-only).

## B. App-only rollback, schema stays forward (additive migration)

When the bad release added schema but the addition is backward-compatible, the
old app runs fine against the new schema (it just ignores the new columns /
tables). Roll the **app** back exactly as in §A. **Do not** try to remove the
migration:

- Deleting the migration file does **not** undo it (the row stays in
  `schema_migrations`; the object stays in the DB).
- Editing the applied migration file trips **drift detection** on the next run
  (`stored_sha != on_disk_sha`) and the migrator fails loudly. If you must
  change what a migration did, write a *new* migration with a fresh timestamp.

So: roll the image back, leave the schema forward, and if the new schema
objects are genuinely unwanted, retire them with a **new forward migration**
(e.g. `DROP TABLE IF EXISTS ...`) rather than un-applying the old one.

## C. Schema is not safely reversible

A migration that dropped or renamed a column, narrowed a type, or added a
`NOT NULL` to existing data cannot be undone by rolling the app back — the old
app will hit a schema it can't read, and the dropped data is gone. Two options,
worst-case first:

1. **Forward-fix (preferred).** Ship a new migration + app build that corrects
   the problem. Almost always faster and lossless compared to a restore. This is
   the expand/contract discipline: never ship a destructive migration coupled to
   the same release that stops using the old shape — split it across two
   releases so a rollback target always exists.
2. **Restore from backup (last resort, lossy).** Follow
   [disaster-recovery.md](./disaster-recovery.md) §B. This reverts the schema
   *and* the data to the last backup, so you lose every write since that backup
   (RPO up to one backup interval). Only when a forward-fix is impossible and the
   data corruption is worse than the loss.

---

## Preventing the §C case

- **Expand/contract migrations.** Release N adds the new shape and dual-writes;
  release N+1 removes the old shape once N is proven. A rollback from N+1 to N
  is then always safe.
- **Never a destructive migration in the same release that stops reading the old
  column.** That couples app and schema so tightly that no rollback target
  exists.
- **Keep the previous image tags pinned and reachable** (don't let retention
  garbage-collect the last-good web/edge images) so §A/§B is always available.

## Related

- [disaster-recovery.md](./disaster-recovery.md) — the restore path §C falls
  back to.
- [production-install.md](./production-install.md) — the smoke checklist to run
  after any rollback.
- PRODUCTION-READINESS §5 — tracks the automated post-deploy smoke gate that
  should catch a bad release before you need this runbook.
