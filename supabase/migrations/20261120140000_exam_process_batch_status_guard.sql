-- #1329: Process could queue a batch again while it was already being processed. Two staff clicking
-- Process at about the same time, one person in two tabs, or two CLI calls at once each sent a full
-- round of OCR jobs plus a match job, and every extra OCR job is another paid Vision call.
--
-- This redefines enqueue_exam_process_batch unchanged except that, once the staff check passes, it
-- locks the batch row and refuses while the batch is in ocr, matching or finalizing, or is completed.
-- The lock makes a second call wait for the first to commit and then see its 'ocr', so two calls at
-- once can't both get through. The row is locked only after the staff check, so a caller who isn't
-- staff can't hold the lock and make staff wait.
--
-- Still allowed: uploaded (first run), review (reprocessing is how staff rematch) and error (how they
-- recover). Completed is refused because reprocessing would send a finalized batch back to review;
-- the Scans page doesn't offer Process there and the CLI already refused it.

create or replace function public.enqueue_exam_process_batch(p_batch_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id bigint;
  v_count integer := 0;
  v_page_count integer;
  v_total_pages integer;
  v_pages_per_exam integer;
  v_num_pages integer;
  v_status text;
  rec record;
begin
  select class_id into v_class_id from public.exam_scan_batches where id = p_batch_id;
  if v_class_id is null then
    raise exception 'Batch % not found', p_batch_id;
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid() and up.class_id = v_class_id and up.role in ('instructor','grader')
  ) then
    raise exception 'Access denied: staff only';
  end if;

  -- Lock the batch and refuse while a run is in flight or the batch is finished (#1329). A second
  -- call waits here for the first to commit, then reads the 'ocr' it set and stops.
  select status into v_status from public.exam_scan_batches where id = p_batch_id for update;
  if v_status in ('ocr', 'matching', 'finalizing') then
    raise exception 'Batch % is already being processed (status %)', p_batch_id, v_status;
  end if;
  if v_status = 'completed' then
    raise exception 'Batch % is completed; its exams have already been turned into submissions', p_batch_id;
  end if;

  -- Refuse to process a batch whose pages are not all persisted. uploadExamScanBatch inserts the
  -- batch row (with the full total_pages) before uploading pages, so a failure part-way leaves a
  -- processable batch holding only a prefix -- and matching would then split exams from a short
  -- page list and produce wrong student submissions. Checked here rather than only in the UI so
  -- it also holds for a direct RPC call and for the 'error' retry path.
  select count(*) into v_page_count from public.exam_scan_pages where batch_id = p_batch_id;
  select total_pages, pages_per_exam into v_total_pages, v_pages_per_exam
    from public.exam_scan_batches where id = p_batch_id;

  -- pages_per_exam must span the whole template. Staff pick it by hand, and a value below the
  -- template's page count still divides an even scan cleanly -- so pages from different students
  -- get grouped into one exam, and regions on the template pages beyond the chosen count are
  -- skipped during finalization. Checked against the exam rather than trusting any positive
  -- integer. (num_pages = 0 means the template has not been rasterized yet, so there is nothing
  -- to compare against.)
  select num_pages into v_num_pages from public.exams e
    join public.exam_scan_batches b on b.exam_id = e.id where b.id = p_batch_id;
  if coalesce(v_num_pages, 0) > 0 and v_pages_per_exam is distinct from v_num_pages then
    raise exception
      'Batch % is set to % page(s) per exam but the template has % page(s); correct pages-per-exam before processing',
      p_batch_id, v_pages_per_exam, v_num_pages;
  end if;
  if v_page_count is distinct from v_total_pages then
    raise exception 'Batch % has % of % scan pages persisted; re-upload the scan before processing',
      p_batch_id, v_page_count, v_total_pages;
  end if;

  update public.exam_scan_batches set status = 'ocr', error = null where id = p_batch_id;

  -- one OCR job per scan page
  for rec in select id from public.exam_scan_pages where batch_id = p_batch_id order by page_index loop
    perform pgmq_public.send('exam_processing', jsonb_build_object(
      'method', 'process_page', 'class_id', v_class_id, 'batch_id', p_batch_id,
      'args', jsonb_build_object('scan_page_id', rec.id)));
    v_count := v_count + 1;
  end loop;

  -- one match job for the batch (groups pages into scanned submissions, reads identity)
  perform pgmq_public.send('exam_processing', jsonb_build_object(
    'method', 'match', 'class_id', v_class_id, 'batch_id', p_batch_id,
    'args', jsonb_build_object('batch_id', p_batch_id)));

  -- best-effort immediate kick; the cron invoker drains the queue regardless
  begin
    perform public.call_edge_function_internal(
      '/functions/v1/exam-async-worker', 'POST',
      '{"Content-type":"application/json","x-supabase-webhook-source":"exam-async-worker"}'::jsonb,
      '{}'::jsonb, 3000, null, null, null, null, null);
  exception when others then null;
  end;

  return v_count;
end;
$$;
revoke all on function public.enqueue_exam_process_batch(bigint) from public;
grant execute on function public.enqueue_exam_process_batch(bigint) to authenticated, service_role;
