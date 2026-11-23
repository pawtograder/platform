-- pgmq_public.set_vt_if_claimed: exam-async-worker keeps the message it is running on a short
-- visibility lease and renews it, so a worker that dies mid-message hands the message back in
-- seconds rather than after the full read window (#1158).
--
-- Not a pass-through of pgmq.set_vt, which moves vt for whoever calls it. A renewal from a reader
-- whose lease already lapsed would then rewrite the claim of the reader that took the message
-- next, and could shorten it to a lease nobody renews. read_ct is the claim token here. Every read
-- raises it, so the update applies only while read_ct is still the one the caller read. Otherwise
-- it is pgmq.set_vt's update (pgmq 1.5.1): vt = clock_timestamp() + vt seconds.
--
-- Returns true when it moved vt, and false when the caller no longer holds the message (archived,
-- deleted or read again) or an argument is missing or vt is below 1. Like renew_org_slot
-- (20260912120000_per_org_async_leases.sql), it returns a boolean, not pgmq's row type.
--
-- Service role only: queues are drained by edge functions, never by signed-in users.
-- Rollback: reverting the worker stops the calls; this function can stay, unused.
create or replace function pgmq_public.set_vt_if_claimed(queue_name text, msg_id bigint, read_ct integer, vt integer)
returns boolean
language plpgsql
set search_path to ''
as $function$
declare
  v_rows integer;
begin
  if set_vt_if_claimed.queue_name is null or set_vt_if_claimed.msg_id is null
     or set_vt_if_claimed.read_ct is null or set_vt_if_claimed.vt is null or set_vt_if_claimed.vt < 1 then
    return false;
  end if;

  execute format(
    'update pgmq.%I set vt = clock_timestamp() + make_interval(secs => $1) where msg_id = $2 and read_ct = $3',
    pgmq.format_table_name(set_vt_if_claimed.queue_name, 'q')
  ) using set_vt_if_claimed.vt, set_vt_if_claimed.msg_id, set_vt_if_claimed.read_ct;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;

revoke all on function pgmq_public.set_vt_if_claimed(text, bigint, integer, integer) from public, anon, authenticated;
grant execute on function pgmq_public.set_vt_if_claimed(text, bigint, integer, integer) to service_role;

comment on function pgmq_public.set_vt_if_claimed(text, bigint, integer, integer) is
  'Set a message''s visibility to vt seconds from now, only while its read_ct still equals the '
  'caller''s (the caller''s claim). Returns false if the caller no longer holds the message. Used by '
  'exam-async-worker to renew the lease on the message it is running (#1158).';

-- public.exam_worker_set_batch_status: every exam_scan_batches.status write exam-async-worker makes.
--
-- A handler whose lease lapsed keeps running, and a finalize left over from a run that Retry
-- reopened is still a valid message. Neither may move the batch. Renewing the lease and then
-- writing in a separate request would only narrow that window, because the write can land after
-- another reader has claimed the message. So the claim check and the write happen in one
-- transaction here:
--   1. Lock the message row while read_ct is still the caller's. pgmq.read claims rows with
--      FOR UPDATE SKIP LOCKED, so no reader can claim this message until we commit. If a reader
--      claimed it first, read_ct has moved on, and the re-check after the lock wait finds no row.
--   2. Update the batch only from the states the caller allows. The same re-check applies if an
--      RPC (Retry, Create) changed the status concurrently.
-- Returns 'applied', 'state_changed' (still the caller's message, but the batch moved on) or
-- 'not_owner' (another reader holds the message, or it is gone). error is written only with
-- status 'error'; other writes leave it alone.
--
-- Service role only. Rollback: reverting the worker stops the calls; the function can stay.
create or replace function public.exam_worker_set_batch_status(
  p_msg_id bigint,
  p_read_ct integer,
  p_batch_id bigint,
  p_status text,
  p_from text[],
  p_error text default null
)
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_rows integer;
begin
  if p_msg_id is null or p_read_ct is null or p_batch_id is null or p_status is null or p_from is null then
    raise exception 'exam_worker_set_batch_status: every argument except p_error is required';
  end if;

  perform 1 from pgmq.q_exam_processing q
   where q.msg_id = p_msg_id and q.read_ct = p_read_ct
   for update;
  if not found then
    return 'not_owner';
  end if;

  update public.exam_scan_batches b
     set status = p_status,
         error = case when p_status = 'error' then p_error else b.error end
   where b.id = p_batch_id and b.status = any (p_from);
  get diagnostics v_rows = row_count;
  return case when v_rows > 0 then 'applied' else 'state_changed' end;
end;
$function$;

revoke all on function public.exam_worker_set_batch_status(bigint, integer, bigint, text, text[], text)
  from public, anon, authenticated;
grant execute on function public.exam_worker_set_batch_status(bigint, integer, bigint, text, text[], text)
  to service_role;

comment on function public.exam_worker_set_batch_status(bigint, integer, bigint, text, text[], text) is
  'Set an exam scan batch''s status for exam-async-worker, only while the caller still holds queue '
  'message p_msg_id at read_ct p_read_ct and the batch is in one of p_from, in one transaction. '
  'Returns applied, state_changed or not_owner (#1158).';

-- ---------------------------------------------------------------------------------------------
-- The rest of the worker's ownership boundary (#1158 review, round 3).
--
-- exam_worker_set_batch_status fences batch-status writes. A worker whose lease lapsed could still
-- (a) archive, re-queue or dead-letter the message by msg_id after another reader claimed it, and
-- (b) rewrite match results (links, suggestions) after the batch had moved on to review. (a) let a
-- stale give-up leave a batch in 'error' with its work finished, let a stale retry fork a second
-- live copy of the work, and let a stale acknowledgment remove the newer holder's message. (b) let
-- a late worker overwrite a suggestion, or a staff member's unconfirmed pick, under review.
--
-- Every function below starts with the same claim check as exam_worker_set_batch_status: lock the
-- message row while read_ct is still the caller's, else return 'not_owner' and change nothing.
-- pgmq.read claims with FOR UPDATE SKIP LOCKED, so each call happens wholly before a newer read
-- or not at all. Lock order everywhere: queue row, then batch, then scanned exam rows.
--
-- Service role only. Rollback: revert the worker. These functions can stay, unused; the
-- enqueue_exam_finalize guard at the end is reverted by re-creating the body in
-- 20261107120000_exam_grading.sql.
-- ---------------------------------------------------------------------------------------------

-- The worker refuses to claim anything until this returns the version it was built for, so a
-- worker deployed before this migration (the chart does not order the two) leaves the queue alone
-- instead of running without these guarantees. Bump it when the worker needs a new function.
create or replace function public.exam_worker_contract_version()
returns integer
language sql
immutable
set search_path to ''
as $function$ select 4 $function$;

revoke all on function public.exam_worker_contract_version() from public, anon, authenticated;
grant execute on function public.exam_worker_contract_version() to service_role;

-- Acknowledge a handled message: archive it, only while the caller still holds it. A handler that
-- finished after its lease lapsed leaves the message to the reader that holds it now.
create or replace function public.exam_worker_ack(p_msg_id bigint, p_read_ct integer)
returns text
language plpgsql
set search_path to ''
as $function$
begin
  if p_msg_id is null or p_read_ct is null then
    raise exception 'exam_worker_ack: p_msg_id and p_read_ct are required';
  end if;
  perform 1 from pgmq.q_exam_processing q
   where q.msg_id = p_msg_id and q.read_ct = p_read_ct
   for update;
  if not found then
    return 'not_owner';
  end if;
  perform pgmq.archive('exam_processing', p_msg_id);
  return 'acked';
end;
$function$;

revoke all on function public.exam_worker_ack(bigint, integer) from public, anon, authenticated;
grant execute on function public.exam_worker_ack(bigint, integer) to service_role;

-- Replace the caller's message with p_message, visible p_delay seconds from now, in one
-- transaction: the replacement and the archive both happen, or neither does. A crash between them
-- can no longer leave two live copies, and a reader that lost the message cannot fork it.
--
-- p_count_wait: this re-queue follows a counted OCR wait (ocrWait.ts). The replacement then
-- carries ocr_wait_from, the instant its own visibility is computed from, which is the instant
-- the old worker's 30s re-queue delay ran from. It is read with clock_timestamp() after the claim
-- lock, so time spent waiting for the lock never makes the boundary earlier.
create or replace function public.exam_worker_requeue(
  p_msg_id bigint,
  p_read_ct integer,
  p_message jsonb,
  p_delay integer,
  p_count_wait boolean default false
)
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_at timestamptz;
begin
  if p_msg_id is null or p_read_ct is null or p_message is null or jsonb_typeof(p_message) <> 'object'
     or p_delay is null or p_delay < 0 or p_count_wait is null then
    raise exception 'exam_worker_requeue: a message object, a delay >= 0 and the claim are required';
  end if;
  perform 1 from pgmq.q_exam_processing q
   where q.msg_id = p_msg_id and q.read_ct = p_read_ct
   for update;
  if not found then
    return 'not_owner';
  end if;
  v_at := clock_timestamp();
  perform pgmq.send(
    'exam_processing',
    case when p_count_wait then p_message || jsonb_build_object('ocr_wait_from', v_at) else p_message end,
    null::jsonb,
    v_at + make_interval(secs => p_delay)
  );
  perform pgmq.archive('exam_processing', p_msg_id);
  return 'requeued';
end;
$function$;

revoke all on function public.exam_worker_requeue(bigint, integer, jsonb, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.exam_worker_requeue(bigint, integer, jsonb, integer, boolean) to service_role;

-- Give up on the caller's message, in one transaction: error the batch (only from p_from), record
-- the failure, archive the message. Either all of it happens or none of it, so a give-up can no
-- longer error a batch and then leave the message to be finished by a redelivery.
--
-- The failure is recorded twice, as before: a message on exam_processing_dlq (replayable) and a row
-- in exam_async_worker_dlq_messages (queryable). Either one suffices, so each runs in its own
-- savepoint and only both failing raises, which rolls everything back and leaves the message to
-- come back. The audit row casts nothing that can fail. p_batch_id may be null (a message whose
-- body is not an envelope at all). Returns 'not_owner', 'given_up', or 'given_up' with
-- ':no_dlq_message' or ':no_audit_row' when one record failed.
create or replace function public.exam_worker_give_up(
  p_msg_id bigint,
  p_read_ct integer,
  p_batch_id bigint,
  p_from text[],
  p_error text,
  p_error_type text,
  p_envelope jsonb
)
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_obj boolean := jsonb_typeof(p_envelope) = 'object';
  v_queued boolean := false;
  v_audited boolean := false;
  v_queue_err text;
  v_audit_err text;
begin
  if p_msg_id is null or p_read_ct is null then
    raise exception 'exam_worker_give_up: p_msg_id and p_read_ct are required';
  end if;
  perform 1 from pgmq.q_exam_processing q
   where q.msg_id = p_msg_id and q.read_ct = p_read_ct
   for update;
  if not found then
    return 'not_owner';
  end if;

  if p_batch_id is not null and p_from is not null then
    update public.exam_scan_batches b
       set status = 'error', error = p_error
     where b.id = p_batch_id and b.status = any (p_from);
  end if;

  begin
    perform pgmq.send(
      'exam_processing_dlq',
      case when v_obj then p_envelope else jsonb_build_object('malformed_envelope', p_envelope) end
    );
    v_queued := true;
  exception when others then
    v_queue_err := sqlerrm;
  end;

  begin
    insert into public.exam_async_worker_dlq_messages
      (original_msg_id, method, envelope, error_message, error_type, retry_count, class_id, debug_id)
    values (
      p_msg_id,
      case when v_obj then p_envelope->>'method' end,
      p_envelope,
      p_error,
      p_error_type,
      case when v_obj and (p_envelope->>'retry_count') ~ '^[0-9]{1,9}$'
           then (p_envelope->>'retry_count')::integer else 0 end,
      case when v_obj and (p_envelope->>'class_id') ~ '^[0-9]{1,18}$'
           then (p_envelope->>'class_id')::bigint end,
      case when v_obj then p_envelope->>'debug_id' end
    );
    v_audited := true;
  exception when others then
    v_audit_err := sqlerrm;
  end;

  if not v_queued and not v_audited then
    raise exception 'exam_worker_give_up: both dead-letter records failed (queue: %; audit: %)',
      v_queue_err, v_audit_err;
  end if;

  perform pgmq.archive('exam_processing', p_msg_id);
  return case
    when not v_queued then 'given_up:no_dlq_message'
    when not v_audited then 'given_up:no_audit_row'
    else 'given_up'
  end;
end;
$function$;

revoke all on function public.exam_worker_give_up(bigint, integer, bigint, text[], text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.exam_worker_give_up(bigint, integer, bigint, text[], text, text, jsonb)
  to service_role;

-- Link a batch's page groups (exam_link_scan_groups), only while the caller holds its match
-- message and the batch is still 'matching'. The batch row is locked FOR NO KEY UPDATE for the
-- transaction: a status write moving it to review waits for this, or this sees review and changes
-- nothing; and two links for the same batch run one after the other (below). Staff inserting a page
-- (a foreign-key KEY SHARE on the batch) is not blocked by it.
--
-- And only the grouping the batch's pages and pages_per_exam give now: the pages in page_index order,
-- pages_per_exam to an exam, as doMatch groups them. Holding a match message is not enough. A match
-- left over from an earlier Process run holds its own message validly, beside the newer run's. If
-- staff changed those inputs in between (a page added, pages_per_exam), the leftover's grouping
-- describes pages as they were, and linking it over the newer run's put two exams' pages on one row.
--
-- A stale grouping is refused, and the caller's message is disposed of here, in the same
-- transaction as the decision, never left for a later acknowledgment:
--   - 'superseded': another match message for the batch is still in the queue (read or not), so
--     the caller's message is archived; that match links from the pages as they are when it gets
--     there, and finishes or fails the batch.
--   - 'pages_changed': no other match message is left, so this one gives up (exam_worker_give_up):
--     the batch goes to error, from 'matching' only, and is recorded on the DLQ. Staff clear it with
--     Process, which re-queues OCR for every page (the added one included) and matches again.
-- Deciding first and acknowledging in a later transaction let two stale matches each see the other,
-- both stand down, and leave the batch in 'matching' with no work and Process refusing it. Here the
-- decision and the disposition commit together, and the batch lock serializes them: a second link
-- waits for the first to commit, then sees the first message already archived and gives up itself.
-- No new match message can appear meanwhile: Process locks the batch and refuses 'matching', and a
-- re-queue replaces its message in one transaction. Lock order is unchanged: the caller's message,
-- then the batch, then (applied links only) the scanned exams and pages.
-- pages_per_exam cannot change under this. A page inserted while this runs is not linked, as before.
-- Returns {"outcome": "not_owner" | "state_changed" | "superseded" | "pages_changed"} or
-- {"outcome": "applied", "rows": [...]}. Only 'applied' and 'state_changed' leave the message to the
-- caller to dispose of.
-- exam_link_scan_groups's own errors (EX409: it would regroup a decided exam) propagate.
create or replace function public.exam_worker_link_scan_groups(
  p_msg_id bigint,
  p_read_ct integer,
  p_batch_id bigint,
  p_groups jsonb
)
returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  v_status text;
  v_message jsonb;
  v_given_up text;
begin
  if p_msg_id is null or p_read_ct is null or p_batch_id is null or p_groups is null then
    raise exception 'exam_worker_link_scan_groups: every argument is required';
  end if;
  select q.message into v_message from pgmq.q_exam_processing q
   where q.msg_id = p_msg_id and q.read_ct = p_read_ct
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_owner');
  end if;
  select b.status into v_status from public.exam_scan_batches b where b.id = p_batch_id for no key update;
  if v_status is distinct from 'matching' then
    return jsonb_build_object('outcome', 'state_changed');
  end if;
  if exists (
    (select p.id, (row_number() over (order by p.page_index) - 1) / greatest(1, b.pages_per_exam) as exam_index
       from public.exam_scan_pages p
       join public.exam_scan_batches b on b.id = p.batch_id
      where p.batch_id = p_batch_id
     except
     select pid::bigint, (g->>'exam_index')::bigint
       from jsonb_array_elements(p_groups) g
      cross join lateral jsonb_array_elements_text(g->'page_ids') pid)
    union all
    (select pid::bigint, (g->>'exam_index')::bigint
       from jsonb_array_elements(p_groups) g
      cross join lateral jsonb_array_elements_text(g->'page_ids') pid
     except
     select p.id, (row_number() over (order by p.page_index) - 1) / greatest(1, b.pages_per_exam)
       from public.exam_scan_pages p
       join public.exam_scan_batches b on b.id = p.batch_id
      where p.batch_id = p_batch_id)
  ) then
    if exists (
      select 1 from pgmq.q_exam_processing q
       where q.msg_id <> p_msg_id
         and q.message->>'method' = 'match'
         and q.message->>'batch_id' = p_batch_id::text
    ) then
      perform pgmq.archive('exam_processing', p_msg_id);
      return jsonb_build_object('outcome', 'superseded');
    end if;
    v_given_up := public.exam_worker_give_up(
      p_msg_id, p_read_ct, p_batch_id, array['matching'],
      format('batch %s: its pages changed while it was being matched; process the batch again', p_batch_id),
      'PagesChangedError', v_message);
    return jsonb_build_object('outcome', 'pages_changed', 'given_up', v_given_up);
  end if;
  return jsonb_build_object('outcome', 'applied', 'rows', public.exam_link_scan_groups(p_batch_id, p_groups));
end;
$function$;

revoke all on function public.exam_worker_link_scan_groups(bigint, integer, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.exam_worker_link_scan_groups(bigint, integer, bigint, jsonb) to service_role;

-- Write the worker's identity suggestion for one scanned exam, only while the caller holds its
-- match message and the batch is still 'matching' (share-locked, as above). Never over a human
-- decision: a confirmed or skipped exam is not undecided, and an unconfirmed pick made in review is
-- stored as 'suggested' with a null confidence, which the worker never writes (matchProfile always
-- gives a confidence). A pick whose pages a re-link changed was already cleared to 'unmatched' by
-- exam_link_scan_groups, so the worker re-detects it.
--
-- And only while the exam still holds exactly the pages the identity was read from (p_page_ids),
-- checked under the exam row's lock, which exam_link_scan_groups takes before it moves a page. A
-- match left over from an earlier Process run holds its own message validly; if a newer run re-linked
-- this exam to other pages since, the suggestion describes other paper and is refused as
-- 'state_changed'. The newer run's match suggests for the new pages.
-- Returns 'not_owner', 'state_changed', 'applied' or 'skipped' (the row is decided, picked, or not in
-- this batch).
create or replace function public.exam_worker_set_match_suggestion(
  p_msg_id bigint,
  p_read_ct integer,
  p_batch_id bigint,
  p_scanned_id bigint,
  p_detected_name text,
  p_detected_sis_id text,
  p_matched_profile_id uuid,
  p_match_confidence numeric,
  p_page_ids bigint[]
)
returns text
language plpgsql
set search_path to ''
as $function$
declare
  v_status text;
  v_rows integer;
begin
  if p_msg_id is null or p_read_ct is null or p_batch_id is null or p_scanned_id is null
     or p_match_confidence is null or coalesce(cardinality(p_page_ids), 0) = 0 then
    raise exception 'exam_worker_set_match_suggestion: the claim, batch, scanned exam, confidence and pages are required';
  end if;
  perform 1 from pgmq.q_exam_processing q
   where q.msg_id = p_msg_id and q.read_ct = p_read_ct
   for update;
  if not found then
    return 'not_owner';
  end if;
  select b.status into v_status from public.exam_scan_batches b where b.id = p_batch_id for share;
  if v_status is distinct from 'matching' then
    return 'state_changed';
  end if;
  perform 1 from public.exam_scanned_submissions s
   where s.id = p_scanned_id and s.batch_id = p_batch_id
   for update;
  if not found then
    return 'skipped';
  end if;
  if (select coalesce(array_agg(p.id order by p.id), '{}') from public.exam_scan_pages p
       where p.scanned_submission_id = p_scanned_id)
     is distinct from
     (select array_agg(distinct x order by x) from unnest(p_page_ids) x) then
    return 'state_changed';
  end if;
  update public.exam_scanned_submissions s
     set detected_name = p_detected_name,
         detected_sis_id = p_detected_sis_id,
         matched_profile_id = p_matched_profile_id,
         match_confidence = p_match_confidence,
         match_status = case when p_matched_profile_id is null then 'unmatched' else 'suggested' end
   where s.id = p_scanned_id
     and s.batch_id = p_batch_id
     and s.match_status in ('suggested', 'unmatched')
     and not (s.match_status = 'suggested' and s.match_confidence is null);
  get diagnostics v_rows = row_count;
  return case when v_rows > 0 then 'applied' else 'skipped' end;
end;
$function$;

revoke all on function public.exam_worker_set_match_suggestion(bigint, integer, bigint, bigint, text, text, uuid, numeric, bigint[])
  from public, anon, authenticated;
grant execute on function public.exam_worker_set_match_suggestion(bigint, integer, bigint, bigint, text, text, uuid, numeric, bigint[])
  to service_role;

-- Create (enqueue_exam_finalize) refuses a batch while finalize messages for it are still queued. The
-- body is 20261107120000_exam_grading.sql's with the lock and that check added after the staff check.
create or replace function public.enqueue_exam_finalize(p_batch_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id bigint;
  v_count integer := 0;
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

  -- #1158 review: a second Create while finalize messages for the batch are still queued or running
  -- (a second click or tab, the CLI, or Create on a batch that errored while other exams' finalizes
  -- were still in flight) queued those exams again, and two finalizes of one exam can then run at
  -- the same time (they duplicate the submission's page-file rows). Lock the batch, after the staff
  -- check so no one else can hold it, so two Creates run one after the other, and refuse while any
  -- finalize message for this batch is still queued. A message stays queued until the reader that
  -- holds it acknowledges, re-queues or gives it up, so this covers a finalize that reader is
  -- running. It does not cover a former reader still running after its lease lapsed and another
  -- reader disposed of the message (the remaining duplicate-finalize case, tracked separately).
  -- With none queued, Create works as before, including on a batch left in 'finalizing' with
  -- nothing behind it, which it (the CLI's `exams scans finalize`, or the RPC) can still restart.
  perform 1 from public.exam_scan_batches b where b.id = p_batch_id for update;
  if exists (
    select 1 from pgmq.q_exam_processing q
    where q.message->>'method' = 'finalize' and q.message->>'batch_id' = p_batch_id::text
  ) then
    raise exception 'Batch % is already creating submissions; wait for it to finish', p_batch_id;
  end if;

  -- Refuse to start when two scanned exams are confirmed for the SAME student. The match-review
  -- selector permits it (two papers can be read as the same person), and each finalize inserts
  -- an ACTIVE individual submission -- so the first succeeds and the second violates
  -- submissions_one_active_individual_per_student, which retries and finally errors a batch
  -- that is already half finalized. Caught up front, while the batch is still wholly
  -- unfinalized and staff can fix the duplicate in review, since what SHOULD happen to a
  -- genuine duplicate scan (replace? keep both? merge?) is a product decision, not something
  -- to guess at inside a retry loop.
  if exists (
    select 1
    from public.exam_scanned_submissions ss
    where ss.batch_id = p_batch_id
      and ss.match_status = 'confirmed'
      and ss.matched_profile_id is not null
    group by ss.matched_profile_id
    having count(*) > 1
  ) then
    raise exception
      'Batch % has more than one confirmed exam for the same student; resolve the duplicate matches in review before creating submissions',
      p_batch_id;
  end if;

  -- Also reject when a confirmed student ALREADY has an active submission from an earlier
  -- batch. The in-batch duplicate check above groups only within p_batch_id, so a re-scan batch
  -- containing a student who was already finalized would partially finalize everyone else and
  -- then fail on that one insert against
  -- submissions_one_active_individual_per_student, DLQ the message and error the batch. Caught
  -- here for the same reason as the in-batch case: whether a re-scan should REPLACE the earlier
  -- submission or be refused is a product decision, and guessing it inside a retry loop is how
  -- you silently overwrite a student's graded exam.
  if exists (
    select 1
    from public.exam_scanned_submissions ss
    join public.exams e on e.id = ss.exam_id
    join public.submissions sub
      on sub.assignment_id = e.assignment_id
     and sub.profile_id = ss.matched_profile_id
     and sub.is_active
     and sub.assignment_group_id is null
    where ss.batch_id = p_batch_id
      and ss.match_status = 'confirmed'
      and ss.matched_profile_id is not null
      and ss.finalized_at is null
      and sub.id is distinct from ss.submission_id
  ) then
    raise exception
      'Batch % contains a confirmed exam for a student who already has an active submission for this assignment; resolve the duplicate (or remove the earlier submission) before creating submissions',
      p_batch_id;
  end if;

  -- Re-enqueue every confirmed submission that is not yet finalized. finalized_at is the
  -- crash-safety signal: a submission whose finalize crashed before completing (finalized_at
  -- still NULL, whether or not a partial submission/artifact exists) is picked back up here,
  -- as is one that never started.
  for rec in select ss.id from public.exam_scanned_submissions ss
             where ss.batch_id = p_batch_id and ss.match_status = 'confirmed'
               and ss.finalized_at is null loop
    perform pgmq_public.send('exam_processing', jsonb_build_object(
      'method', 'finalize', 'class_id', v_class_id, 'batch_id', p_batch_id,
      'args', jsonb_build_object('scanned_submission_id', rec.id)));
    v_count := v_count + 1;
  end loop;

  -- Only flip into 'finalizing' when there is actually work; otherwise leave the batch's
  -- status untouched (e.g. an already-'completed' batch stays completed) so a redundant
  -- finalize click can't strand it.
  if v_count > 0 then
    update public.exam_scan_batches set status = 'finalizing', error = null where id = p_batch_id;

    -- best-effort immediate kick; the cron invoker drains the queue regardless
    begin
      perform public.call_edge_function_internal(
        '/functions/v1/exam-async-worker', 'POST',
        '{"Content-type":"application/json","x-supabase-webhook-source":"exam-async-worker"}'::jsonb,
        '{}'::jsonb, 3000, null, null, null, null, null);
    exception when others then null;
    end;
  end if;

  return v_count;
end;
$$;
revoke all on function public.enqueue_exam_finalize(bigint) from public;
grant execute on function public.enqueue_exam_finalize(bigint) to authenticated, service_role;
