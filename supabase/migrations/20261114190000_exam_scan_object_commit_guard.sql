-- No storage write can change a linked scan page's object once the link has committed (#1078 review).
--
-- The exam-scans policies (20261114133700) refuse staff writes to an object a linked page refers
-- to, but Storage (storage-api) tests an upload's policy before it receives the bytes and then
-- records the object as a privileged role without testing again; moves work the same way. So an
-- upload authorized just before matching linked the page could still replace its bytes afterwards.
--
-- This guards the commit itself: a trigger on storage.objects refuses an INSERT, or an UPDATE that
-- changes version, name or bucket, of an exam-scans object a linked page refers to, whatever role or
-- API path wrote it. The check and the linking are serialized on a transaction-scoped advisory lock
-- keyed on the object name:
--   - the trigger takes the lock exclusively for the object's (new) name, then checks for a linked
--     page in a separate statement, which under READ COMMITTED sees everything committed before the
--     lock was granted;
--   - the page guard takes the same lock in shared mode, for every role, whenever it sets a page's
--     link (UPDATE, or INSERT of an already-linked page) or changes a linked page's image_path.
-- Whichever takes the lock first commits first: a link that commits first is seen and the write is
-- refused; a write that commits first happened before the page was linked, which is allowed.
-- The fresh snapshot exists only at READ COMMITTED (a REPEATABLE READ or SERIALIZABLE transaction
-- keeps the snapshot from its first statement, taken before the lock), so the trigger refuses
-- exam-scans writes at any other isolation level. Storage and the app use the default, READ COMMITTED.
--
-- Lock order: a storage-api write changes one object per transaction, so it takes one of these locks
-- (its object's new name), after its own row and object locks, and waits on nothing else afterwards.
-- Links take shared locks, which never wait on each other, so pages that share an image_path cannot
-- make two matching passes wait on each other. Every wait therefore ends at a storage write that is
-- not waiting, and no cycle is added. A single SQL statement that writes several exam-scans objects
-- takes several exclusive locks and can deadlock with a multi-page link; Postgres aborts one of them.
-- Hash collisions only serialize unrelated names.
--
-- Not covered: DELETE, and the source of a rename. Staff deletes are refused by the delete policy; a
-- delete or a move away that races a link leaves the page without its object, which matching and
-- finalize report as a download error instead of using other bytes. Direct storage-backend writes
-- and service-role deletes are outside this guard.
-- Restoring data only (no DDL) into a schema that already has this trigger needs triggers disabled
-- (session_replication_role = replica), since restored objects would otherwise meet linked pages.
--
-- Rollback:
--   drop trigger exam_scan_object_commit_guard on storage.objects;
--   drop function exam_private.refuse_write_to_linked_scan_object();
--   restore public.exam_scan_page_membership_guard() from 20261114133700_exam_scan_linked_page_content_guard.sql

create or replace function exam_private.refuse_write_to_linked_scan_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.bucket_id is distinct from 'exam-scans'
     and (tg_op = 'INSERT' or old.bucket_id is distinct from 'exam-scans') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.version is not distinct from old.version
     and new.name is not distinct from old.name
     and new.bucket_id is not distinct from old.bucket_id then
    return new; -- metadata, owner or access-time updates do not change the object
  end if;
  -- Moving a linked object away (checked without the lock; see the header).
  if tg_op = 'UPDATE' and old.bucket_id = 'exam-scans'
     and (new.name is distinct from old.name or new.bucket_id is distinct from old.bucket_id)
     and exists (
       select 1 from public.exam_scan_pages p
       where p.image_path = old.name and p.scanned_submission_id is not null
     ) then
    raise exception
      'scan object % belongs to a linked scan page; refusing to change the object of a linked scan page', old.name;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception
      'exam-scans objects can only be written at READ COMMITTED (this transaction is %); the linked-page check needs a fresh snapshot',
      current_setting('transaction_isolation');
  end if;
  if new.bucket_id = 'exam-scans' then
    perform pg_advisory_xact_lock(hashtextextended('exam-scans/' || new.name, 0));
    if exists (
      select 1 from public.exam_scan_pages p
      where p.image_path = new.name and p.scanned_submission_id is not null
    ) then
      raise exception
        'scan object % belongs to a linked scan page; refusing to change the object of a linked scan page', new.name;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function exam_private.refuse_write_to_linked_scan_object() from public, anon, authenticated, service_role;

drop trigger if exists exam_scan_object_commit_guard on storage.objects;
create trigger exam_scan_object_commit_guard
  before insert or update on storage.objects
  for each row execute function exam_private.refuse_write_to_linked_scan_object();

-- The page guard from 20261114133700, plus the shared lock when a link is set (every role).
create or replace function public.exam_scan_page_membership_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_page public.exam_scan_pages;
begin
  if tg_op <> 'DELETE' and new.scanned_submission_id is not null
     and (tg_op = 'INSERT'
          or new.scanned_submission_id is distinct from old.scanned_submission_id
          or new.image_path is distinct from old.image_path) then
    perform pg_advisory_xact_lock_shared(hashtextextended('exam-scans/' || new.image_path, 0));
  end if;
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
