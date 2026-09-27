-- Assertion plumbing and the slot audit trigger for the per-org async lease harness.
--
-- Applied AFTER supabase/migrations/20260912120000_per_org_async_leases.sql, because the audit
-- trigger hangs off public.async_worker_slots, which that migration creates.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------------
-- Assertion plumbing
-- ---------------------------------------------------------------------------------------------
drop schema if exists harness cascade;
create schema harness;

create table harness.results (
  seq        bigserial primary key,
  scenario   text not null,
  check_name text not null,
  expected   text,
  actual     text,
  ok         boolean not null
);

-- Records a check rather than raising, so one failure does not hide the other eight scenarios.
-- run.sh turns a non-empty set of ok = false rows into a non-zero exit.
create or replace function harness.expect(p_scenario text, p_check text, p_expected text, p_actual text)
returns void language plpgsql as $$
begin
  insert into harness.results(scenario, check_name, expected, actual, ok)
  values (p_scenario, p_check, p_expected, p_actual, p_expected is not distinct from p_actual);
end $$;

-- An observation with no pass/fail attached (timings, counts we want in the report).
create or replace function harness.note(p_scenario text, p_check text, p_value text)
returns void language plpgsql as $$
begin
  insert into harness.results(scenario, check_name, expected, actual, ok)
  values (p_scenario, p_check, '(informational)', p_value, true);
end $$;

-- Every message any caller was ever handed, across every scenario. The duplicate-delivery check is
-- a GROUP BY over this table.
create table harness.claims (
  id       bigserial primary key,
  scenario text not null,
  holder   text not null,
  org      text,
  msg_id   bigint not null,
  at       timestamptz not null default clock_timestamp()
);

-- Back to a clean slate between scenarios: empty queue, no leases, no recorded deliveries.
-- Clears EVERY queue's pool, not just p_queue's, so a scenario can never inherit a live lease from
-- the previous one by way of a second pool. It also clears harness.claims, which the comment always
-- promised and the body did not do: several scenarios assert absolute delivery counts, so leaving
-- rows behind made 10_scenarios.sql fail on a second run unless 05_harness.sql was reapplied first.
create or replace function harness.reset(p_queue text default 'async_calls')
returns void language plpgsql as $$
begin
  perform pgmq.purge_queue(p_queue);
  update public.async_worker_slots
     set org = null, holder = null, claimed_at = null, expires_at = '-infinity';
  delete from harness.slot_log;
  delete from harness.claims;
end $$;

-- Enqueue p_count envelopes shaped like the real ones: class_id always present, args.org only
-- sometimes (the 86% figure from prod), because the allocator must not be reading args.org.
create or replace function harness.seed(p_class_id bigint, p_count int, p_with_args_org boolean default true,
                                       p_queue text default 'async_calls')
returns void language plpgsql as $$
begin
  perform pgmq.send_batch(p_queue, (
    select array_agg(
      jsonb_build_object(
        'method', case when p_with_args_org then 'create_repo' else 'sync_repo_permissions' end,
        'class_id', p_class_id,
        'log_id', g,
        'debug_id', 'harness',
        'args', case when p_with_args_org
                     then jsonb_build_object('org', (select c.github_org from public.classes c where c.id = p_class_id))
                     else jsonb_build_object('repo', 'x/y') end))
    from generate_series(1, p_count) g));
end $$;

-- One envelope with an arbitrary body, for the "does not resolve to an org" cases.
create or replace function harness.seed_raw(p_body jsonb, p_queue text default 'async_calls')
returns void language plpgsql as $$
begin
  perform pgmq.send(p_queue, p_body);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Slot audit: how the concurrency scenario proves "no slot double-claimed"
-- ---------------------------------------------------------------------------------------------
--
-- The slot table's primary key already makes "two rows for slot 7" impossible. The interesting
-- failure is different and invisible to a snapshot taken afterwards: one caller OVERWRITING a lease
-- that was still LIVE and belonged to someone else. That is a transient state -- by the time the
-- storm finishes both leases have expired and the table looks fine -- so it has to be caught at the
-- moment of the write, which is what this trigger is for.
create table harness.slot_log (
  id             bigserial primary key,
  at             timestamptz not null default clock_timestamp(),
  -- queue_name, not just slot: pools are keyed (queue_name, slot) and slot 7 exists once per queue,
  -- so "how many distinct slots were used?" is a question about the PAIR.
  queue_name     text not null,
  slot           int not null,
  old_holder     text,
  old_expires    timestamptz,
  new_holder     text,
  new_expires    timestamptz,
  live_after     int not null,
  live_org_after int not null,
  stolen         boolean not null
);

create or replace function harness.slot_audit() returns trigger language plpgsql as $$
declare
  v_live int;
  v_live_org int;
begin
  select count(*) filter (where true),
         count(*) filter (where s.org is not distinct from new.org)
    into v_live, v_live_org
    from public.async_worker_slots s
   where s.queue_name = new.queue_name
     and s.expires_at > clock_timestamp();

  insert into harness.slot_log(queue_name, slot, old_holder, old_expires, new_holder, new_expires,
                               live_after, live_org_after, stolen)
  values (new.queue_name, new.slot, old.holder, old.expires_at, new.holder, new.expires_at,
          v_live, v_live_org,
          -- A steal: the row was a live lease belonging to someone else, and the write turned it
          -- into a live lease belonging to us. Releases (new.expires_at = '-infinity') and renewals
          -- (same holder) are not steals.
          old.expires_at > clock_timestamp()
            and old.holder is distinct from new.holder
            and new.expires_at > clock_timestamp());
  return null;
end $$;

create trigger harness_slot_audit
  after update on public.async_worker_slots
  for each row execute function harness.slot_audit();
