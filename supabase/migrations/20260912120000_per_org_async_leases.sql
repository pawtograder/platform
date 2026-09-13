-- Per-ORG leases for the github-async-worker drain loop.
--
-- THE PROBLEM (measured on prod, 2026-09-13). One assignment release put 242 messages on
-- `async_calls` and took 30m51s to drain. The reason is not GitHub and not Postgres: it is that
-- exactly ONE leaseholder per deployment drains the queue (the Redis lease in
-- supabase/functions/_shared/workerRun.ts), and that holder reads `qty = 4` messages at a time.
-- Four in flight, fleet-wide, forever.
--
-- Meanwhile the thing that actually bounds us is PER ORGANIZATION. `getCreateContentLimiter` in
-- supabase/functions/_shared/GitHubWrapper.ts keys its Bottleneck on
-- `create_content:<org>:<GITHUB_APP_ID>` with reservoir 40 / maxConcurrent 40 / refresh 40 per 60s.
-- When three classes in three different GitHub orgs release at once, that quota allows 120
-- concurrent content calls and we use 4.
--
-- WHAT THIS MIGRATION ADDS. A fixed pool of lease slots in Postgres, and one RPC that atomically
-- decides which org may take one more leaseholder, claims a slot for the caller, and hands back that
-- org's messages, filtered and vt-bumped and read_ct-incremented exactly the way `pgmq.read` would
-- have done it. One round trip and no read-then-act gap. The worker never has to ask which org it
-- should be draining, because Postgres answered by giving it that org's messages.
--
-- HOW A MESSAGE IS ATTRIBUTED TO AN ORG. The envelope is `{method, args, class_id, log_id,
-- debug_id, retry_count?}`. Over seven days of prod traffic `class_id` was present on 5522 of 5522
-- messages and `args.org` on 86% of them, and the missing 14% is not random: it is every
-- `sync_repo_permissions` job. So the key is `args.org` where the envelope carries one, falling
-- back to `class_id` joined to `public.classes.github_org`, lowercased on both sides because GitHub
-- org names are case-insensitive and share one rate-limit bucket across spellings. Keying on
-- `args.org` alone would drop that whole method out of the allocator's view, and since the read is
-- FILTERED by the winning org, out of the allocator's view means never read at all. Anything that
-- resolves to neither lands in the `(unresolved)` sentinel bucket, which competes for slots like
-- any other org and therefore always drains. Work can be slow there. It can never be invisible.
--
-- WHY THERE IS AN ADVISORY LOCK. "Do it in one statement" is necessary but not sufficient here, and
-- the reason is worth stating precisely. All the sub-statements of a single query see one snapshot
-- and cannot see each other's writes, which is exactly what makes a single statement safe for the
-- message read: `FOR UPDATE SKIP LOCKED` re-checks under EvalPlanQual, so two callers cannot be
-- handed the same msg_id. The ALLOCATION decision is different. It is an aggregate over
-- `async_worker_slots` asking how many slots an org already holds, and two concurrent callers
-- taking their snapshots microseconds apart both count the same N, both conclude the org may have
-- one more, and then claim two different slot rows. `SKIP LOCKED` does not help. It only makes them
-- avoid each other's rows, which is the wrong outcome: the caps would be exceeded under exactly the
-- burst they exist to bound.
--
-- So the allocator runs under `pg_advisory_xact_lock(1346850129, 0)`, one global key rather than one
-- per queue, because the budgets are counted across every pool and so the protected state spans
-- queues. The lock is held for the life of one RPC transaction: one aggregate (0.376 ms measured on
-- prod's queue), one slot UPDATE, one bounded read of `n` rows. Callers serialize, but each holds
-- the lock for single-digit milliseconds while the work it then goes off and does takes seconds of
-- GitHub round trips. That is a throughput ceiling of order 10^2 to 10^3 claims per second against
-- an offered load of a few per second.
--
-- POOLS ARE PER QUEUE, BUDGETS ARE NOT. Slot rows are keyed (queue_name, slot) so each queue owns
-- an independent pool, but `global_cap` and `max_per_org` are counted over every live slot in every
-- pool. An isolate draining `async_calls_low_priority` occupies one of the edge tier's
-- `maxParallelism` admission slots and spends its org's GitHub quota exactly as one draining
-- `async_calls` does, so a budget counted per pool would admit a full `global_cap` per queue and
-- defeat both bounds.
--
-- BREADTH BEFORE DEPTH. The ORDER BY puts slots-already-held first and unmet demand second, not the
-- other way round. That is the anti-starvation property, and the whole feature depends on it: a
-- class releasing 600 repos must not take every slot while a class with 3 stragglers waits. With
-- slots-held leading, every org with work gets its first slot before any org gets its second.

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
-- asyncWorkerTuning.ts exists to prevent, so this seed is required for correctness rather than
-- housekeeping.
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

-- The return type gains a `status` column, so the old function has to go rather than be replaced.
drop function if exists pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer);

