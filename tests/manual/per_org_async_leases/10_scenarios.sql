-- Deterministic (single-session) scenarios for pgmq_public.claim_org_slot_and_read.
--
-- Every scenario resets the queue and the slot pool first, so they can be read and re-run in any
-- order. Each claim is its own statement inside a DO block, which means each one sees the previous
-- one's committed-to-this-transaction effects -- exactly the sequence a single worker would produce.
-- The genuinely PARALLEL case is scenario 5 and lives in run.sh / 21_storm_claim.sql, because
-- concurrency cannot be simulated from one session.
\set ON_ERROR_STOP on

insert into public.classes(id, github_org) values
  (101, 'org-alpha'),
  (102, 'org-bravo'),
  (103, 'org-charlie'),
  (104, 'org-delta'),
  (105, 'org-echo'),
  (106, 'org-foxtrot'),
  -- A class that exists but has never been connected to GitHub. Its jobs must still drain.
  (107, null)
on conflict (id) do nothing;

-- =============================================================================================
\echo '### scenario 1: single org, 600 ready -> never more than max_per_org slots'
-- =============================================================================================
select harness.reset();
select harness.seed(101, 600);

do $$
declare
  i int;
  v_rows int;
  v_nonempty int := 0;
  v_msgs int := 0;
begin
  -- Twenty holders queue up behind one org's 600-message backlog. max_per_org = 3.
  for i in 1..20 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's1-h' || i, 300, 3, 16) t
     where t.status = 'claimed';
    if v_rows > 0 then
      v_nonempty := v_nonempty + 1;
      v_msgs := v_msgs + v_rows;
    end if;
  end loop;

  perform harness.expect('1 single-org cap', 'claims that won a slot (of 20 tries)', '3', v_nonempty::text);
  perform harness.expect('1 single-org cap', 'messages handed out', '12', v_msgs::text);
  perform harness.expect('1 single-org cap', 'live slots', '3',
    (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));
  perform harness.expect('1 single-org cap', 'live slots for org-alpha', '3',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-alpha'));
  perform harness.expect('1 single-org cap', 'ready messages left', '588',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
end $$;

-- =============================================================================================
\echo '### scenario 2: four orgs x 300 -> breadth before depth'
-- =============================================================================================
select harness.reset();
select harness.seed(101, 300);
select harness.seed(102, 300);
select harness.seed(103, 300);
select harness.seed(104, 300);

do $$
declare
  i int;
begin
  -- max_per_org = 10 and global_cap = 16, so nothing but the ORDER BY stops one org taking
  -- everything. Four claims must land on four different orgs.
  for i in 1..4 loop
    perform count(*) from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's2-h' || i, 300, 10, 16);
  end loop;

  perform harness.expect('2 breadth-first', 'distinct orgs holding a slot after 4 claims', '4',
    (select count(distinct org)::text from public.async_worker_slots where expires_at > clock_timestamp()));
  perform harness.expect('2 breadth-first', 'max slots held by any one org after 4 claims', '1',
    (select coalesce(max(c), 0)::text from (
       select count(*) c from public.async_worker_slots
        where expires_at > clock_timestamp() group by org) x));

  for i in 5..8 loop
    perform count(*) from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's2-h' || i, 300, 10, 16);
  end loop;

  perform harness.expect('2 breadth-first', 'min slots held by any org after 8 claims', '2',
    (select coalesce(min(c), 0)::text from (
       select count(*) c from public.async_worker_slots
        where expires_at > clock_timestamp() group by org) x));
  perform harness.expect('2 breadth-first', 'max slots held by any org after 8 claims', '2',
    (select coalesce(max(c), 0)::text from (
       select count(*) c from public.async_worker_slots
        where expires_at > clock_timestamp() group by org) x));
end $$;

-- =============================================================================================
\echo '### scenario 3: starvation -- 600 vs 3, the small org still gets a slot'
-- =============================================================================================
select harness.reset();
select harness.seed(101, 600);   -- org-alpha: the assignment release
select harness.seed(102, 3);     -- org-bravo: three stragglers

do $$
declare
  i int;
  v_org text;
  v_first text;
  v_second text;
