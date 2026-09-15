-- Scenario 19: a class whose github_org is the EMPTY STRING, not NULL.
--
-- WHY THIS IS ITS OWN SCENARIO AND NOT A LINE IN SCENARIO 7. Scenario 7 covers every way a message
-- can fail to resolve to an org EXCEPT this one: class_id absent, class_id matching nothing,
-- class_id non-numeric, and a class whose github_org IS NULL. `public.classes.github_org` is a
-- nullable text column with no check constraint, so '' is also reachable, and it is reachable in
-- practice -- five other migrations in this repo guard it by hand (`github_org <> ''` in
-- 20250908133405, 20251004115504 and 20260909170000; `nullif(trim(github_org), '')` in
-- 20260315200001 and 20260322000001).
--
-- WHAT GOES WRONG WITHOUT THE nullif. coalesce stops at the first non-null arm, and '' is not null,
-- so an unwrapped class fallback answers org = '' and the '(unresolved)' sentinel is never reached.
-- The claim then hands the caller org = '', which is not merely an odd label:
--
--   * _shared/orgLeaseRun.ts refuses to pin on a falsy org
--     (`if (!held || heldQueueName === null || !heldOrgValue) return null`), so continuous refill
--     quiesces on EVERY top-up for that org and the run degrades to batch-at-a-time -- the exact
--     behaviour this branch exists to remove -- with no error anywhere;
--   * and if that guard were ever removed, claim_org_slot_and_read RAISES P0001 on an empty
--     pin_org, which is fatal on first failure.
--
-- The checks below therefore assert three separate things rather than one: the org LABEL, the
-- PROPERTY refill actually reads before it will pin (non-empty), and an end-to-end pinned TOP-UP,
-- which is the call that stops happening. The last two are what make the first load-bearing rather
-- than cosmetic. Two more at the end cover draining and bucketing.
\set ON_ERROR_STOP on

-- 107 (github_org IS NULL) already exists from 10_scenarios.sql; 108 is the blank one. Both are
-- seeded here so the scenario stands alone if it is run on its own.
insert into public.classes(id, github_org) values
  (107, null),
  (108, '')
on conflict (id) do nothing;

-- =============================================================================================
\echo '### scenario 19: a class whose github_org is '''' resolves to the sentinel, not to '''''
-- =============================================================================================
select harness.reset();
-- p_with_args_org = false gives envelopes with no org-bearing args field, which is the shape
-- production measures at about one in seven. It is the only shape that reaches the class fallback,
-- and the class fallback is the only arm this scenario is about.
select harness.seed(108, 8, false);
select harness.seed(107, 8, false);

do $$
declare
  v_org text;
  v_first int;
  v_topup int;
  v_topup_status text;
  v_rows int;
  i int;
begin
  -- One holder claims. n = 4, max_per_org = 4, global_cap = 8. Both classes bucket together, so
  -- the sentinel has 16 ready and target = least(ceil(16/4) + 0, 4) = 4.
  insert into harness.claims(scenario, holder, org, msg_id)
  select '19 blank github_org', 's19-h1', t.org, t.msg_id
    from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's19-h1', 300, 4, 8) t
   where t.status = 'claimed';
  get diagnostics v_first = row_count;

  select distinct c.org into v_org from harness.claims c where c.scenario = '19 blank github_org';

  perform harness.expect('19 blank github_org', 'messages in the first claim', '4', v_first::text);
  -- THE FINDING. Unwrapped, this is ''.
  perform harness.expect('19 blank github_org', 'org label for a blank-github_org class',
    '(unresolved)', coalesce(v_org, '<null>'));
  -- The property orgLeaseRun.ts actually tests before it will pin. Stated separately from the label
  -- because it is what makes the label load-bearing rather than cosmetic.
  perform harness.expect('19 blank github_org', 'org is a non-empty string (refill will pin on it)',
    'true', (coalesce(v_org, '') <> '')::text);
  perform harness.expect('19 blank github_org', 'slot row carries the same non-empty org', 'true',
    (select (count(*) = 1)::text from public.async_worker_slots
      where expires_at > clock_timestamp() and holder = 's19-h1' and coalesce(org, '') <> ''));
  -- THE END-TO-END CASE: the continuous-refill top-up. This is the call that does not happen at all
  -- when the org comes back blank. Wrapped in an exception block on purpose -- with org = '' the
  -- server answers P0001 rather than a row, and a raise here would abort the script instead of
  -- recording a failed check.
  begin
    with c as (
      select t.status, t.org, t.msg_id
        from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's19-h1', 300, 4, 8, v_org) t
    ), ins as (
      insert into harness.claims(scenario, holder, org, msg_id)
      select '19 blank github_org', 's19-h1', c.org, c.msg_id from c where c.status = 'claimed'
      returning 1
    )
    select (select c2.status from c c2 limit 1), (select count(*) from ins)
      into v_topup_status, v_topup;
  exception when others then
    v_topup_status := 'RAISED ' || sqlstate || ': ' || sqlerrm;
    v_topup := 0;
  end;

  perform harness.expect('19 blank github_org', 'pinned top-up status', 'claimed',
    coalesce(v_topup_status, '<no row>'));
  perform harness.expect('19 blank github_org', 'messages in the pinned top-up', '4', v_topup::text);

  -- And the bucket still drains to empty, so an unresolvable class is slow-path at worst, never
  -- invisible. Every delivery is recorded, because the next two checks are over ALL of them: the
  -- first claim alone cannot see both classes when they are in different buckets, so asserting the
  -- one-bucket property before the drain would pass vacuously against the unwrapped resolver.
  perform pgmq_public.release_org_slot('async_calls', 's19-h1');
  for i in 1..100 loop
    insert into harness.claims(scenario, holder, org, msg_id)
    select '19 blank github_org', 's19-drain', t.org, t.msg_id
      from pgmq_public.claim_org_slot_and_read('async_calls', 300, 4, 's19-drain', 300, 4, 8) t
     where t.status = 'claimed';
    get diagnostics v_rows = row_count;
    exit when v_rows = 0;
    perform pgmq_public.release_org_slot('async_calls', 's19-drain');
  end loop;

  perform harness.expect('19 blank github_org', 'ready messages left after draining', '0',
    (select count(*)::text from pgmq.q_async_calls where vt <= clock_timestamp()));
  perform harness.expect('19 blank github_org', 'messages delivered in total', '16',
    (select count(*)::text from harness.claims c where c.scenario = '19 blank github_org'));
  -- THE NULL-github_org CLASS AND THE BLANK ONE ARE ONE BUCKET, NOT TWO. Unwrapped, 107 resolves to
  -- '(unresolved)' and 108 to '', so the same two classes draw two separate max_per_org allowances
  -- against one non-existent GitHub org -- the mirror image of the case-fold argument in decision 4.
  perform harness.expect('19 blank github_org', 'distinct org labels across both classes', '1',
    (select count(distinct c.org)::text from harness.claims c where c.scenario = '19 blank github_org'));
end $$;
