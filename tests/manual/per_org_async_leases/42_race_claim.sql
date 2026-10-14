-- Session A. Starts inside the window session R is holding open and asks for its next batch as the
-- SAME holder. Against the old allocator, FOR UPDATE SKIP LOCKED discarded racer's locked row and
-- handed it a second one. Against this allocator it blocks on its own row, then reuses it.
\set ON_ERROR_STOP on
select pg_sleep(1);
insert into harness.claims(scenario, holder, org, msg_id)
select '18 renew race', 'racer', t.org, t.msg_id
  from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'racer', 120, 8, 32) t
 where t.status = 'claimed';
