-- Let a leaseholder ask to STAY on the org it is already draining.
--
-- WHAT CHANGED UPSTREAM. _shared/orgLeaseRun.ts now refills continuously: rather than claiming n
-- messages, running all of them to completion and claiming again, it keeps n in flight and tops up
-- the shortfall as each one settles. Simulated against production's duration distribution that
-- lifts per-leaseholder utilization from 69.5 percent to 99.1 percent.
--
-- WHAT THAT BROKE, AND IT IS IN THIS FILE RATHER THAN THAT ONE. claim_org_slot_and_read re-picks
-- the neediest org on every call and re-points the caller's slot row at whatever it picked. Under
-- batch-and-wait that was safe by construction: a rotation could only land BETWEEN batches, when
-- the holder had nothing running. Under refill a top-up can come back with a different org while up
-- to n-1 messages of the previous org are still executing. The slot table then attributes the
-- holder to the new org, and the old org's stragglers become concurrency the allocator no longer
-- counts against it. Its effective in-flight can reach max_per_org * n + (n - 1), which is 11 at
-- the shipped values rather than 8.
--
-- The overrun is small, it is bounded by one message's duration, and it cannot happen during a
-- single-org burst because there is nothing to rotate to. It is still the same defect class this
-- design has already been corrected for twice, and "the per-org cap holds" is the entire premise of
-- the feature, so it is worth a migration rather than a tag.
--
-- THE FIX IS ONE OPTIONAL ARGUMENT. pin_org restricts the allocator to a single org instead of
-- letting it re-pick. The caller pins while it has that org's work in flight and stops pinning once
-- its stream has drained, so a rotation can once again only happen when nothing is running. With
-- pin_org NULL the function behaves exactly as before, which is what keeps every existing caller and
-- PostgREST's argument-set resolution working.
--
-- WHY THE OLD SIGNATURE IS DROPPED RATHER THAN LEFT ALONGSIDE. Adding a defaulted argument creates a
-- second function rather than replacing the first, and a seven-argument call would then match both
-- and fail with "function is not unique". There has to be exactly one.
--
-- HOW PINNING INTERACTS WITH THE OWN-ROW REUSE, since that was the last thing fixed here. The
-- blocking FOR UPDATE that resolves the caller's existing row is keyed on (queue_name, holder) and
-- knows nothing about orgs, so it runs unchanged and still finds the row the pinned caller already
-- holds. free_slot is then restricted to that one slot. A pinned top-up therefore REUSES its own row
-- and never competes for a second one, which is what it should do: it is refilling capacity it
-- already has rather than acquiring more.
--
-- AND WHY A PINNED TOP-UP IS NOT SENSITIVE TO n, which is worth stating because the refill driver
-- passes the SHORTFALL as n rather than the leaseholder's configured concurrency. The target is
-- least(ceil(ready / n) + a_all, max_per_org), so a smaller n inflates ceil(ready / n) and the
-- ceil term stops throttling; max_per_org becomes the only binding constraint. For a caller that
-- ALREADY HOLDS A SLOT on the org it is pinning, that does not matter at all, because such a caller
-- is admitted regardless of n:
--
--   a_all counts live slots for the org INCLUDING this holder, a_others EXCLUDES it, so
--   a_others = a_all - 1. Admission needs a_others < target. Either the cap binds, and
--   target = max_per_org >= a_all > a_all - 1 = a_others; or it does not, and
--   target = ceil(ready / n) + a_all >= 1 + a_all > a_others. Both hold for every n >= 1.
--
-- So the n sensitivity applies only to NEW admissions, which under refill are the unpinned calls the
-- driver makes when nothing is in flight, and those pass the full concurrency. It is still a real
-- edge for any future caller that claims fresh capacity with a small n: max_per_org and global_cap
-- are unaffected and breadth-first ordering is unaffected, but ceil(ready / n) stops keeping an org
-- with two ready messages from occupying several slots. Pass the leaseholder's concurrency as n on
-- an unpinned claim.

