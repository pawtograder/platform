-- Fixtures for scenario 18, the renewal-versus-claim race.
--
-- 'racer' has to already hold a slot before the race starts, because the bug is about what happens
-- to the row it ALREADY owns while a renewal has that row locked.
\set ON_ERROR_STOP on

select harness.reset('async_calls');
select pgmq.purge_queue('async_calls_low_priority');
select harness.seed(101, 400);

select count(*) as racer_first_claim
  from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'racer', 120, 8, 32) t
 where t.status = 'claimed';

select slot, holder, org from public.async_worker_slots
 where queue_name = 'async_calls' and holder = 'racer';
