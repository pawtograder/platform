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
