-- Assertions for scenario 5. Everything here reads state that the parallel sessions left behind.
\set ON_ERROR_STOP on

do $$
declare
  v_delivered int;
  v_distinct int;
  v_enqueued int;
  v_invisible int;
  v_holders int;
  v_slots int;
begin
  select count(*), count(distinct msg_id) into v_delivered, v_distinct
    from harness.claims where scenario = '5 concurrency';
  select count(*) into v_enqueued from pgmq.q_async_calls;
  select count(*) into v_invisible from pgmq.q_async_calls where vt > clock_timestamp();
  select count(distinct holder) into v_holders
    from harness.claims where scenario = '5 concurrency';
  select count(*) into v_slots from (select distinct queue_name, slot from harness.slot_log) x;

  perform harness.note('5 concurrency', 'messages delivered', v_delivered::text);
  perform harness.note('5 concurrency', 'distinct holders that won a slot', v_holders::text);
  perform harness.note('5 concurrency', 'distinct slots used', v_slots::text);
  perform harness.note('5 concurrency', 'slot writes observed by the audit trigger',
    (select count(*)::text from harness.slot_log));

  -- THE test. Two callers being handed the same msg_id is the failure this whole design has to
  -- avoid, and it is the one a snapshot after the fact can still see.
  perform harness.expect('5 concurrency', 'msg_ids delivered to more than one caller', '0',
    (select count(*)::text from (
       select msg_id from harness.claims where scenario = '5 concurrency'
        group by msg_id having count(*) > 1) d));
  perform harness.expect('5 concurrency', 'delivered = distinct delivered', v_delivered::text, v_distinct::text);

  -- Conservation: pgmq never deletes on read, so every message is either still ready or has been
  -- handed to exactly one caller and pushed 600s into the future.
  perform harness.expect('5 concurrency', 'enqueued', '2400', v_enqueued::text);
  perform harness.expect('5 concurrency', 'invisible messages = distinct delivered',
    v_distinct::text, v_invisible::text);

  -- A live lease belonging to someone else was never overwritten.
  perform harness.expect('5 concurrency', 'live leases stolen', '0',
    (select count(*)::text from harness.slot_log where stolen));

  -- The caps held under real parallelism, not just in the single-session scenarios.
  perform harness.expect('5 concurrency', 'global_cap 16 never exceeded', 'true',
    (select (coalesce(max(live_after), 0) <= 16)::text from harness.slot_log));
  perform harness.note('5 concurrency', 'peak live slots',
    (select coalesce(max(live_after), 0)::text from harness.slot_log));
  perform harness.expect('5 concurrency', 'max_per_org 6 never exceeded', 'true',
    (select (coalesce(max(live_org_after), 0) <= 6)::text from harness.slot_log));
  perform harness.note('5 concurrency', 'peak live slots for one org',
    (select coalesce(max(live_org_after), 0)::text from harness.slot_log));

  -- The storm has to have actually done work, or all of the above is vacuously true.
  perform harness.expect('5 concurrency', 'storm delivered a meaningful share (>= 1200)', 'true',
    (v_distinct >= 1200)::text);
  perform harness.expect('5 concurrency', 'more than one holder got in', 'true', (v_holders > 1)::text);
end $$;

-- Finish the drain single-threaded, to show the storm left nothing stranded: no message became
-- unreachable because its org lost its slot, and the (unresolved) bucket is not a black hole.
do $$
declare
  i int;
  v_rows int;
  v_total int := 0;
begin
  -- Make everything the storm took visible again, then drain it all.
  update pgmq.q_async_calls set vt = clock_timestamp();
  update public.async_worker_slots
     set org = null, holder = null, claimed_at = null, expires_at = '-infinity';

  -- ONE holder on purpose. `active` excludes the calling holder, so a single drainer is always
  -- below target for whichever org still has work and can never stall itself -- which is also a
  -- statement about the production fallback: if only one isolate is alive, it still drains
  -- everything, just breadth-first across orgs instead of in msg_id order.
  for i in 1..2000 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 3600, 8, 'drain-h1', 600, 64, 64);
    v_total := v_total + v_rows;
    exit when v_rows = 0;
  end loop;

  perform harness.expect('5 concurrency', 'single-threaded post-drain empties the queue', '0',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
  perform harness.note('5 concurrency', 'messages drained by the post-drain', v_total::text);
end $$;