begin
  -- max_per_org = 8 and global_cap = 8: org-alpha could take all eight if depth came first.
  for i in 1..8 loop
    select t.org into v_org
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's3-h' || i, 300, 8, 8) t
     where t.status = 'claimed'
     limit 1;
    if i = 1 then v_first := v_org; end if;
    if i = 2 then v_second := v_org; end if;
  end loop;

  -- Claim 1 is a tie on active (both zero), broken by unmet demand -> the big org.
  perform harness.expect('3 anti-starvation', 'org winning claim 1 (tie broken by demand)', 'org-alpha', v_first);
  -- Claim 2 is NOT a tie: org-alpha now holds 1, org-bravo holds 0. Breadth wins.
  perform harness.expect('3 anti-starvation', 'org winning claim 2 (breadth)', 'org-bravo', v_second);
  perform harness.expect('3 anti-starvation', 'slots held by the 3-message org', '1',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-bravo'));
  perform harness.expect('3 anti-starvation', 'slots held by the 600-message org', '7',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-alpha'));
  -- target(org-bravo) = least(ceil(3/4), 8) = 1, so one slot is also its CEILING, not a shortfall.
  perform harness.expect('3 anti-starvation', 'org-bravo messages fully drained', '0',
    (select count(*)::text from pgmq.q_async_calls
      where vt <= clock_timestamp() and message->>'class_id' = '102'));
end $$;

-- =============================================================================================
\echo '### scenario 4: global_cap is never exceeded'
-- =============================================================================================
select harness.reset();
select harness.seed(101, 100);
select harness.seed(102, 100);
select harness.seed(103, 100);
select harness.seed(104, 100);
select harness.seed(105, 100);
select harness.seed(106, 100);

do $$
declare
  i int;
  v_rows int;
  v_nonempty int := 0;
begin
  -- Six orgs, max_per_org = 10 (so per-org headroom is 60), global_cap = 5.
  for i in 1..30 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's4-h' || i, 300, 10, 5) t
     where t.status = 'claimed';
    if v_rows > 0 then v_nonempty := v_nonempty + 1; end if;
  end loop;

  perform harness.expect('4 global cap', 'claims that won a slot (of 30 tries)', '5', v_nonempty::text);
  perform harness.expect('4 global cap', 'live slots', '5',
    (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));
  perform harness.expect('4 global cap', 'high-water mark seen by the audit trigger', '5',
    (select coalesce(max(live_after), 0)::text from harness.slot_log where stolen = false));
  -- Five slots across six orgs, breadth-first, so five different orgs -- never 5 on one.
  perform harness.expect('4 global cap', 'distinct orgs holding the 5 slots', '5',
    (select count(distinct org)::text from public.async_worker_slots where expires_at > clock_timestamp()));
end $$;

-- =============================================================================================
\echo '### scenario 6: lease expiry reclaims; renew prevents reclaim'
-- =============================================================================================
select harness.reset();
select harness.seed(101, 100);

do $$
declare
  v_rows int;
  v_renewed boolean;
begin
  -- global_cap = 1: the only way a second holder can ever get in is if the first lease dies.
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's6-owner', 2, 4, 1) t
     where t.status = 'claimed';
  perform harness.expect('6 lease lifecycle', 'owner claims', '4', v_rows::text);

  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's6-rival', 2, 4, 1) t
     where t.status = 'claimed';
  perform harness.expect('6 lease lifecycle', 'rival blocked while lease is live', '0', v_rows::text);

  -- Renew past the original TTL, then sleep past it.
  select pgmq_public.renew_org_slot('async_calls', 's6-owner', 60) into v_renewed;
  perform harness.expect('6 lease lifecycle', 'renew of a live lease', 'true', v_renewed::text);
  perform pg_sleep(2.5);

  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's6-rival', 2, 4, 1) t
     where t.status = 'claimed';
  perform harness.expect('6 lease lifecycle', 'rival still blocked after renew outlives original TTL',
    '0', v_rows::text);

  -- Now let a lease actually lapse.
  perform pgmq_public.release_org_slot('async_calls', 's6-owner');
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's6-lapser', 1, 4, 1) t
     where t.status = 'claimed';
  perform harness.expect('6 lease lifecycle', 'claim after release', '4', v_rows::text);

  perform pg_sleep(1.5);
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's6-reclaimer', 60, 4, 1) t
     where t.status = 'claimed';
  perform harness.expect('6 lease lifecycle', 'expired lease is reclaimed by another holder',
    '4', v_rows::text);

  select pgmq_public.renew_org_slot('async_calls', 's6-lapser', 60) into v_renewed;
  perform harness.expect('6 lease lifecycle', 'renew of a lapsed lease is refused', 'false', v_renewed::text);
  perform harness.expect('6 lease lifecycle', 'live slots after reclaim', '1',
    (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));
  perform harness.expect('6 lease lifecycle', 'reclaimed slot belongs to the reclaimer', 's6-reclaimer',
    (select holder from public.async_worker_slots where expires_at > clock_timestamp()));
  -- The reclaim reused the SAME slot row rather than starting a second one.
  perform harness.expect('6 lease lifecycle', 'slot rows ever touched', '1',
    (select count(*)::text from (select distinct queue_name, slot from harness.slot_log) x));
end $$;

-- =============================================================================================
\echo '### scenario 7: messages whose class_id has no github_org still drain'
-- =============================================================================================
select harness.reset();
-- class 107 exists but github_org is null
select harness.seed(107, 5);
-- class_id points at a class that does not exist
select harness.seed_raw(jsonb_build_object('method', 'sync_repo_permissions', 'class_id', 999999,
                                           'log_id', 1, 'args', jsonb_build_object('repo', 'x/y')));
-- no class_id at all (should not happen per the 5522/5522 measurement, but must not be invisible)
select harness.seed_raw(jsonb_build_object('method', 'mystery', 'log_id', 2));
-- class_id present but not a number: the text join must tolerate it rather than raise
select harness.seed_raw(jsonb_build_object('method', 'mystery', 'class_id', 'not-a-number', 'log_id', 3));
-- and one real org alongside, so the sentinel has to actually compete
select harness.seed(101, 40);

do $$
declare
  i int;
  v_rows int;
  v_unresolved int := 0;
