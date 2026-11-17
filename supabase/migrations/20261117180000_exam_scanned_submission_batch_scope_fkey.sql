-- A scanned exam belongs to a batch of its own course and exam (#1078, review of #1133).
--
-- exam_scanned_submissions.batch_id had a single-column foreign key, and the staff write policy
-- ties only exam_id to class_id. A grader in course A could therefore insert a row for course A's
-- exam that names course B's batch. exam_link_scan_groups keeps an existing row at a batch position
-- (on conflict do nothing), so B's Process then linked B's pages to A's row, and the match worker
-- wrote B's detected name, SIS id and matched profile into a row A's staff can read. A confirmed
-- row there made B's Process fail with EX409 instead. The same gap let a row name another exam
-- of the batch's course, and let staff move a batch with rows to another exam.
--
-- The invariant: a scanned exam's batch_id, exam_id and class_id are those of one batch row. One
-- composite foreign key enforces it on insert and update of either table, for every role
-- (including the service role and security-definer functions), and under concurrency: the
-- check locks the batch row (FOR KEY SHARE), so a concurrent change to the batch's exam or class
-- waits, then fails. All three columns are NOT NULL on both tables, so MATCH SIMPLE cannot be
-- bypassed with a null.
--
-- The key replaces exam_scanned_submissions_batch_id_fkey and keeps its actions (ON DELETE
-- CASCADE, ON UPDATE NO ACTION, NOT DEFERRABLE). Keeping both keys would give PostgREST two
-- relationships between the same tables, the ambiguity behind #1075. A batch's exam_id and
-- class_id can still change while it has no scanned exams; the batch's own (exam_id, class_id)
-- key and write policy keep that change inside one course.
--
-- This supersedes the note in 20261114133600 that row RLS still allows inserting a row whose exam
-- differs from its batch's. That migration's trigger still refuses changes to a row's scope, with
-- its own message. The worker's finalize checks stay as defence in depth.
--
-- Existing rows are not changed. If any row breaks the invariant, this migration fails before
-- changing anything and names the rows, so someone decides what they are.
--
-- Rollback:
--   alter table public.exam_scanned_submissions
--     add constraint exam_scanned_submissions_batch_id_fkey
--     foreign key (batch_id) references public.exam_scan_batches (id) on delete cascade;
--   alter table public.exam_scanned_submissions drop constraint exam_scanned_submissions_batch_scope_fkey;
--   alter table public.exam_scan_batches drop constraint exam_scan_batches_id_exam_class_key;

do $$
declare
  v_count bigint;
  v_ids text;
begin
  select count(*), string_agg(id::text, ', ' order by id) filter (where rn <= 20)
    into v_count, v_ids
  from (
    select s.id, row_number() over (order by s.id) as rn
    from public.exam_scanned_submissions s
    where not exists (
      select 1 from public.exam_scan_batches b
      where b.id = s.batch_id and b.exam_id = s.exam_id and b.class_id = s.class_id)
  ) bad;
  if v_count > 0 then
    raise exception
      '% scanned submission(s) name a batch of another exam or class (first ids: %); resolve them before applying this migration',
      v_count, v_ids;
  end if;
end $$;

alter table public.exam_scan_batches
  add constraint exam_scan_batches_id_exam_class_key unique (id, exam_id, class_id);

alter table public.exam_scanned_submissions
  add constraint exam_scanned_submissions_batch_scope_fkey
  foreign key (batch_id, exam_id, class_id)
  references public.exam_scan_batches (id, exam_id, class_id)
  on update no action on delete cascade
  not deferrable;

alter table public.exam_scanned_submissions drop constraint exam_scanned_submissions_batch_id_fkey;
