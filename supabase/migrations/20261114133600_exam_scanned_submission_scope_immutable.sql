-- A scanned exam's batch, exam and class cannot change after the row is created (#1078).
--
-- finalize checks these three columns against the batch its message was queued for, then calls
-- exam_create_submission, which re-reads exam_id (and from it the assignment) and class_id without
-- locking the row. A staff update landing between the two would file the batch's scans under
-- another exam's assignment, with an artifact built from the original exam's regions. Freezing the
-- columns only while the batch is 'finalizing' would not close that: once one row's rejection moves
-- the batch to 'error', the batch's other queued finalize messages still run.
--
-- Nothing legitimate updates these columns. The match worker and the seeder insert them, the match
-- review UI writes only the match fields, and the RPCs update only submission_id. The worker's own
-- checks stay: row RLS still allows INSERTING a row whose exam differs from its batch's.

create or replace function public.exam_scanned_submission_scope_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.exam_id is distinct from old.exam_id
     or new.class_id is distinct from old.class_id
     or new.batch_id is distinct from old.batch_id then
    raise exception
      'exam_id, class_id and batch_id of scanned submission % cannot change after it is created',
      old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_exam_scanned_submission_scope_immutable on public.exam_scanned_submissions;
create trigger trg_exam_scanned_submission_scope_immutable
  before update of exam_id, class_id, batch_id on public.exam_scanned_submissions
  for each row execute function public.exam_scanned_submission_scope_immutable();