begin
  -- Phase A: six holders arrive and each takes one slot, then goes off to do its work (nobody
  -- releases). n = 4, max_per_org = 4, global_cap = 8. The sentinel bucket has 8 ready messages, so
  -- target((unresolved)) = least(ceil(8/4) + 0, 4) = 2, and it has to win both of those slots off a
  -- 40-message real org that is competing for the same global_cap.
  for i in 1..6 loop
    insert into harness.claims(scenario, holder, org, msg_id)
    select '7 sentinel org', 's7-h' || i, t.org, t.msg_id
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's7-h' || i, 300, 4, 8) t
     where t.status = 'claimed';
  end loop;

  perform harness.expect('7 sentinel org', 'sentinel org label', '(unresolved)',
    (select distinct org from harness.claims where scenario = '7 sentinel org' and org <> 'org-alpha'));
  perform harness.expect('7 sentinel org', 'sentinel held a slot like any other org', 'true',
    (select (count(*) > 0)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = '(unresolved)'));
  perform harness.expect('7 sentinel org', 'unresolved messages delivered in phase A', '8',
    (select count(*)::text from harness.claims
      where scenario = '7 sentinel org' and org = '(unresolved)'));
  -- BOTH slots the sentinel was entitled to, which is what the `+ a_all` term in the target buys.
  -- Counting only READY messages, the second read would have seen 4 left, computed a target of 1,
  -- and refused the slot the org had already earned: the org would have been throttled by its own
  -- first claim. Adding back the n messages each active slot is working on makes the target a
  -- statement about the whole backlog.
  perform harness.expect('7 sentinel org', 'slots held by the sentinel after phase A', '2',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = '(unresolved)'));

  -- Phase B: the holders finish and hand their leases back, and one drainer finishes the queue.
  -- This is the property that actually matters -- an unresolvable class_id can be SLOW, but it can
  -- never be invisible.
  for i in 1..6 loop
    perform pgmq_public.release_org_slot('async_calls', 's7-h' || i);
  end loop;

  for i in 1..100 loop
    insert into harness.claims(scenario, holder, org, msg_id)
    select '7 sentinel org', 's7-drain', t.org, t.msg_id
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's7-drain', 300, 4, 8) t
     where t.status = 'claimed';
    get diagnostics v_rows = row_count;
    exit when v_rows = 0;
  end loop;

  select count(*) into v_unresolved
    from harness.claims where scenario = '7 sentinel org' and org = '(unresolved)';

  perform harness.expect('7 sentinel org', 'unresolved messages delivered in total', '8', v_unresolved::text);
  perform harness.expect('7 sentinel org', 'unresolved messages left ready', '0',
    (select count(*)::text from pgmq.q_async_calls q
      left join public.classes c on c.id::text = q.message->>'class_id'
     where q.vt <= clock_timestamp() and c.github_org is null));
  perform harness.expect('7 sentinel org', 'whole queue drained', '0',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
end $$;

-- =============================================================================================
\echo '### scenario 8: fidelity vs stock pgmq.read (read_ct +1, vt += sleep_seconds)'
-- =============================================================================================
select harness.reset();
select harness.seed(101, 8);

do $$
declare
  v_mine record;
  v_stock record;
begin
  -- Ours: four messages with sleep_seconds = 45.
  create temp table s8_mine as
    select t.msg_id, t.read_ct, t.vt, clock_timestamp() as taken_at
      from pgmq_public.claim_org_slot_and_read('async_calls', 45, 4, 's8-h1', 300, 4, 4) t
     where t.status = 'claimed';
  perform pgmq_public.release_org_slot('async_calls', 's8-h1');

  -- Stock pgmq.read, same queue, same vt, same qty -- the remaining four messages.
  create temp table s8_stock as
    select r.msg_id, r.read_ct, r.vt, clock_timestamp() as taken_at
      from pgmq.read('async_calls', 45, 4) r;

  perform harness.expect('8 pgmq.read fidelity', 'rows returned (ours)', '4',
    (select count(*)::text from s8_mine));
  perform harness.expect('8 pgmq.read fidelity', 'rows returned (stock)', '4',
    (select count(*)::text from s8_stock));
  perform harness.expect('8 pgmq.read fidelity', 'distinct msg_ids across ours+stock', '8',
    (select count(distinct msg_id)::text from (select msg_id from s8_mine union all select msg_id from s8_stock) u));

  perform harness.expect('8 pgmq.read fidelity', 'read_ct after first read (ours)', '{1}',
    (select array_agg(distinct read_ct)::text from s8_mine));
  perform harness.expect('8 pgmq.read fidelity', 'read_ct after first read (stock)', '{1}',
    (select array_agg(distinct read_ct)::text from s8_stock));

  -- vt advanced by sleep_seconds, within 1s of the moment the row came back.
  perform harness.expect('8 pgmq.read fidelity', 'ours: every vt is taken_at + 45s (+/- 1s)', 'true',
    (select bool_and(abs(extract(epoch from (vt - taken_at)) - 45) < 1)::text from s8_mine));
  perform harness.expect('8 pgmq.read fidelity', 'stock: every vt is taken_at + 45s (+/- 1s)', 'true',
    (select bool_and(abs(extract(epoch from (vt - taken_at)) - 45) < 1)::text from s8_stock));
  perform harness.expect('8 pgmq.read fidelity', 'ours and stock agree on the vt delta (+/- 1s)', 'true',
    (select (abs(
       (select avg(extract(epoch from (vt - taken_at))) from s8_mine) -
       (select avg(extract(epoch from (vt - taken_at))) from s8_stock)) < 1)::text));

  -- The returned vt is what actually landed in the queue table, not a value we made up.
  perform harness.expect('8 pgmq.read fidelity', 'returned vt matches the row in pgmq.q_async_calls', 'true',
    (select bool_and(q.vt = m.vt and q.read_ct = m.read_ct)::text
       from s8_mine m join pgmq.q_async_calls q using (msg_id)));

  -- Second read of the SAME messages increments again rather than resetting.
  update pgmq.q_async_calls set vt = clock_timestamp() where msg_id in (select msg_id from s8_mine);
  perform harness.expect('8 pgmq.read fidelity', 'read_ct on a second read', '{2}',
    (select array_agg(distinct t.read_ct)::text
       from pgmq_public.claim_org_slot_and_read('async_calls', 45, 4, 's8-h2', 300, 4, 4) t
      where t.status = 'claimed'));

  drop table s8_mine;
  drop table s8_stock;
end $$;

-- =============================================================================================
\echo '### scenario 9: empty queue -> zero rows, nothing claimed'
-- =============================================================================================
select harness.reset();

do $$
declare
  v_rows int;
begin
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's9-h1', 300, 8, 16) t
     where t.status = 'claimed';
  perform harness.expect('9 empty queue', 'rows returned', '0', v_rows::text);
  perform harness.expect('9 empty queue', 'live slots', '0',
    (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));
  perform harness.expect('9 empty queue', 'slot rows written at all', '0',
    (select count(*)::text from harness.slot_log));

  -- Same again with a queue that has messages but all of them invisible (vt in the future).
  perform harness.seed(101, 20);
  update pgmq.q_async_calls set vt = clock_timestamp() + interval '10 minutes';
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's9-h2', 300, 8, 16) t
     where t.status = 'claimed';
  perform harness.expect('9 empty queue', 'rows returned when everything is invisible', '0', v_rows::text);
  perform harness.expect('9 empty queue', 'live slots when everything is invisible', '0',
    (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));
end $$;

-- =============================================================================================
\echo '### scenario 10: two queues, overlapping slot numbers, independent pools and caps'
-- =============================================================================================
-- The case the original (slot int primary key) contract would have broken SILENTLY. With a global
-- slot key, a second queue seeded 1..N collides with async_calls' 1..64, `on conflict do nothing`
-- swallows every row, and the second queue ends up with a pool of ZERO slots -- which presents at
-- runtime as "claim always returns no rows", indistinguishable from an empty queue. With the key on
-- (queue_name, slot) both pools exist, numbered from 1, and never see each other.
select pgmq.create('orglease_alt');

-- Deliberately 1..4: the SAME slot numbers async_calls already occupies.
insert into public.async_worker_slots (queue_name, slot)
select 'orglease_alt', g from generate_series(1, 4) as g
on conflict (queue_name, slot) do nothing;