drop function if exists pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer);

create or replace function pgmq_public.claim_org_slot_and_read(
  queue_name text,
  sleep_seconds integer,
  n integer,
  holder text,
  lease_ttl_seconds integer,
  max_per_org integer,
  global_cap integer,
  pin_org text default null
)
returns table(status text, org text, msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
language plpgsql
set search_path to ''
as $function$
declare
  -- pgmq.format_table_name is not just convenience. It is the injection guard, rejecting a
  -- queue_name containing $, ; or -- before it is ever interpolated with %I.
  v_qtable text := pgmq.format_table_name(queue_name, 'q');
  -- lower() because pgmq.format_table_name and pgmq.create both lowercase. 'Async_Calls' would
  -- otherwise find the queue TABLE but match no slot rows, which looks exactly like an exhausted
  -- pool and would claim nothing forever.
  v_queue text := lower(queue_name);
  v_own_slot int;
  v_own_count int;
  -- Folded through the SAME lower() the partition key uses. A caller pins with the org string a
  -- previous claim handed it, and that string is already folded, but a caller that assembles one
  -- from classes.github_org or from an envelope would otherwise fail to match its own org and read
  -- back 'no_demand' forever.
  v_pin text := lower(pin_org);
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
  -- Empty string is a caller error rather than a way to spell "no pin", which is what the NULL
  -- default is for. Rejecting it matches how holder = '' is treated: a malformed argument arrives
  -- as an exception the worker reports, not as a silent change of behaviour.
  if pin_org is not null and pin_org = '' then
    raise exception 'claim_org_slot_and_read: pin_org must be a non-empty org, or null for no pin';
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
  if not exists (select 1 from public.async_worker_slots s where s.queue_name = v_queue) then
    raise exception 'claim_org_slot_and_read: no slot pool seeded for queue %, so this queue can '
                    'never drain. Seed public.async_worker_slots in a migration.', v_queue;
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

  -- TAKE OUR OWN ROW FIRST, AND TAKE IT BLOCKING.
  --
  -- The allocator used to express "reuse the slot I already hold" as an ORDER BY preference inside
  -- the claim statement, under FOR UPDATE SKIP LOCKED. That is not an invariant, it is a hint, and
  -- SKIP LOCKED discards it precisely when it matters: if the caller's own renewal timer holds the
  -- row lock at that instant, the preferred row is skipped and the claim takes a DIFFERENT free row
  -- instead. The holder then owns two rows in one pool, renew_org_slot refreshes both forever
  -- (it matches on queue and holder, not on slot), and the extra one occupies global_cap and
  -- max_per_org while no isolate is doing its work. The global advisory lock does not help, because
  -- it serializes allocators against each other and renew_org_slot never takes it.
  --
  -- So the caller's own row is resolved in its own statement, with a plain blocking FOR UPDATE, and
  -- the claim below is then restricted to that one row. A row already locked by the CURRENT
  -- transaction is not skipped by SKIP LOCKED, so the reuse becomes unconditional.
  --
  -- WHY THIS CANNOT DEADLOCK, now that two lock types are in play:
  --
  --   * Allocator against allocator is impossible. Every allocator takes the global advisory lock
  --     before any row lock and holds it until commit, so only one is ever inside this section.
  --   * Allocator against renew or release. This statement only ever waits on rows bearing its OWN
  --     holder. renew_org_slot and release_org_slot select rows by (queue_name, holder) and take no
  --     other lock of any kind, so once either of them is running it cannot wait on anything and
  --     cannot be the second edge of a cycle. Only a renew or release for THIS SAME holder can
  --     contend at all, and the wait is on one row of one single-row UPDATE.
  --   * Ordering. Our own row is locked BEFORE any free row. The reverse order would be the risky
  --     one, because then we could hold a free row while waiting for our own.
  --
  -- The cost is that a blocking wait happens while the global advisory lock is held, so a slow
  -- blocker stalls every allocator. The blocker is one single-row UPDATE with no further locks to
  -- acquire, so the wait is bounded by that statement rather than by anything a caller controls.
  --
  -- Locking every row we own rather than just one also repairs the damage the old race could
  -- already have done: a holder that ended up on two rows is cut back to one here, and the surplus
  -- is released rather than left to be renewed forever.
  with mine as (
    select s.slot
      from public.async_worker_slots s
     where s.queue_name = v_queue
       and s.holder = claim_org_slot_and_read.holder
     order by s.slot
       for update
  )
  select min(m.slot), count(*) into v_own_slot, v_own_count from mine m;

  if coalesce(v_own_count, 0) > 1 then
    update public.async_worker_slots s
       set org = null, holder = null, claimed_at = null, expires_at = '-infinity'
     where s.queue_name = v_queue
       and s.holder = claim_org_slot_and_read.holder
       and s.slot <> v_own_slot;
  end if;

  v_sql := format($QUERY$
    with ready as (
        -- The partition key, defined ONCE. Everything downstream reads it from here rather than
        -- recomputing it, because `demand` and `picked` disagreeing about which org a message
        -- belongs to would mean claiming a slot for one org and then reading another org's work.
        --
        -- This MIRRORS the worker's own org resolver, the one guarding the circuit breaker in
        -- github-async-worker/index.ts (the `if (envelope.method === ...)` chain that ends in
        -- `throw new Error("Unknown method...")`). It has to: the budget must be charged to the org
        -- the handler is going to call, and that resolver is what decides which org that is.
        --
        --   create_repo, sync_student_team, sync_staff_team, sync_repo_permissions,
        --   archive_repo_and_lock, fetch_repo_analytics        -> args.org
        --   rerun_autograder                                   -> owner of args.repository
        --   sync_repo_to_handout                               -> owner of args.repository_full_name
        --
        -- The set is CLOSED, not open-ended: those eight are exactly the `case` labels in
        -- processEnvelope, and the resolver throws on anything else, so a ninth method fails loudly
        -- in the worker before it can reach here. The three envelope fields are mutually exclusive
        -- by method, so the coalesce order among them does not matter. Four decisions:
        --
        -- 1. THE ENVELOPE FIRST. The handler calls GitHub against the owner baked into the
        --    envelope, not against whatever classes.github_org says today. If an instructor
        --    repoints a class at a new org while jobs are queued, attributing that in-flight work
        --    to the new org charges the budget to an org no handler is going to touch, and lets the
        --    old one exceed max_per_org. split_part(x, '/', 1) is the SQL spelling of the
        --    resolver's repo.split("/")[0].
        -- 2. classes.github_org as the FALLBACK, and it carries real traffic: args.org is missing
        --    from about one envelope in seven (see the header for the measurement), and those are
        --    not a random seventh. Joining on c.id::text rather than casting the envelope to bigint
        --    cannot raise on a malformed class_id, and it puts the cast on `classes` (a few hundred
        --    rows) instead of on every queued message.
        -- 3. A METHOD THIS LIST DOES NOT KNOW gets its own bucket rather than the class fallback.
        --    A method whose name we do not recognize is a method whose org field we may not
        --    recognize either, so falling back to the class would be the same silent mis-budgeting
        --    this whole expression exists to stop. The bucket still drains like any other org, so
        --    nothing is stranded. Because the worker throws on exactly these methods, a non-empty
        --    '(unknown-method)' bucket in async_worker_slots.org means the two lists have drifted.
        -- 4. lower() over the whole thing. GitHub org names are case-insensitive and one class in
        --    prod already stores a mixed-case github_org, so 'Khoury-CS' and 'khoury-cs' are one
        --    org sharing one rate-limit bucket. Without the fold they would each draw a full
        --    max_per_org allowance against that single bucket.
        --
        -- Note that a literal percent sign cannot appear anywhere in this string, because the whole
        -- block is a format() template.
        select q.msg_id,
               case when q.message->>'method' in (
                         'create_repo', 'sync_student_team', 'sync_staff_team',
                         'sync_repo_permissions', 'archive_repo_and_lock', 'fetch_repo_analytics',
                         'rerun_autograder', 'sync_repo_to_handout')
                    then lower(coalesce(
                           nullif(q.message->'args'->>'org', ''),
                           nullif(split_part(q.message->'args'->>'repository', '/', 1), ''),
                           nullif(split_part(q.message->'args'->>'repository_full_name', '/', 1), ''),
                           c.github_org,
                           '(unresolved)'))
                    else '(unknown-method)'
               end as org
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
         -- $7 is the pinned org, or NULL for "pick the neediest". When it is set it is the ONLY
         -- candidate: a pinned caller is asking to stay where it is because it still has that org's
         -- work in flight, so falling through to a different org would recreate exactly the
         -- mid-stream rotation the pin exists to prevent. The ORDER BY below is then moot, since at
         -- most one row can survive this filter.
         where ($7 is null or d.org = $7)
           and (select count(*) from live l2 where l2.holder is distinct from $1) < $4
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
        --
        -- $6 is the slot this holder already owns here, locked by the step above, or NULL. When it
        -- is set it is the ONLY candidate: reusing our own row is what keeps one holder to one row
        -- per pool, and it is not a preference that can be lost. SKIP LOCKED does not skip a row
        -- locked by the CURRENT transaction, so having taken it above is exactly what makes it
        -- unskippable here. When it is NULL we own nothing, and any expired row will do.
        select s.queue_name, s.slot
          from public.async_worker_slots s
         where s.queue_name = $5
           and exists (select 1 from winner)
           and case when $6 is null then s.expires_at <= clock_timestamp() else s.slot = $6 end
         order by s.slot asc
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
    -- Scoped to the pin, not to the queue. For a pinned caller 'no_demand' has to mean "the org you
    -- pinned has nothing ready", because that is the answer it acts on: it stops topping up and lets
    -- its in-flight work finish before it considers rotating. Reporting 'no_capacity' just because
    -- some OTHER org still has work would make a drained org look like a busy one forever.
    select case when exists (select 1 from demand d where $7 is null or d.org = $7)
                then 'no_capacity' else 'no_demand' end,
           null::text, null::bigint, null::integer, null::timestamptz, null::timestamptz, null::jsonb
     where not exists (select 1 from drained)
  $QUERY$,
    v_qtable,
    make_interval(secs => lease_ttl_seconds),
    v_qtable,
    v_qtable,
    make_interval(secs => sleep_seconds)
  );

  return query execute v_sql using holder, n, max_per_org, global_cap, v_queue, v_own_slot, v_pin;
end;
$function$;

comment on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text) is
  'Atomically claim one drain lease for the neediest eligible GitHub org on `queue_name` and return '
  'up to n of that org''s ready messages, with vt and read_ct updated exactly as pgmq.read would. '
  'target(org) = least(ceil(ready/n), max_per_org); orgs are ordered by slots-held ascending FIRST '
  '(breadth before depth) then by unmet demand descending; global_cap bounds the whole queue. '
  'Messages whose class_id does not resolve to a classes.github_org are bucketed under the '
  '(unresolved) sentinel so they still drain. Returns zero rows and claims nothing when no org '
  'qualifies or no slot is free, exactly one row is returned with status no_demand (the queue has '
  'no visible work) or no_capacity (work is waiting but the caps are full), so a caller can tell '
  'the two apart before moving to a lower-priority queue. Serialized by one global advisory '
  'transaction lock, because the caps are counted across every queue''s pool. pin_org restricts the '
  'choice to one org, folded to lower case like every other org string here: with it set, no_demand '
  'means that org is drained and no_capacity means its caps are full, and the allocator never falls '
  'back to a different org.';


revoke all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text)
  from public, anon, authenticated;
grant all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text)
  to "service_role";
