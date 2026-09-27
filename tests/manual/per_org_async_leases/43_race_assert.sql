-- Assertions for scenario 18.
\set ON_ERROR_STOP on

do $$
begin
  -- THE check. Two rows here is the bug: the renewal held one, the claim took another, and
  -- renew_org_slot would have kept refreshing both forever because it matches on holder, not slot.
  perform harness.expect('18 renew race', 'rows in the pool bearing this holder', '1',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls' and holder = 'racer'));
  perform harness.expect('18 renew race', 'live slots in the pool', '1',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
  -- Not passing by accident: the racing claim really did get its batch rather than being turned
  -- away, which would also have left one row.
  perform harness.expect('18 renew race', 'messages the racing claim received', '4',
    (select count(*)::text from harness.claims where scenario = '18 renew race'));
  -- The renewal was not lost either. It ran, and the surviving row is still racer's. array_agg
  -- rather than a bare scalar subquery on purpose: against the broken allocator there are TWO live
  -- rows here, and this has to report a FAIL with the observed value rather than abort the run with
  -- "more than one row returned by a subquery used as an expression".
  perform harness.expect('18 renew race', 'holders on live rows in the pool', '{racer}',
    (select array_agg(distinct holder order by holder)::text from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
  perform harness.expect('18 renew race', 'slots the racer ended up on', '1',
    (select count(distinct slot)::text from public.async_worker_slots
      where queue_name = 'async_calls' and holder = 'racer'));
end $$;
