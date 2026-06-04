-- Storage RLS policies on storage.objects.
--
-- These CANNOT live in a normal migration: storage.objects is owned by
-- supabase_storage_admin, and the migration role (postgres) is neither that
-- owner nor a superuser, so `CREATE POLICY ... ON storage.objects` fails with
-- "must be owner of table objects" during `supabase start` / `db reset` / the
-- managed deploy (the same reason 20260217000000_binary_submission_files.sql
-- left its policies commented out).
--
-- Apply this file as a superuser (supabase_admin) AFTER `supabase start`:
--   docker exec -i supabase_db_<project> \
--     psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U supabase_admin -d postgres \
--     < supabase/storage-policies.sql
-- CI does this in .github/workflows/deploy.yml; see AGENTS.md for local dev.
-- Idempotent — safe to re-run.

-- submission-files: the no-repo (upload) submission flow. Owner, group members,
-- and class graders can read; owner/grader can write. Gated by the existing
-- can_access_submission_storage_path() helper (defined in
-- 20260217000000_binary_submission_files.sql).
drop policy if exists "submission-files owner can read" on storage.objects;
create policy "submission-files owner can read"
  on storage.objects for select to authenticated
  using (bucket_id = 'submission-files' and public.can_access_submission_storage_path(name));

drop policy if exists "submission-files owner can insert" on storage.objects;
create policy "submission-files owner can insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'submission-files' and public.can_access_submission_storage_path(name));
