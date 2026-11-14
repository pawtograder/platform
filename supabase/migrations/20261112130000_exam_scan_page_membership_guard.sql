-- Only matching may change which scanned exam a scan page belongs to.
--
-- finalize builds a student's submission from the pages linked to their scanned exam
-- (exam_scan_pages.scanned_submission_id, in page_index order) and stamps finalized_at, after
-- which it is never rebuilt. Staff could change those links through the API after matching, so a
-- grader could finalize an exam missing a page, holding an extra one, or holding another
-- student's. Rebuilding the expected grouping inside finalize would not hold: it would depend on
-- exams.num_pages, which exam_create can still change after matching, and on page_index and
-- exam_index, which staff can write.
--
-- So for user roles (authenticated, anon) this refuses:
--   - inserting a page already linked to a scanned exam;
--   - changing any page's scanned_submission_id;
--   - changing a linked page's page_index, image_path or batch_id;
--   - deleting a linked page.
-- Matching runs as the service role and relinks every group when a batch is (re)processed, which
-- is the way to change a page's exam. Nothing in the app, its RPCs or the seeder writes these
-- columns as a user role, and foreign-key actions (a deleted batch or scanned exam) run as the
-- table owner, so cascades are unaffected.
--
-- This only stops new changes. It does not check rows linked before it was applied, or writes made
-- with the service role; finalize itself still rejects only an exam with no pages.

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
                 or new.batch_id is distinct from old.batch_id))))
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
  before insert or update of scanned_submission_id, page_index, image_path, batch_id or delete
  on public.exam_scan_pages
  for each row execute function public.exam_scan_page_membership_guard();