create or replace function pgmq_public.claim_org_slot_and_read(
  queue_name text,
  sleep_seconds integer,
  n integer,
  holder text,
  lease_ttl_seconds integer,
  max_per_org integer,
  global_cap integer
)
returns table(status text, org text, msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
language plpgsql
set search_path to ''
as $function$
declare
  -- pgmq.format_table_name is not just convenience. It is the injection guard, rejecting a
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

  -- A zero or negative budget is a legitimate "stop claiming" instruction, not an error, so report
  -- it as lack of capacity rather than raising.
  if max_per_org is null or max_per_org < 1 or global_cap is null or global_cap < 1 then
    return query select 'no_capacity'::text, null::text, null::bigint, null::integer,
                        null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  -- FAIL LOUD ON AN UNSEEDED POOL. An empty pool and an empty queue used to produce the same answer,
  -- and that ambiguity is how the missing async_calls_low_priority pool became "drains nothing while
  -- every liveness signal stays green". A queue with no pool at all is a deployment error rather
  -- than a runtime state, so it arrives as an exception on the first call. One index-only lookup on
  -- the (queue_name, slot) key, taken before the advisory lock so a misconfigured caller cannot
  -- serialize anyone else while it fails.
  if not exists (select 1 from public.async_worker_slots s
                  where s.queue_name = lower(claim_org_slot_and_read.queue_name)) then
    raise exception 'claim_org_slot_and_read: no slot pool seeded for queue %, so this queue can '
                    'never drain. Seed public.async_worker_slots in a migration.',
                    lower(claim_org_slot_and_read.queue_name);
  end if;

  -- ONE GLOBAL LOCK, NOT ONE PER QUEUE, and the difference affects correctness rather than style.
  -- The budgets this function enforces are counted across every pool (see `live` below), so the
  -- state the lock protects spans queues and the lock has to span them too. A per-queue key would
  -- let an allocator on async_calls and one on async_calls_low_priority read the same slot counts
  -- at the same instant and both admit a leaseholder, which is precisely the read-then-act race the
  -- lock exists to close. Keying on the queue name also made the lock sensitive to the caller's
  -- capitalization, so 'Async_Calls' and 'async_calls' serialized separately against one pool.
  -- 1346850129 is 0x50474D51 ('PGMQ') in the two-integer advisory lock space, which is disjoint
  -- from the single-bigint space the gradebook functions use.
  perform pg_advisory_xact_lock(1346850129, 0);

  v_sql := format($QUERY$
    with ready as (
        -- The partition key, defined ONCE. Everything downstream reads it from here rather than
        -- recomputing it, because `demand` and `picked` disagreeing about which org a message
        -- belongs to would mean claiming a slot for one org and then reading another org's work.
        --
        -- THREE decisions are packed into this expression:
        --
        -- 1. args.org FIRST. The handler calls GitHub against the org baked into the envelope, not
        --    against whatever classes.github_org says today. If an instructor repoints a class at a
        --    new org while envelopes are queued, attributing that in-flight work to the new org
        --    charges the budget to an org no handler is going to call.
        -- 2. classes.github_org as the FALLBACK, and it carries real traffic. args.org is missing
        --    from about one envelope in seven (see the header for the measurement), and those are
        --    not a random seventh: they are every sync_repo_permissions job. Note that a literal
        --    percent sign cannot appear anywhere in this string, because the whole block is a
        --    format() template. Joining on c.id::text rather than casting the
        --    envelope to bigint cannot raise on a malformed class_id, and it puts the cast on
        --    `classes` (a few hundred rows) instead of on every queued message.
        -- 3. lower() over the whole thing. GitHub org names are case-insensitive and one class in
        --    prod already stores a mixed-case github_org, so 'Khoury-CS' and 'khoury-cs' are one
        --    org sharing one rate-limit bucket. Without the fold they would each draw a full
        --    max_per_org allowance against that single bucket.
        select q.msg_id,
               lower(coalesce(
                 nullif(q.message->'args'->>'org', ''),
                 c.github_org,
                 '(unresolved)')) as org
          from pgmq.%1$I q
          left join public.classes c on c.id::text = q.message->>'class_id'
         where q.vt <= clock_timestamp()
    ),
    demand as (
        select r.org, count(*)::int as ready from ready r group by 1
    ),
    live as (
        -- EVERY POOL, not just this queue's. Slot ROWS belong to a queue; the BUDGETS do not.
        -- global_cap bounds resident isolates against the edge tier's maxParallelism of 8, and
        -- max_per_org bounds concurrent handlers against one org's GitHub content quota. An isolate
        -- draining async_calls_low_priority occupies an admission slot and spends that org's GitHub
        -- quota exactly as one draining async_calls does. Counting per pool let each queue admit a
        -- full global_cap independently, so both bounds this feature exists to respect could be
        -- exceeded by a factor of the number of queues.
        select s.org, s.holder
          from public.async_worker_slots s
         where s.expires_at > clock_timestamp()
    ),
    active as (
        -- a_others excludes us, so a caller looping claim/work/claim is not counted as its own
        -- competitor. a_all includes us, because the target below needs the work already in flight.
        select l.org,
               count(*) filter (where l.holder is distinct from $1)::int as a_others,
               count(*)::int as a_all
          from live l group by 1
    ),
    winner as (
        select d.org
          from demand d
          left join active a on a.org = d.org
         where (select count(*) from live l2 where l2.holder is distinct from $1) < $4
           -- target = ceil(ready/n) + slots already held, capped at max_per_org.
           --
           -- The `+ a_all` term is what stops an org being throttled by its own progress. `ready`
           -- counts only visible messages, so each claim hides n of them: an org with 8 ready and
           -- max_per_org 2 would see ready fall to 4 after its first claim, compute a target of 1,
           -- and refuse the second slot it is entitled to. Adding back the n messages each active
           -- slot is already working on makes the target a statement about the org's whole backlog
           -- rather than about the part nobody has picked up yet. Bursts of 5 to 8, and the tail of
           -- every larger burst, ran at half their configured allowance without it.
           and coalesce(a.a_others, 0) < least(ceil(d.ready::numeric / $2) + coalesce(a.a_all, 0), $3)
         -- BREADTH BEFORE DEPTH. Slots held leads; unmet demand only breaks ties among orgs holding
         -- the same number. Org name last, purely for determinism.
         order by coalesce(a.a_others, 0) asc,
                  least(ceil(d.ready::numeric / $2) + coalesce(a.a_all, 0), $3) - coalesce(a.a_others, 0) desc,
                  d.org asc
         limit 1
    ),
    free_slot as (
        -- Within THIS queue's pool. queue_name is carried through to `claimed` because the key is
        -- (queue_name, slot) and slot 7 exists once per queue, so joining on slot alone would claim
        -- a row out of a different pool.
        select s.queue_name, s.slot
          from public.async_worker_slots s
         where s.queue_name = $5
           and (s.expires_at <= clock_timestamp() or s.holder = $1)
           and exists (select 1 from winner)
         -- Prefer the slot we already hold, so a repeat caller overwrites its own row instead of
         -- taking a second one. `IS NOT DISTINCT FROM` rather than `=` because DESC sorts NULLs
         -- first, which would otherwise rank an unheld slot above our own.
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
        -- pgmq.read's CTE with one extra predicate. Same ORDER BY msg_id, same LIMIT, same
        -- FOR UPDATE SKIP LOCKED, but `OF q` rather than bare: the semijoin below means the org
        -- expression is evaluated once in `ready` instead of again here, and locking is restricted
        -- to the queue table either way.
        --
        -- If `claimed` produced no row the scalar subquery is NULL, every comparison is NULL, and
        -- nothing is picked. That is the "no org qualified or no slot free" path, and it claims
        -- nothing.
        select q.msg_id
          from pgmq.%3$I q
         where q.vt <= clock_timestamp()
           and q.msg_id in (select r.msg_id from ready r
                             where r.org = (select k.org from claimed k))
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
    select 'claimed'::text, (select k.org from claimed k),
           d.msg_id, d.read_ct, d.enqueued_at, d.vt, d.message
      from drained d
    union all
    -- Zero message rows is two different answers and the caller has to tell them apart. An empty
    -- `demand` means the queue has no visible work, so the worker should move on to the next queue
    -- in its priority order. A non-empty `demand` means work is waiting and this caller has no room
    -- for it, so moving on would leave urgent repo work backlogged while the worker drains
    -- analytics. `demand` is already computed, so this costs nothing.
    select case when exists (select 1 from demand) then 'no_capacity' else 'no_demand' end,
           null::text, null::bigint, null::integer, null::timestamptz, null::timestamptz, null::jsonb
     where not exists (select 1 from drained)
  $QUERY$,
    v_qtable,
    make_interval(secs => lease_ttl_seconds),
    v_qtable,
    v_qtable,
    make_interval(secs => sleep_seconds)
  );

  -- lower(queue_name) for the slot lookup, because pgmq.format_table_name and pgmq.create both
  -- lowercase. 'Async_Calls' would otherwise find the queue TABLE but match no slot rows, which
  -- looks exactly like an exhausted pool and would claim nothing forever.
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
  'qualifies or no slot is free, exactly one row is returned with status no_demand (the queue has '
  'no visible work) or no_capacity (work is waiting but the caps are full), so a caller can tell '
  'the two apart before moving to a lower-priority queue. Serialized by one global advisory '
  'transaction lock, because the caps are counted across every queue''s pool.';

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
-- its TTL pushed forward on every heartbeat, forever. The result is an abandoned lease that never
-- expires: it occupies a `global_cap` slot nobody will use and, because the allocator counts it,
-- holds that org below its target for as long as the worker lives. Nothing expires it and nothing
-- alerts on it. The queue simply runs slower than its configuration says it should.
--
-- Releasing before rotating -- fixing it in the caller -- is worth doing, but it CANNOT be the only
-- mechanism, and the difference is not stylistic. Under holder scoping a forgotten release is
-- UNBOUNDED, because renew revives the abandoned lease on every heartbeat. Under queue scoping
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
  'so a worker that rotates between queues cannot keep an abandoned lease alive. Returns false, and '
  'changes nothing, if the holder holds no CURRENTLY LIVE slot in that queue, so a lapsed holder '
  'cannot resurrect a lease another isolate may already have taken.';

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