do $$
begin
  perform harness.expect('10 two queues', 'async_calls pool size', '64',
    (select count(*)::text from public.async_worker_slots where queue_name = 'async_calls'));
  -- Under the old key this would have been 0, and nothing would have said so.
  perform harness.expect('10 two queues', 'orglease_alt pool size', '4',
    (select count(*)::text from public.async_worker_slots where queue_name = 'orglease_alt'));
  -- Scoped to the two pools this scenario is about. There is a THIRD pool sharing 1..4 by now --
  -- async_calls_low_priority, seeded by the migration -- which is the point rather than a nuisance:
  -- every pool numbers from 1 and none of them collide.
  perform harness.expect('10 two queues', 'slot numbers 1..4 exist in both pools', '4',
    (select count(*)::text from (
       select slot from public.async_worker_slots
        where slot between 1 and 4 and queue_name in ('async_calls', 'orglease_alt')
        group by slot having count(distinct queue_name) = 2) x));
  perform harness.expect('10 two queues', 'slot 1 exists in all three seeded pools', '3',
    (select count(*)::text from public.async_worker_slots where slot = 1));
end $$;

select harness.reset('async_calls');
select pgmq.purge_queue('orglease_alt');
select harness.seed(101, 100);                       -- async_calls: org-alpha
select harness.seed(102, 100);                       -- async_calls: org-bravo
select harness.seed(103, 100, true, 'orglease_alt'); -- orglease_alt: org-charlie
select harness.seed(104, 100, true, 'orglease_alt'); -- orglease_alt: org-delta

do $$
declare
  i int;
  v_rows int;
  v_alt_wins int := 0;
  v_main_wins int := 0;
