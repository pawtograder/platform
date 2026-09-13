-- One iteration of the randomized renew/claim race, run by many parallel sessions at once. run.sh
-- concatenates this file to build each session's body, the same way it builds the storm.
--
-- CLAIM half. Each holder is driven by TWO sessions at once: this one, and a matching session
-- running 46_race_renew_worker.sql under the same holder string. That pairing is the whole point.
-- An earlier version had each session claim and then renew itself, which cannot reproduce the bug
-- at all: two statements in one session are sequential, so the session never overlaps its own
-- renewal with its own claim, and the check passed against the broken allocator. The overlap has to
-- come from a different connection.
insert into harness.claims(scenario, holder, org, msg_id)
select '18 renew race storm', :'h', t.org, t.msg_id
  from pgmq_public.claim_org_slot_and_read('async_calls', 120, 4, :'h', 30, 4, 12) t
 where t.status = 'claimed';
