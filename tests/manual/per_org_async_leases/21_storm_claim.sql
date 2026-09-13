-- ONE claim, as its own implicit transaction. run.sh concatenates this file N times (interleaved
-- with 22_storm_release.sql) into the body each parallel psql session runs, because the whole point
-- is that every claim commits independently -- wrapping the loop in a function or a BEGIN block
-- would hold the allocator's advisory lock for the entire loop and quietly test nothing.
--
-- :h is the holder, supplied by run.sh with psql -v h=storm-<n>.
insert into harness.claims(scenario, holder, org, msg_id)
select '5 concurrency', :'h', t.org, t.msg_id
  from pgmq_public.claim_org_slot_and_read('async_calls', 600, 4, :'h', 4, 6, 16) t;
