-- Per-ORG leases for the github-async-worker drain loop.
--
-- THE PROBLEM (measured on prod, 2026-09-13). One assignment release put 242 messages on
-- `async_calls` and took 30m51s to drain. The reason is not GitHub and not Postgres: it is that
-- exactly ONE leaseholder per deployment drains the queue (the Redis lease in
-- supabase/functions/_shared/workerRun.ts), and that holder reads `qty = 4` messages at a time.
-- Four in flight, fleet-wide, forever.
--
-- Meanwhile the thing that actually bounds us -- GitHub's content-creation quota -- is PER
-- ORGANIZATION. `getCreateContentLimiter` in supabase/functions/_shared/GitHubWrapper.ts keys its
-- Bottleneck on `create_content:<org>:<GITHUB_APP_ID>` with reservoir 40 / maxConcurrent 40 /
-- refresh 40 per 60s. So when three classes in three different GitHub orgs release at once, GitHub
-- is offering 120 slots of headroom and we are using 4.
--
-- WHAT THIS MIGRATION ADDS. A fixed pool of lease slots in Postgres, and one RPC that ATOMICALLY
-- (a) decides which org may take one more leaseholder, (b) claims a slot for the caller, and
-- (c) hands back that org's messages -- filtered, vt-bumped and read_ct-incremented exactly the way
-- `pgmq.read` would have done it. One round trip, no read-then-act gap, and the worker never has to
-- ask "which org should I be draining?" because Postgres already answered by giving it messages.
--
-- WHY class_id AND NOT args.org. The envelope is `{method, args, class_id, log_id, debug_id,
-- retry_count?}`. Over seven days of prod traffic `class_id` was present on 5522 of 5522 messages;
-- `args.org` on 86% of them. The missing 14% is not random -- it is every `sync_repo_permissions`
-- job. Keying the allocator on `args.org` would have silently dropped that whole method out of the
-- allocator's view, and since the read is FILTERED by the winning org, "out of the allocator's
-- view" means "never read at all". So the allocator joins `class_id` to `public.classes.github_org`
-- and everything that does not resolve lands in the `(unresolved)` sentinel bucket, which is a
-- first-class org for allocation purposes and therefore always drains. A message can be slow here;
-- it can never be invisible.
--
-- WHY THERE IS AN ADVISORY LOCK. "Do it in one statement" is necessary but NOT sufficient for this
-- allocator, and it is worth being precise about why. All the sub-statements of a single query see
-- ONE snapshot and cannot see each other's writes -- that is exactly what makes a single statement
-- safe for the message read (`FOR UPDATE SKIP LOCKED` re-checks under EvalPlanQual, so two callers
-- cannot be handed the same msg_id). But the ALLOCATION decision is an aggregate over
-- `async_worker_slots` -- "how many slots does org X already hold?" -- and two concurrent callers
-- taking their snapshots microseconds apart both count the same N, both conclude org X may have one
-- more, and then claim two DIFFERENT slot rows. `SKIP LOCKED` does not save us: it only makes them
-- avoid each other's rows, which is precisely the wrong outcome here. Per-org caps would be
-- exceeded under exactly the burst they exist to bound.
--
-- So the allocator is serialized per queue with `pg_advisory_xact_lock(1346850129, hashtext(queue))`
-- -- the two-integer lock space, which is disjoint from the single-bigint space the gradebook
-- functions use. The lock is held for the life of one RPC transaction: one aggregate (0.376 ms
-- measured on prod's queue) plus one slot UPDATE plus one bounded read of `n` rows. Callers
-- serialize, but each holds the lock for single-digit milliseconds while the WORK it then goes off
-- and does takes seconds of GitHub round trips. This is a throughput ceiling of order 10^2-10^3
-- claims/second against an offered load of a few claims/second.
--
-- BREADTH BEFORE DEPTH. The ORDER BY is `active ASC` first and unmet demand second, not the other
-- way round. That is the anti-starvation property and it is load-bearing: a class releasing 600
-- repos must not be able to take every slot while a class with 3 stragglers waits. With `active`
-- leading, every org holding work gets its FIRST slot before any org gets its second.

-- ---------------------------------------------------------------------------------------------
-- The slot pool
-- ---------------------------------------------------------------------------------------------

-- A FIXED pool. Rows are seeded here and never created at runtime: "is a slot free?" must be a
-- question about an existing row that a claimer can take a row lock on, not a question about
-- whether to INSERT, because two claimers racing to INSERT have nothing to contend on.
--
-- A slot is HELD while `expires_at > clock_timestamp()` and FREE otherwise. There is deliberately
-- no boolean: a crashed isolate cannot run a cleanup, so the only durable statement of liveness is
-- one that decays on its own. `holder` and `org` are retained after expiry purely for forensics.
create table if not exists public.async_worker_slots (
  -- The key is (queue_name, slot), so slot NUMBERS are scoped to a queue: every queue's pool runs
  -- 1..N and two queues' pools cannot collide. That is the invariant every lookup in this file
  -- relies on -- `slot` alone identifies nothing, and any query that filters or joins on it must
  -- carry `queue_name` too.
  slot int not null,
  queue_name text not null,
  org text,
  holder text,
  claimed_at timestamptz,
  -- '-infinity' rather than NULL so `expires_at > clock_timestamp()` is the ONE liveness test and
  -- never has to be spelled with an IS NULL arm that someone will forget.
  expires_at timestamptz not null default '-infinity',
  primary key (queue_name, slot)
);

comment on table public.async_worker_slots is
  'Fixed pool of per-org drain leases for the pgmq async workers, keyed (queue_name, slot) so each '
  'queue owns an independent pool numbered 1..N. A slot is held while expires_at > '
  'clock_timestamp(); holder/org survive expiry for forensics only. Claimed exclusively through '
  'pgmq_public.claim_org_slot_and_read, renewed by pgmq_public.renew_org_slot, dropped by '
  'pgmq_public.release_org_slot. Never INSERTed at runtime.';
comment on column public.async_worker_slots.org is
  'GitHub org this slot is currently draining, or the (unresolved) sentinel for messages whose '
  'class_id does not resolve to a classes.github_org.';
comment on column public.async_worker_slots.holder is
  'Opaque caller identity. A holder holds at most one slot: claim prefers re-taking the slot the '
  'caller already has, so re-claiming rotates a holder onto a new org in place rather than leaking '
  'its previous row.';

create index if not exists async_worker_slots_queue_expiry_idx
  on public.async_worker_slots (queue_name, expires_at);
create index if not exists async_worker_slots_holder_idx
  on public.async_worker_slots (holder)
  where holder is not null;

-- SIZING. There is exactly one hard requirement: a pool must be at least as large as the largest
-- `global_cap` any caller will ever pass, because a pool smaller than that silently caps the
-- configured budget and looks identical to a busy queue. `_shared/asyncWorkerTuning.ts` bounds that
-- for us -- `MAX_ORG_SLOT_GLOBAL_CAP = 8` -- and `resolveAsyncWorkerTuning` clamps the env var to
-- it, so 8 is the real ceiling today for EITHER queue. Everything above 8 is headroom, and headroom
-- is worth buying here specifically because the pool is the one part of this design that needs a
-- MIGRATION to grow: raising the chart's cap is a config change, re-seeding the pool is not.
--
-- async_calls: 64, eight doublings of headroom on the hot path. This is the queue that carries
-- assignment releases, it is the one whose cap will be raised first if per-org mode works, and 64
-- rows cost nothing -- the free-slot scan is an index lookup on the (queue_name, slot) key and the
-- active-count aggregate touches only live rows.
insert into public.async_worker_slots (queue_name, slot)
select 'async_calls', g from generate_series(1, 64) as g
on conflict (queue_name, slot) do nothing;

-- async_calls_low_priority: 16, and the smaller number is argued, not inherited.
--
-- THIS POOL IS NOT OPTIONAL. `ASYNC_QUEUE_NAMES` in github-async-worker/index.ts is
-- ["async_calls", "async_calls_low_priority"] and the worker rotates onto the second queue whenever
-- the first comes back empty. Without a pool here, `claim_org_slot_and_read('async_calls_low_
-- priority', ...)` finds no free slot and returns zero rows FOREVER -- which the worker cannot tell
-- apart from an empty queue, so repo-analytics work would stop draining the moment per-org mode was
-- enabled, with every liveness signal still green. That is precisely the failure shape
-- asyncWorkerTuning.ts exists to prevent, so this seed is load-bearing, not housekeeping.
--
-- Why 16 rather than another 64: this queue is a FALLBACK path, drained only while the main queue
-- is idle, so it can never usefully carry more leaseholders than the main queue's own ceiling --
-- the same MAX_ORG_SLOT_GLOBAL_CAP of 8. 16 is that ceiling doubled: one doubling of the constant
-- absorbed without a migration, on a path where extra concurrency buys analytics latency rather
-- than unblocking students waiting on a repo. Note also that slot numbers restart at 1 here and
-- that is now correct -- the key is (queue_name, slot), so the two pools cannot collide.
insert into public.async_worker_slots (queue_name, slot)
select 'async_calls_low_priority', g from generate_series(1, 16) as g
on conflict (queue_name, slot) do nothing;

alter table public.async_worker_slots enable row level security;

-- No policies: this is worker infrastructure with no end-user read. service_role has BYPASSRLS, and
-- it is the only role that can reach these functions at all.
revoke all on table public.async_worker_slots from anon, authenticated;
grant select, insert, update, delete on table public.async_worker_slots to service_role;

-- ---------------------------------------------------------------------------------------------
-- Claim a slot for the neediest eligible org and read that org's messages
-- ---------------------------------------------------------------------------------------------

create or replace function pgmq_public.claim_org_slot_and_read(
  queue_name text,
  sleep_seconds integer,
  n integer,
  holder text,
  lease_ttl_seconds integer,
  max_per_org integer,
  global_cap integer
)
returns table(org text, msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
language plpgsql
set search_path to ''
as $function$
declare
  -- pgmq.format_table_name is not just convenience: it is the injection guard, rejecting a
  -- queue_name containing $, ; or -- before it is ever interpolated with %I.
  v_qtable text := pgmq.format_table_name(queue_name, 'q');
  v_sql text;
begin
  if holder is null or holder = '' then
    raise exception 'claim_org_slot_and_read: holder must be a non-empty string';
  end if;
  if n is null or n < 1 then
    raise exception 'claim_org_slot_and_read: n must be >= 1 (got %)', n;
  end if;
  if sleep_seconds is null or sleep_seconds < 0 then
    raise exception 'claim_org_slot_and_read: sleep_seconds must be >= 0 (got %)', sleep_seconds;
  end if;
  if lease_ttl_seconds is null or lease_ttl_seconds < 1 then
    raise exception 'claim_org_slot_and_read: lease_ttl_seconds must be >= 1 (got %)', lease_ttl_seconds;
  end if;
  -- A zero or negative budget is a legitimate "stop claiming" instruction (a caller draining the
  -- pool down), not an error. Claim nothing and read nothing.
  if max_per_org is null or max_per_org < 1 or global_cap is null or global_cap < 1 then
    return;
  end if;

  -- FAIL LOUD ON AN UNSEEDED POOL. An empty pool and an empty queue are indistinguishable in the
  -- return value -- both are zero rows -- and that ambiguity is exactly how the missing
  -- async_calls_low_priority pool turned into "drains nothing forever while every liveness signal
  -- stays green". A queue with no pool at all is never a runtime state; it is a deployment error,
  -- and a deployment error should arrive as an exception on the first call rather than as silence.
  -- One index-only lookup on the (queue_name, slot) key, taken BEFORE the advisory lock so a
  -- misconfigured caller cannot serialize anyone else while failing.
  if not exists (select 1 from public.async_worker_slots s
                  where s.queue_name = lower(claim_org_slot_and_read.queue_name)) then
    raise exception 'claim_org_slot_and_read: no slot pool seeded for queue %, so this queue can '
                    'never drain. Seed public.async_worker_slots in a migration.',
                    lower(claim_org_slot_and_read.queue_name);
  end if;

  -- See the header: this is what makes the allocation aggregate safe against concurrent callers.
  -- 1346850129 is 0x50474D51 ('PGMQ') in the two-integer advisory lock space.
  perform pg_advisory_xact_lock(1346850129, hashtext(queue_name));

  v_sql := format($QUERY$
    with demand as (
        -- The whole allocation input, in ONE aggregate scan of the ready portion of the queue.
        -- Joining on c.id::text rather than casting the envelope to bigint is deliberate twice
        -- over: it cannot raise on a malformed class_id, and it puts the cast on `classes` (a few
        -- hundred rows) instead of on every queued message.
        select coalesce(c.github_org, '(unresolved)') as org, count(*)::int as ready
          from pgmq.%1$I q
          left join public.classes c on c.id::text = q.message->>'class_id'
         where q.vt <= clock_timestamp()
         group by 1
    ),
    live as (
        -- Slots held by SOMEONE ELSE. Excluding our own holder is what lets a caller in a
        -- claim/work/claim loop re-take its slot without being counted as its own competitor, and
        -- without the loop appearing to leak a slot per iteration.
        select s.slot, s.org
          from public.async_worker_slots s
         where s.queue_name = $5
           and s.expires_at > clock_timestamp()
           and s.holder is distinct from $1
    ),
    active as (
        select l.org, count(*)::int as active from live l group by 1
    ),
    winner as (
        select d.org
          from demand d
          left join active a on a.org = d.org
         -- global budget first; an org is only eligible if it is below its own target
         where (select count(*) from live) < $4
           and coalesce(a.active, 0) < least(ceil(d.ready::numeric / $2), $3)
         -- BREADTH BEFORE DEPTH. `active` leads; unmet demand only breaks ties among orgs that
         -- hold the same number of slots. org name last, purely for determinism.
         order by coalesce(a.active, 0) asc,
                  least(ceil(d.ready::numeric / $2), $3) - coalesce(a.active, 0) desc,
                  d.org asc
         limit 1
    ),
    free_slot as (
        -- queue_name travels with slot from here all the way into `claimed`: the key is
        -- (queue_name, slot) and slot 7 exists once per queue, so a join on slot alone would claim
        -- a row belonging to a different queue's pool.
        select s.queue_name, s.slot
          from public.async_worker_slots s
         where s.queue_name = $5
           and (s.expires_at <= clock_timestamp() or s.holder = $1)
           and exists (select 1 from winner)
         -- Prefer the slot we already hold, so a repeat caller overwrites its own row instead of
         -- taking a second one. `IS NOT DISTINCT FROM` rather than `=` because DESC sorts NULLs
         -- FIRST, which would otherwise rank an unheld slot above our own.
         order by (s.holder is not distinct from $1) desc, s.slot asc
         limit 1
         for update of s skip locked
    ),
    claimed as (
        update public.async_worker_slots s
           set org        = (select w.org from winner w),
               holder     = $1,
               claimed_at = clock_timestamp(),
               expires_at = clock_timestamp() + %2$L::interval
          from free_slot f
         where s.queue_name = f.queue_name
           and s.slot = f.slot
        returning s.org
    ),
    picked as (
        -- pgmq.read's CTE, with one extra predicate. Same ORDER BY msg_id, same LIMIT, same
        -- FOR UPDATE SKIP LOCKED -- but `OF q`, never bare, because the join to classes would
        -- otherwise make Postgres try to lock the nullable side of an outer join.
        --
        -- If `claimed` produced no row the scalar subquery is NULL, the equality is NULL for every
        -- row, and nothing is picked. That is the "no org qualified / no slot free" path: zero
        -- rows out, nothing claimed.
        select q.msg_id
          from pgmq.%3$I q
          left join public.classes c on c.id::text = q.message->>'class_id'
         where q.vt <= clock_timestamp()
           and coalesce(c.github_org, '(unresolved)') = (select k.org from claimed k)
         order by q.msg_id asc
         limit $2
         for update of q skip locked
    ),
    drained as (
        update pgmq.%4$I m
           set vt = clock_timestamp() + %5$L::interval,
               read_ct = m.read_ct + 1
          from picked p
         where m.msg_id = p.msg_id
        returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
    )
    select (select k.org from claimed k), d.msg_id, d.read_ct, d.enqueued_at, d.vt, d.message
      from drained d
  $QUERY$,
    v_qtable,
    make_interval(secs => lease_ttl_seconds),
    v_qtable,
    v_qtable,
    make_interval(secs => sleep_seconds)
  );

  -- lower(queue_name) for the slot lookup, because pgmq.format_table_name lowercases and pgmq.create
  -- lowercases, so 'Async_Calls' would find the queue TABLE but match no slot rows -- which would
  -- look exactly like "the pool is exhausted" and silently claim nothing forever.
  return query execute v_sql using holder, n, max_per_org, global_cap, lower(queue_name);
end;
$function$;

comment on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer) is
  'Atomically claim one drain lease for the neediest eligible GitHub org on `queue_name` and return '
  'up to n of that org''s ready messages, with vt and read_ct updated exactly as pgmq.read would. '
  'target(org) = least(ceil(ready/n), max_per_org); orgs are ordered by slots-held ascending FIRST '
  '(breadth before depth) then by unmet demand descending; global_cap bounds the whole queue. '
  'Messages whose class_id does not resolve to a classes.github_org are bucketed under the '
  '(unresolved) sentinel so they still drain. Returns zero rows and claims nothing when no org '
  'qualifies or no slot is free. Serialized per queue by an advisory transaction lock.';

-- ---------------------------------------------------------------------------------------------
-- Lease maintenance
-- ---------------------------------------------------------------------------------------------

-- SIGNATURE CHANGE, 2026-09-13, and it is deliberate -- see the note below on why this belongs in
-- SQL rather than in the worker. Both functions now take `queue_name` FIRST, matching
-- claim_org_slot_and_read. The old queue-free forms are dropped rather than kept as overloads,
-- because leaving them reachable through PostgREST leaves the trap reachable.
drop function if exists pgmq_public.renew_org_slot(text, integer);
drop function if exists pgmq_public.release_org_slot(text);

-- WHY THESE ARE SCOPED BY (queue_name, holder) AND NOT BY holder ALONE.
--
-- The worker drains two queues -- `ASYNC_QUEUE_NAMES = ["async_calls", "async_calls_low_priority"]`
-- -- rotating to the low-priority one whenever the main queue comes back empty. Pools are keyed
-- (queue_name, slot), so one holder rotating between queues legitimately ends up holding one slot
-- in EACH pool. That part is fine and expected.
--
-- What is not fine is what a holder-scoped renew then does to the abandoned one. `renew(holder)`
-- would extend EVERY live lease bearing that name, so the slot the worker rotated AWAY from gets
-- its TTL pushed forward on every heartbeat, forever. It becomes a phantom leaseholder: it consumes
-- a `global_cap` slot it will never use and, because the allocator counts it in `active`, it pins
-- that org below its target for as long as the worker lives. Nothing decays, nothing alerts, and
-- the queue just runs slower than its configuration says it should.
--
-- Releasing before rotating -- fixing it in the caller -- is worth doing, but it CANNOT be the only
-- mechanism, and the difference is not stylistic. Under holder scoping a forgotten release is
-- UNBOUNDED, because renew actively resurrects the phantom on every heartbeat. Under queue scoping
-- the same forgotten release costs exactly one TTL, which is the identical bound the design already
-- accepts for an isolate that crashes without releasing. So queue scoping turns a correctness
-- requirement on the caller into a latency optimisation, which is the right place for that line:
-- the invariant lives with the table that stores it, and a rule the caller has to remember is the
-- same class of thing that produced this bug and the (queue_name, slot) one before it.

create or replace function pgmq_public.renew_org_slot(queue_name text, holder text, lease_ttl_seconds integer)
returns boolean
language plpgsql
set search_path to ''
as $function$
declare
  v_rows integer;
begin
  if queue_name is null or queue_name = ''
     or holder is null or holder = ''
     or lease_ttl_seconds is null or lease_ttl_seconds < 1 then
    return false;
  end if;

  -- Three conditions now, and each rules out a different way of being wrong:
  --   queue_name  -- do not touch the lease this holder has in another queue's pool (above).
  --   holder      -- do not touch a slot someone else has since taken.
  --   expires_at  -- `s.holder = holder` alone would let a caller whose lease had ALREADY expired --
  --                  and whose slot had been re-claimed and then released by someone else, leaving
  --                  our name on it -- resurrect a lease it no longer owns, so two isolates would
  --                  believe they held the same slot. Same bug the Redis lease had (RENEW_IF_OWNED
  --                  in _shared/workerRun.ts): EXISTS is not OWNERSHIP. A holder that lets its lease
  --                  lapse must go back through claim.
  update public.async_worker_slots s
     set expires_at = clock_timestamp() + make_interval(secs => lease_ttl_seconds)
   where s.queue_name = lower(renew_org_slot.queue_name)
     and s.holder = renew_org_slot.holder
     and s.expires_at > clock_timestamp();

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;

comment on function pgmq_public.renew_org_slot(text, text, integer) is
  'Extend this holder''s lease on queue_name by lease_ttl_seconds. Scoped by (queue_name, holder): '
  'renewing one queue''s lease never extends the lease the same holder has in another queue''s pool, '
  'so a worker that rotates between queues cannot keep a phantom leaseholder alive. Returns false -- '
  'and changes nothing -- if the holder holds no CURRENTLY LIVE slot in that queue, so a lapsed '
  'holder cannot resurrect a lease another isolate may already have taken.';

create or replace function pgmq_public.release_org_slot(queue_name text, holder text)
returns void
language plpgsql
set search_path to ''
as $function$
begin
  if queue_name is null or queue_name = '' or holder is null or holder = '' then
    return;
  end if;

  -- Clears every row in THIS queue's pool bearing this holder, not just the live one, so a holder
  -- that somehow ended up on two rows in one pool cleans both up. Scoped by holder as well, so a
  -- slot already re-claimed by someone else (their name is on it now) is untouched -- releasing a
  -- lease you lost must be a no-op, not a revocation of theirs.
  update public.async_worker_slots s
     set org = null,
         holder = null,
         claimed_at = null,
         expires_at = '-infinity'
   where s.queue_name = lower(release_org_slot.queue_name)
     and s.holder = release_org_slot.holder;
end;
$function$;

comment on function pgmq_public.release_org_slot(text, text) is
  'Drop this holder''s lease on queue_name immediately. Scoped by (queue_name, holder), so releasing '
  'one queue''s lease leaves the same holder''s lease in another queue''s pool alone. Best effort: '
  'lease expiry is the real safety net, since a crashed isolate never gets to call this. A no-op if '
  'the slot has already been taken by another holder.';

-- ---------------------------------------------------------------------------------------------
-- Grants: house style -- nothing for the browser roles, everything for service_role.
-- ---------------------------------------------------------------------------------------------

revoke all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function pgmq_public.renew_org_slot(text, text, integer) from public, anon, authenticated;
revoke all on function pgmq_public.release_org_slot(text, text) from public, anon, authenticated;

grant all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer)
  to "service_role";
grant all on function pgmq_public.renew_org_slot(text, text, integer) to "service_role";
grant all on function pgmq_public.release_org_slot(text, text) to "service_role";
