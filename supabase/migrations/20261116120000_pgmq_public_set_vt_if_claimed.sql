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
