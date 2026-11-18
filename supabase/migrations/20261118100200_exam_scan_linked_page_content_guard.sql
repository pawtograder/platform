-- After matching, staff cannot change what a matched scan page's content is (#1078 review).
--
-- 20261118100000 froze a linked page's link, position, path and batch for user roles. Two other
-- inputs to finalize could still be changed by an authenticated grader or instructor:
--   - the storage object at the page's image_path, which finalize copies into the submission:
--     exam-scans_staff_write was FOR ALL, so staff could overwrite, replace, delete and re-upload,
--     or move it without touching the page row;
--   - the page's ocr_data and ocr_text, from which finalize builds the answers it records.
-- This extends the page trigger to the OCR columns and replaces the storage write policy with
-- per-command policies that refuse any write to an object a linked page refers to. Uploads,
-- retried uploads (upsert) and deletes of objects no linked page refers to work as before. The
-- worker writes OCR and relinks pages as the service role, which neither guard applies to.
--
-- Not covered: service-role or admin writes; content changed before this migration; and uploads
-- racing the moment matching links a page. Storage (storage-api) tests an upload's policy before
-- it receives the bytes and records the object afterwards without testing it again, so an upload
-- already under way when the page is linked can still replace its object; and bytes replaced
-- between OCR and linking leave the stored OCR describing the earlier image. All of these stay
-- within the writer's own course: the policies keep the class check, and the worker still
-- validates every path against the batch it was queued for.
--
-- Rollback:
--   drop policy "exam-scans_staff_insert" on storage.objects;
--   drop policy "exam-scans_staff_update" on storage.objects;
--   drop policy "exam-scans_staff_delete" on storage.objects;
--   recreate "exam-scans_staff_write" as in 20261107120000_exam_grading.sql;
--   drop function exam_private.scan_object_is_linked(text); drop schema exam_private;
--   drop index public.exam_scan_pages_linked_image_path_idx;
--   restore the trigger and function from 20261118100000_exam_scan_page_membership_guard.sql.

-- 1. OCR columns of a linked page.
create or replace function public.exam_scan_page_membership_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_page public.exam_scan_pages;
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  v_page := coalesce(old, new);
  if (tg_op = 'INSERT' and new.scanned_submission_id is not null)
     or (tg_op = 'UPDATE' and (
           new.scanned_submission_id is distinct from old.scanned_submission_id
           or (old.scanned_submission_id is not null and (
                 new.page_index is distinct from old.page_index
                 or new.image_path is distinct from old.image_path
                 or new.batch_id is distinct from old.batch_id
                 or new.ocr_data is distinct from old.ocr_data
                 or new.ocr_text is distinct from old.ocr_text))))
     or (tg_op = 'DELETE' and old.scanned_submission_id is not null) then
    raise exception
      'scan page % belongs to scanned submission %; only matching can change which exam a page belongs to (re-run Process to rematch the batch)',
      v_page.id, coalesce(old.scanned_submission_id, new.scanned_submission_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_exam_scan_page_membership_guard on public.exam_scan_pages;
create trigger trg_exam_scan_page_membership_guard
  before insert or update of scanned_submission_id, page_index, image_path, batch_id, ocr_data, ocr_text
    or delete
  on public.exam_scan_pages
  for each row execute function public.exam_scan_page_membership_guard();

-- 2. Storage objects a linked page refers to.
--
-- The policies need to know whether a linked page refers to an object regardless of which pages
-- the caller may read, so the check is a SECURITY DEFINER function. It lives in a schema PostgREST
-- does not expose (config.toml api.schemas), so it cannot be called through the API.
create schema if not exists exam_private;
comment on schema exam_private is
  'Helpers for exam storage policies. Not exposed through PostgREST; usable by authenticated only.';
revoke all on schema exam_private from public, anon, authenticated, service_role;
grant usage on schema exam_private to authenticated;

create or replace function exam_private.scan_object_is_linked(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.exam_scan_pages p
    where p.image_path = p_name and p.scanned_submission_id is not null
  );
$$;
revoke all on function exam_private.scan_object_is_linked(text) from public, anon, service_role;
grant execute on function exam_private.scan_object_is_linked(text) to authenticated;

create index if not exists exam_scan_pages_linked_image_path_idx
  on public.exam_scan_pages (image_path)
  where scanned_submission_id is not null;

drop policy if exists "exam-scans_staff_write" on storage.objects;

drop policy if exists "exam-scans_staff_insert" on storage.objects;
create policy "exam-scans_staff_insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'exam-scans'
    and exists (
      select 1 from public.user_privileges up
      where up.user_id = auth.uid()
        and up.class_id = (storage.foldername(name))[2]::bigint
        and up.role in ('instructor', 'grader')
    )
    and not exam_private.scan_object_is_linked(name)
  );

drop policy if exists "exam-scans_staff_update" on storage.objects;
create policy "exam-scans_staff_update" on storage.objects for update to authenticated
  using (
    bucket_id = 'exam-scans'
    and exists (
      select 1 from public.user_privileges up
      where up.user_id = auth.uid()
        and up.class_id = (storage.foldername(name))[2]::bigint
        and up.role in ('instructor', 'grader')
    )
    and not exam_private.scan_object_is_linked(name)
  )
  with check (
    bucket_id = 'exam-scans'
    and exists (
      select 1 from public.user_privileges up
      where up.user_id = auth.uid()
        and up.class_id = (storage.foldername(name))[2]::bigint
        and up.role in ('instructor', 'grader')
    )
    and not exam_private.scan_object_is_linked(name)
  );

drop policy if exists "exam-scans_staff_delete" on storage.objects;
create policy "exam-scans_staff_delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'exam-scans'
    and exists (
      select 1 from public.user_privileges up
      where up.user_id = auth.uid()
        and up.class_id = (storage.foldername(name))[2]::bigint
        and up.role in ('instructor', 'grader')
    )
    and not exam_private.scan_object_is_linked(name)
  );