begin
  -- Five holders contend for orglease_alt with global_cap = 2.
  for i in 1..5 loop
    insert into harness.claims(scenario, holder, org, msg_id)
    select '10 two queues', 'alt-h' || i, t.org, t.msg_id
      from pgmq_public.claim_org_slot_and_read('orglease_alt', 300, 4, 'alt-h' || i, 300, 4, 2) t
     where t.status = 'claimed';
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_alt_wins := v_alt_wins + 1; end if;
  end loop;

  perform harness.expect('10 two queues', 'alt claims that won a slot (cap 2, of 5)', '2', v_alt_wins::text);
  perform harness.expect('10 two queues', 'live slots in the alt pool', '2',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'orglease_alt' and expires_at > clock_timestamp()));
  -- Draining one queue must not consume the other queue's pool at all.
  perform harness.expect('10 two queues', 'live slots in the async_calls pool', '0',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
  -- And it must not hand out the other queue's messages.
  perform harness.expect('10 two queues', 'orgs seen in alt claims', '{org-charlie,org-delta}',
    (select array_agg(distinct org order by org)::text from harness.claims
      where scenario = '10 two queues'));
  perform harness.expect('10 two queues', 'async_calls messages still ready', '200',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
  perform harness.expect('10 two queues', 'orglease_alt messages still ready', '192',
    (select count(*)::text from pgmq.q_orglease_alt where vt <= clock_timestamp()));

  -- Now the other queue, with global_cap = 5. Five holders try, but the budget is counted across
  -- EVERY pool, so the two slots orglease_alt already holds come out of the same five: async_calls
  -- can add three, not five. Slot ROWS are per pool; the BUDGET is not.
  for i in 1..5 loop
    insert into harness.claims(scenario, holder, org, msg_id)
    select '10 two queues main', 'main-h' || i, t.org, t.msg_id
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'main-h' || i, 300, 4, 5) t
     where t.status = 'claimed';
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_main_wins := v_main_wins + 1; end if;
  end loop;

  perform harness.expect('10 two queues', 'main claims that won a slot (cap 5, of 5, 2 already spent)',
    '3', v_main_wins::text);
  perform harness.expect('10 two queues', 'live slots in the async_calls pool', '3',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
  perform harness.expect('10 two queues', 'alt pool untouched by the async_calls claims', '2',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'orglease_alt' and expires_at > clock_timestamp()));
  -- Five overall, not 2 + 5 = 7. This is the check that fails if `live` is filtered by queue.
  perform harness.expect('10 two queues', 'live slots overall equal the cap, counted across pools',
    '5', (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));
  -- Slot number 1 is live TWICE: once per pool. Under the old key that was one row and one of these
  -- two queues would have been silently starved of it.
  perform harness.expect('10 two queues', 'slot number 1 live in both pools at once', '2',
    (select count(*)::text from public.async_worker_slots
      where slot = 1 and expires_at > clock_timestamp()));
  perform harness.expect('10 two queues', 'orgs seen in async_calls claims', '{org-alpha,org-bravo}',
    (select array_agg(distinct org order by org)::text from harness.claims
      where scenario = '10 two queues main'));

  -- release only touches the releasing holder's own row, in its own pool.
  perform pgmq_public.release_org_slot('orglease_alt', 'alt-h1');
  perform harness.expect('10 two queues', 'alt pool after releasing one alt holder', '1',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'orglease_alt' and expires_at > clock_timestamp()));
  perform harness.expect('10 two queues', 'async_calls pool after releasing one alt holder', '3',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
end $$;

select harness.reset('async_calls');
select pgmq.purge_queue('orglease_alt');

-- =============================================================================================
\echo '### scenario 11: the low-priority queue has a pool and actually drains'
-- =============================================================================================
-- The blocker found on the TypeScript side. ASYNC_QUEUE_NAMES is ["async_calls",
-- "async_calls_low_priority"] and the worker rotates onto the second queue whenever the first comes
-- back empty. Before the migration seeded a pool for it, a claim there returned zero rows forever --
-- indistinguishable from an empty queue, so repo-analytics work would have stopped draining
-- silently the moment per-org mode was switched on.
select harness.reset('async_calls');
select pgmq.purge_queue('async_calls_low_priority');
select harness.seed(105, 60, true, 'async_calls_low_priority');   -- org-echo
select harness.seed(106, 60, true, 'async_calls_low_priority');   -- org-foxtrot

do $$
declare
  i int;
  v_rows int;
  v_total int := 0;
  v_wins int := 0;
begin
  perform harness.expect('11 low priority', 'async_calls_low_priority pool size', '16',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls_low_priority'));
  -- >= MAX_ORG_SLOT_GLOBAL_CAP (8): a pool smaller than the largest global_cap the worker can pass
  -- would silently cap the configured budget, which is the same failure in a less obvious form.
  perform harness.expect('11 low priority', 'pool covers MAX_ORG_SLOT_GLOBAL_CAP of 8', 'true',
    (select (count(*) >= 8)::text from public.async_worker_slots
      where queue_name = 'async_calls_low_priority'));

  -- THE check: a claim against the low-priority queue returns rows. This returned zero before.
  for i in 1..4 loop
    insert into harness.claims(scenario, holder, org, msg_id)
    select '11 low priority', 'lp-h' || i, t.org, t.msg_id
      from pgmq_public.claim_org_slot_and_read('async_calls_low_priority', 300, 4, 'lp-h' || i, 300, 2, 8) t
     where t.status = 'claimed';
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
    if v_rows > 0 then v_wins := v_wins + 1; end if;
  end loop;

  perform harness.expect('11 low priority', 'claims that returned rows (of 4)', '4', v_wins::text);
  perform harness.expect('11 low priority', 'messages handed out', '16', v_total::text);
  perform harness.expect('11 low priority', 'orgs drained', '{org-echo,org-foxtrot}',
    (select array_agg(distinct org order by org)::text from harness.claims
      where scenario = '11 low priority'));
  perform harness.expect('11 low priority', 'live slots in the low-priority pool', '4',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls_low_priority' and expires_at > clock_timestamp()));
  perform harness.expect('11 low priority', 'async_calls pool untouched', '0',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
end $$;

-- And the guard that stops this class of bug being silent again: a queue with no pool at all is a
-- deployment error, so it RAISES rather than returning the same zero rows an empty queue returns.
select pgmq.create('orglease_unseeded');
do $$
declare
  v_sqlstate text;
  v_msg text;
begin
  begin
    perform * from pgmq_public.claim_org_slot_and_read('orglease_unseeded', 300, 4, 'u-h1', 300, 2, 8);
    v_msg := '(no exception raised)';
  exception when others then
    get stacked diagnostics v_msg = message_text;
  end;
  perform harness.expect('11 low priority', 'unseeded pool raises instead of returning zero rows', 'true',
    (v_msg like '%no slot pool seeded for queue orglease_unseeded%')::text);
end $$;

-- =============================================================================================
\echo '### scenario 12: one holder on two queues -- renew and release are queue-scoped'
-- =============================================================================================
-- A worker run rotates between async_calls and async_calls_low_priority using ONE holder string, so
-- it legitimately ends up holding a slot in each pool. Under the original holder-scoped signatures
-- `renew(holder)` extended BOTH, which meant the slot the worker had rotated away from never
-- expired: an abandoned lease occupying a global_cap slot and holding its org below target for as
-- long as the worker lived. Queue scoping bounds that at one TTL -- the same bound a crashed isolate
-- already has.
select harness.reset('async_calls');
select pgmq.purge_queue('async_calls_low_priority');
select harness.seed(101, 40);                                     -- async_calls: org-alpha
select harness.seed(102, 40, true, 'async_calls_low_priority');   -- low priority: org-bravo

do $$
declare
  v_rows int;
  v_renewed boolean;
  v_main_expiry timestamptz;
  v_low_expiry timestamptz;
begin
  -- One holder, both queues, short TTL on both.
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'rotator', 2, 2, 8) t
     where t.status = 'claimed';
  perform harness.expect('12 queue-scoped lease', 'claim on async_calls', '4', v_rows::text);
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls_low_priority', 300, 4, 'rotator', 2, 2, 8) t
     where t.status = 'claimed';
  perform harness.expect('12 queue-scoped lease', 'claim on async_calls_low_priority', '4', v_rows::text);

  -- One holder, two live slots, one per pool. This is legal and expected.
  perform harness.expect('12 queue-scoped lease', 'slots held by the rotator, one per pool', '2',
    (select count(*)::text from public.async_worker_slots
      where holder = 'rotator' and expires_at > clock_timestamp()));

  select s.expires_at into v_main_expiry from public.async_worker_slots s
   where s.queue_name = 'async_calls' and s.holder = 'rotator';
  select s.expires_at into v_low_expiry from public.async_worker_slots s
   where s.queue_name = 'async_calls_low_priority' and s.holder = 'rotator';

  -- The worker has rotated onto the low-priority queue and heartbeats THAT lease.
  select pgmq_public.renew_org_slot('async_calls_low_priority', 'rotator', 120) into v_renewed;
  perform harness.expect('12 queue-scoped lease', 'renew of the queue we are on', 'true', v_renewed::text);
  perform harness.expect('12 queue-scoped lease', 'low-priority lease extended', 'true',
    (select (s.expires_at > v_low_expiry + interval '100 seconds')::text
       from public.async_worker_slots s
      where s.queue_name = 'async_calls_low_priority' and s.holder = 'rotator'));
  -- THE check. Under holder scoping this one moved too, and the abandoned slot never died.
  perform harness.expect('12 queue-scoped lease', 'async_calls lease NOT extended by that renew', 'true',
    (select (s.expires_at = v_main_expiry)::text
       from public.async_worker_slots s
      where s.queue_name = 'async_calls' and s.holder = 'rotator'));

  -- Let the abandoned lease lapse. Bound: exactly one TTL.
  perform pg_sleep(2.5);
  perform harness.expect('12 queue-scoped lease', 'abandoned async_calls lease has expired', '0',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
  perform harness.expect('12 queue-scoped lease', 'low-priority lease survives', '1',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls_low_priority' and expires_at > clock_timestamp()));
  -- The freed slot is usable by someone else, so it is genuinely released rather than merely stale.
  select count(*) into v_rows
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'rival', 60, 2, 8) t
     where t.status = 'claimed';
  perform harness.expect('12 queue-scoped lease', 'rival can take the freed async_calls slot', '4', v_rows::text);

  -- Renewing the lapsed one is refused, and queue-scoped: it must not silently renew the live
  -- low-priority lease instead.
  select pgmq_public.renew_org_slot('async_calls', 'rotator', 120) into v_renewed;
  perform harness.expect('12 queue-scoped lease', 'renew of the lapsed queue is refused', 'false', v_renewed::text);

  -- Release is scoped the same way.
  perform pgmq_public.release_org_slot('async_calls_low_priority', 'rotator');
  perform harness.expect('12 queue-scoped lease', 'released the low-priority lease', '0',
    (select count(*)::text from public.async_worker_slots
      where queue_name = 'async_calls_low_priority' and expires_at > clock_timestamp()));
  perform harness.expect('12 queue-scoped lease', 'the rival lease on async_calls is untouched', 'rival',
    (select holder from public.async_worker_slots
      where queue_name = 'async_calls' and expires_at > clock_timestamp()));
end $$;

select harness.reset('async_calls');
select pgmq.purge_queue('async_calls_low_priority');

-- =============================================================================================
\echo '### scenario 13: caps are counted across BOTH pools, not per pool'
-- =============================================================================================
-- Slot rows are keyed (queue_name, slot) so each queue owns its own pool. The budgets are not:
-- global_cap bounds resident isolates against the edge tier's maxParallelism, and max_per_org
-- bounds concurrent handlers against one org's GitHub content quota. An isolate draining
-- async_calls_low_priority spends both exactly as one draining async_calls does. Counting per pool
-- let each queue admit a full global_cap of its own.
select harness.reset('async_calls');
select pgmq.purge_queue('async_calls_low_priority');
-- The SAME org has work on both queues. That is the case that matters: its GitHub quota is one
-- bucket regardless of which queue the job arrived on.
select harness.seed(101, 200);                                    -- async_calls: org-alpha
select harness.seed(101, 200, true, 'async_calls_low_priority');  -- low priority: org-alpha too
select harness.seed(102, 200);                                    -- async_calls: org-bravo
select harness.seed(103, 200, true, 'async_calls_low_priority');  -- low priority: org-charlie

do $$
declare
  i int;
  v_rows int;
begin
  -- max_per_org = 2 with plenty of ready work on both queues, so only the cap can stop org-alpha.
  for i in 1..4 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'x-main-' || i, 300, 2, 16) t
     where t.status = 'claimed';
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls_low_priority', 300, 4, 'x-low-' || i, 300, 2, 16) t
     where t.status = 'claimed';
  end loop;

  -- THE check for finding 1 at the org level. Per-pool counting gave org-alpha 2 slots in each
  -- pool, i.e. 4 concurrent leaseholders against one 40/min GitHub bucket.
  perform harness.expect('13 caps across pools', 'org-alpha slots across BOTH pools', '2',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-alpha'));
  perform harness.expect('13 caps across pools', 'org-alpha slots in async_calls alone', '1',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-alpha' and queue_name = 'async_calls'));
  perform harness.expect('13 caps across pools', 'org-alpha slots in async_calls_low_priority alone', '1',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-alpha'
        and queue_name = 'async_calls_low_priority'));
  perform harness.expect('13 caps across pools', 'no org exceeds max_per_org fleet-wide', '2',
    (select coalesce(max(c), 0)::text from (
       select count(*) c from public.async_worker_slots
        where expires_at > clock_timestamp() group by org) x));
end $$;

-- And the same thing for global_cap: the budget is spent once, not once per queue.
select harness.reset('async_calls');
select pgmq.purge_queue('async_calls_low_priority');
select harness.seed(101, 200);
select harness.seed(102, 200);
select harness.seed(103, 200, true, 'async_calls_low_priority');
select harness.seed(104, 200, true, 'async_calls_low_priority');

do $$
declare
  i int;
  v_rows int;
  v_wins int := 0;
begin
  -- global_cap = 3, alternating queues, twelve attempts. Per-pool counting admitted 3 per queue.
  for i in 1..12 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read(
             case when i % 2 = 0 then 'async_calls' else 'async_calls_low_priority' end,
             300, 4, 'g-h' || i, 300, 4, 3) t
     where t.status = 'claimed';
    if v_rows > 0 then v_wins := v_wins + 1; end if;
  end loop;

  perform harness.expect('13 caps across pools', 'claims that won a slot under a shared cap of 3',
    '3', v_wins::text);
  perform harness.expect('13 caps across pools', 'live slots across both pools', '3',
    (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));
  perform harness.expect('13 caps across pools', 'both pools were actually used', 'true',
    (select (count(distinct queue_name) = 2)::text from public.async_worker_slots
      where expires_at > clock_timestamp()));
end $$;

-- =============================================================================================
\echo '### scenario 14: two casings of one org share a single allowance'
-- =============================================================================================
-- GitHub org names are case-insensitive and one rate-limit bucket serves every spelling, and one
-- class in prod already stores a mixed-case github_org. Without the case fold each spelling drew a
-- full max_per_org allowance against that single bucket.
select harness.reset('async_calls');
insert into public.classes(id, github_org) values
  (201, 'Khoury-Case'),   -- as an instructor typed it
  (202, 'khoury-case')    -- the same GitHub org, lowercased
on conflict (id) do update set github_org = excluded.github_org;
select harness.seed(201, 100);
select harness.seed(202, 100);

do $$
declare
  i int;
  v_rows int;
  v_wins int := 0;
begin
  -- max_per_org = 2. Two spellings, one org, so two slots in total and not two each.
  for i in 1..6 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'case-h' || i, 300, 2, 16) t
     where t.status = 'claimed';
    if v_rows > 0 then v_wins := v_wins + 1; end if;
  end loop;

  perform harness.expect('14 org case folding', 'claims that won a slot (max_per_org 2, of 6)',
    '2', v_wins::text);
  perform harness.expect('14 org case folding', 'distinct org labels on live slots', '1',
    (select count(distinct org)::text from public.async_worker_slots
      where expires_at > clock_timestamp()));
  perform harness.expect('14 org case folding', 'the label stored on the slot is folded',
    'khoury-case',
    (select distinct org from public.async_worker_slots where expires_at > clock_timestamp()));
  perform harness.expect('14 org case folding', 'messages read under the shared allowance', '8',
    (select count(*)::text from pgmq.q_async_calls where vt > clock_timestamp()));

  -- Both spellings drain through that one allowance rather than one of them being stranded behind
  -- the other. Reads go in msg_id order within the org, so this needs the whole queue drained to
  -- show, not just the first two batches.
  for i in 1..6 loop
    perform pgmq_public.release_org_slot('async_calls', 'case-h' || i);
  end loop;
  for i in 1..200 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'case-drain', 300, 2, 16) t
     where t.status = 'claimed';
    exit when v_rows = 0;
  end loop;

  perform harness.expect('14 org case folding', 'mixed-case class fully drained', '0',
    (select count(*)::text from pgmq.q_async_calls
      where vt <= clock_timestamp() and message->>'class_id' = '201'));
  perform harness.expect('14 org case folding', 'lowercase class fully drained', '0',
    (select count(*)::text from pgmq.q_async_calls
      where vt <= clock_timestamp() and message->>'class_id' = '202'));
  -- Slots are reused in place, so the labels still on the pool are every label this scenario ever
  -- allocated. One org, not two.
  perform harness.expect('14 org case folding', 'org labels ever allocated in this scenario', '{khoury-case}',
    (select array_agg(distinct org order by org)::text from public.async_worker_slots
      where org is not null));
end $$;

-- =============================================================================================
\echo '### scenario 15: the envelope''s own org wins over a class that has since moved'
-- =============================================================================================
-- An instructor repoints a class at a new GitHub org while envelopes are already queued. The
-- handlers will call the org baked into message.args, so that is the org whose quota the slot has
-- to be charged against. Attributing the in-flight work to the class's NEW org would budget for an
-- org no handler is going to touch.
select harness.reset('async_calls');
insert into public.classes(id, github_org) values (203, 'org-after-move')
on conflict (id) do update set github_org = excluded.github_org;
-- Queued BEFORE the move: args.org still names the old org.
select harness.seed_raw(jsonb_build_object(
  'method', 'create_repo', 'class_id', 203, 'log_id', 1,
  'args', jsonb_build_object('org', 'org-before-move')));
select harness.seed_raw(jsonb_build_object(
  'method', 'create_repo', 'class_id', 203, 'log_id', 2,
  'args', jsonb_build_object('org', 'ORG-BEFORE-MOVE')));   -- and case-folded the same way
-- Queued AFTER the move, and the 14% shape: no args.org at all, so the class lookup is the only
-- thing that can answer. This is why the fallback is required rather than decorative.
select harness.seed_raw(jsonb_build_object(
  'method', 'sync_repo_permissions', 'class_id', 203, 'log_id', 3,
  'args', jsonb_build_object('repo', 'org-after-move/x')));

do $$
declare
  v_first text;
  v_second text;
begin
  select t.org into v_first
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'mv-h1', 300, 1, 8) t
   where t.status = 'claimed' limit 1;
  select t.org into v_second
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'mv-h2', 300, 1, 8) t
   where t.status = 'claimed' limit 1;

  -- Two orgs, from one class. The envelope's org and the class's current org are both represented.
  perform harness.expect('15 envelope org wins', 'orgs claimed from one class', '{org-after-move,org-before-move}',
    (select array_agg(distinct o order by o)::text from (select v_first as o union all select v_second) x));
  perform harness.expect('15 envelope org wins', 'both envelopes naming the old org grouped together', '2',
    (select count(*)::text from harness.slot_log));
  perform harness.expect('15 envelope org wins', 'the old-org slot carries the folded envelope org', '1',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-before-move'));
  perform harness.expect('15 envelope org wins', 'the no-args envelope fell back to the class org', '1',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-after-move'));
  perform harness.expect('15 envelope org wins', 'everything drained', '0',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
end $$;

-- =============================================================================================
\echo '### scenario 16: an org is not throttled by its own in-flight batches'
-- =============================================================================================
-- The exact case from the review: one org, n = 4, max_per_org = 2, 8 ready messages. Counting only
-- visible work, the first claim hides 4, the second sees ready = 4, computes ceil(4/4) = 1, and
-- refuses the second slot the org had already earned.
select harness.reset('async_calls');
select harness.seed(101, 8);

do $$
declare
  v_rows int;
  v_wins int := 0;
  i int;
begin
  for i in 1..4 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'inflight-h' || i, 300, 2, 16) t
     where t.status = 'claimed';
    if v_rows > 0 then v_wins := v_wins + 1; end if;
  end loop;

  perform harness.expect('16 in-flight demand', 'slots granted for 8 ready messages at n=4', '2',
    v_wins::text);
  perform harness.expect('16 in-flight demand', 'live slots for the org', '2',
    (select count(*)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and org = 'org-alpha'));
  perform harness.expect('16 in-flight demand', 'all 8 messages handed out', '0',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
  -- And the cap still binds: the third and fourth holders get nothing.
  perform harness.expect('16 in-flight demand', 'holders turned away', '2', (4 - v_wins)::text);
end $$;

-- The tail of a larger burst is the same shape, so check the ceiling is still max_per_org and not
-- something the `+ a_all` term inflated.
select harness.reset('async_calls');
select harness.seed(101, 400);

do $$
declare
  v_rows int;
  v_wins int := 0;
  i int;
begin
  for i in 1..8 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'big-h' || i, 300, 2, 16) t
     where t.status = 'claimed';
    if v_rows > 0 then v_wins := v_wins + 1; end if;
  end loop;
  perform harness.expect('16 in-flight demand', 'max_per_org still caps a 400-message burst', '2',
    v_wins::text);
end $$;

-- =============================================================================================
\echo '### scenario 17: no_demand and no_capacity are distinguishable'
-- =============================================================================================
-- Zero message rows used to be one answer for two situations, and the worker reads them
-- differently: an empty queue means move on to the next queue in priority order, whereas a full cap
-- means work is waiting here and moving on would leave urgent repo work behind while the worker
-- drains analytics.
select harness.reset('async_calls');

do $$
declare
  v_status text;
  v_cols int;
begin
  -- Empty queue.
  select t.status into v_status
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h1', 300, 4, 8) t;
  perform harness.expect('17 status', 'empty queue reports', 'no_demand', v_status);
  perform harness.expect('17 status', 'and claims nothing', '0',
    (select count(*)::text from public.async_worker_slots where expires_at > clock_timestamp()));

  -- Exactly one row, with every message column null.
  select count(*) into v_cols
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h2', 300, 4, 8) t
   where t.org is null and t.msg_id is null and t.read_ct is null
     and t.enqueued_at is null and t.vt is null and t.message is null;
  perform harness.expect('17 status', 'one row, message columns all null', '1', v_cols::text);

  -- Work present, budget exhausted.
  perform harness.seed(101, 200);
  select t.status into v_status
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h3', 300, 1, 1) t limit 1;
  perform harness.expect('17 status', 'first claim succeeds', 'claimed', v_status);
  select t.status into v_status
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h4', 300, 1, 1) t;
  perform harness.expect('17 status', 'work waiting but global_cap full reports', 'no_capacity', v_status);

  -- Same again for max_per_org rather than global_cap: one org, its allowance spent.
  select t.status into v_status
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h5', 300, 1, 8) t;
  perform harness.expect('17 status', 'work waiting but max_per_org full reports', 'no_capacity', v_status);

  -- A zero budget is an instruction to stop claiming, not an error, and it reports the same way.
  select t.status into v_status
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h6', 300, 0, 0) t;
  perform harness.expect('17 status', 'a zero budget reports', 'no_capacity', v_status);

  -- Draining the queue flips the answer back, which is what lets the worker move on.
  perform pgmq_public.release_org_slot('async_calls', 'st-h3');
  perform pgmq.purge_queue('async_calls');
  select t.status into v_status
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h7', 300, 4, 8) t;
  perform harness.expect('17 status', 'drained queue reports', 'no_demand', v_status);

  -- And a successful claim never emits a status row alongside the messages.
  perform harness.seed(101, 12);
  perform harness.expect('17 status', 'a successful claim returns only claimed rows', '{claimed}',
    (select array_agg(distinct t.status)::text
       from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'st-h8', 300, 4, 8) t));
end $$;

-- =============================================================================================
\echo '### cost: the demand aggregate, at prod-incident scale and at 10x that'
-- =============================================================================================
-- The claim on the table is that the allocator's input -- "how many ready messages does each org
-- have?" -- stays a single cheap aggregate scan. Prod measured 0.376 ms. Measuring at two sizes is
-- the only way to say anything useful about that number: one point tells you nothing about whether
-- the cost is per-row or fixed.
select harness.reset();

create or replace function harness.time_demand(p_runs int)
returns table(best numeric, mean numeric) language plpgsql as $fn$
declare
  i int;
  v_plan json;
  v_ms numeric;
  v_best numeric := 1e9;
  v_total numeric := 0;
begin
  for i in 1..p_runs loop
    execute $q$
      explain (analyze, timing, format json)
      select coalesce(c.github_org, '(unresolved)') as org, count(*)::int as ready
        from pgmq.q_async_calls q
        left join public.classes c on c.id::text = q.message->>'class_id'
       where q.vt <= clock_timestamp()
       group by 1
    $q$ into v_plan;
    v_ms := (v_plan -> 0 ->> 'Execution Time')::numeric;
    v_best := least(v_best, v_ms);
    v_total := v_total + v_ms;
  end loop;
  return query select round(v_best, 3), round(v_total / p_runs, 3);
end $fn$;

-- Point 1: 250 ready rows, roughly the 242-message assignment release that started all this.
select harness.seed(101, 60);
select harness.seed(102, 60);
select harness.seed(103, 60);
select harness.seed(104, 60);
select harness.seed(107, 10);
vacuum (analyze) pgmq.q_async_calls;
vacuum (analyze) public.classes;

do $$
declare
  v_t record;
  i int;
  v_rows int;
  v_claim_ms numeric;
  v_t0 timestamptz;
begin
  select * into v_t from harness.time_demand(20);
  perform harness.note('cost', '[250 rows] ready rows in queue',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
  perform harness.note('cost', '[250 rows] demand aggregate, best of 20 (ms)', v_t.best::text);
  perform harness.note('cost', '[250 rows] demand aggregate, mean of 20 (ms)', v_t.mean::text);

  -- The full RPC at incident scale. This number IS the advisory lock's hold time, and its
  -- reciprocal is the allocator's serialized throughput ceiling -- the one thing a per-queue lock
  -- costs us. Measured single-threaded on purpose: with no contention there is nothing in it but
  -- the work itself.
  v_t0 := clock_timestamp();
  for i in 1..20 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'cost250-h' || i, 300, 8, 32) t
     where t.status = 'claimed';
  end loop;
  v_claim_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000 / 20;
  perform harness.note('cost', '[250 rows] claim_org_slot_and_read, mean of 20 (ms)', round(v_claim_ms, 3)::text);
  perform harness.note('cost', '[250 rows] implied serialized ceiling (claims/sec)',
    round(1000 / v_claim_ms, 0)::text);

  -- Put the 80 messages that timing consumed back, and hand the slots back, so the 2500-row
  -- measurement below starts from exactly 2500 ready rows and an empty pool.
  update pgmq.q_async_calls set vt = clock_timestamp();
  update public.async_worker_slots
     set org = null, holder = null, claimed_at = null, expires_at = '-infinity';
end $$;

-- Point 2: 2500 ready rows -- ten simultaneous releases, an order of magnitude past anything
-- observed.
select harness.seed(101, 540);
select harness.seed(102, 540);
select harness.seed(103, 540);
select harness.seed(104, 540);
select harness.seed(107, 90);

-- Deliberately measured BEFORE the vacuum as well: the scenarios above churned this table and pgmq
-- never deletes on read, so "what does it cost when autovacuum is behind?" is the honest question
-- for a queue, not just "what does it cost on a clean table?".
do $$
declare v_t record;
begin
  select * into v_t from harness.time_demand(20);
  perform harness.note('cost', '[2500 rows, pre-vacuum] queue table size',
    pg_size_pretty(pg_table_size('pgmq.q_async_calls')));
  perform harness.note('cost', '[2500 rows, pre-vacuum] demand aggregate, best of 20 (ms)', v_t.best::text);
  perform harness.note('cost', '[2500 rows, pre-vacuum] demand aggregate, mean of 20 (ms)', v_t.mean::text);
end $$;

-- VACUUM cannot run inside a transaction block, so this has to be its own top-level statement.
vacuum (analyze) pgmq.q_async_calls;
vacuum (analyze) public.classes;

do $$
declare
  v_t record;
  i int;
  v_rows int;
  v_claim_ms numeric;
  v_t0 timestamptz;
begin
  select * into v_t from harness.time_demand(20);
  perform harness.note('cost', '[2500 rows] ready rows in queue',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
  perform harness.note('cost', '[2500 rows] demand aggregate, best of 20 (ms)', v_t.best::text);
  perform harness.note('cost', '[2500 rows] demand aggregate, mean of 20 (ms)', v_t.mean::text);
  perform harness.expect('cost', 'demand aggregate best-of-20 under 5 ms at 2500 ready rows', 'true',
    (v_t.best < 5.0)::text);

  -- And the whole RPC, end to end: advisory lock, demand aggregate, slot claim, filtered read.
  v_t0 := clock_timestamp();
  for i in 1..20 loop
    select count(*) into v_rows
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 'cost-h' || i, 300, 8, 32) t
     where t.status = 'claimed';
  end loop;
  v_claim_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000 / 20;
  perform harness.note('cost', '[2500 rows] claim_org_slot_and_read, mean of 20 (ms)', round(v_claim_ms, 3)::text);
  perform harness.note('cost', '[2500 rows] implied serialized ceiling (claims/sec)',
    round(1000 / v_claim_ms, 0)::text);
  perform harness.expect('cost', 'full RPC mean under 15 ms', 'true', (v_claim_ms < 15.0)::text);
end $$;
