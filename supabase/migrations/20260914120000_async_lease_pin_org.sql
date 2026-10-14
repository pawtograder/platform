-- Let a leaseholder ask to STAY on the org it is already draining.
--
-- WHAT CHANGED UPSTREAM. _shared/orgLeaseRun.ts now refills continuously: rather than claiming n
-- messages, running all of them to completion and claiming again, it keeps n in flight and tops up
-- the shortfall as each one settles.
--
-- THE 97.2 PERCENT HEADLINE IS A SIMULATION, AND AN UPPER BOUND RATHER THAN A FORECAST. Replaying
-- production's measured duration distribution through the real lease code takes per-leaseholder
-- utilization from 69.5 percent to 97.2 percent (orgLeaseRun.test.ts, "the continuous-refill switch
-- picks the drain shape"). That harness runs ONE leaseholder against ONE org, charges every claim a
-- flat 20 ms, and has neither lock contention nor a competing claimer, so the only loss it can
-- express is the ramp-down as the burst runs out. Quote it with those assumptions attached. The
-- loss refill removes was measured rather than simulated; orgLeaseRun.ts carries that arithmetic.
--
-- The figure INCLUDES the stream quantum's cost. Refill on its own reaches 99.1 percent on this
-- fixture; forcing a periodic unpinned reconsideration so a waiting org cannot be starved behind a
-- pinned one costs 1.9 points of it, and would cost 5.4 without the quantum's backoff (99.1 to 93.7
-- flat, against 97.2 with the backoff -- orgLeaseRun.ts carries that arithmetic too). A single-org
-- fixture is the shape where the quantum is ALL cost and no benefit, since there is never another
-- org for a reconsideration to find, so treat 1.9 points as the worst case rather than the price.
--
-- WHAT THAT BROKE, AND IT IS IN THIS FILE RATHER THAN THAT ONE. claim_org_slot_and_read re-picks
-- the neediest org on every call and re-points the caller's slot row at whatever it picked. Under
-- batch-at-a-time that was safe by construction: a rotation could only land BETWEEN batches, when
-- the leaseholder had nothing running. Under refill a top-up can come back with a different org
-- while up to n-1 messages of the previous org are still executing. The slot table then attributes
-- the leaseholder to the new org, and the old org's stragglers become concurrency the allocator no
-- longer counts against it. Its effective in-flight can reach max_per_org * n + (n - 1): 11 against
-- a budgeted 8 at the recommended max_per_org 2 with n 4, and 7 against 4 at the chart default
-- max_per_org of 1.
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
-- passes the SHORTFALL as n rather than the leaseholder's configured concurrency. NOTHING IS
-- SENSITIVE TO n, AND THAT IS A BIGGER STATEMENT THAN IT SOUNDS, so it is written out here rather
-- than left as a per-caller argument: the ceil(ready / n) term in the admission test cannot change
-- the outcome for ANY caller, pinned or not. The test is
--
--     a_others < least(ceil(ready / n) + a_all, max_per_org)
--
-- and `demand` only contains orgs with ready >= 1 while n >= 1 is validated above, so
-- ceil(ready / n) >= 1. a_others counts a subset of what a_all counts, so a_others <= a_all. Hence
--
--     ceil(ready / n) + a_all >= 1 + a_all > a_all >= a_others
--
-- is a tautology, the ceil arm of the least() can never be the binding one, and the whole predicate
-- reduces to
--
--     a_others < max_per_org
--
-- for every reachable value of ready, n, a_all and a_others. (Checked exhaustively over
-- a_all 0..8 x a_others 0..a_all x ready 1..60 x n 1..8 x max_per_org 1..8: zero divergences.)
--
-- THIS IS NOT THE SAME CLAIM THE 2026-09-12 MIGRATION MADE, and the difference is why it is spelled
-- out. That file added `+ a_all` to stop an org being throttled by its OWN progress -- ready counts
-- only visible messages, so each claim hid n of them and an org with 8 ready and max_per_org 2
-- computed a target of 1 after its first claim. The fix works, and it over-corrects: adding back one
-- unit per HELD SLOT is always at least as large as the number of competitors being compared
-- against, so it does not merely restore the org's own headroom, it removes the ceil throttle
-- entirely. The prose in that file still describes a throttle that has not been in force since; it
-- is an applied migration, so it is left as the record of what was believed then. The function
-- comment at the bottom of THIS file has been corrected to match the proof above.
--
-- NOTHING HERE DEPENDS ON THAT, which is the reason this migration states it rather than changes it.
-- Pinning, the own-row reuse and the per-org cap are all arguments about max_per_org, global_cap and
-- breadth-first ordering, and all three are untouched. But two live consequences follow and should
-- be decided deliberately rather than inherited:
--
--   * An org with ONE ready message is admitted to as many slots as max_per_org allows. The ceil
--     term was what used to stop that.
--   * The ORDER BY's second key, least(...) - a_others, is the "unmet demand descending" tiebreak.
--     Once least() saturates at max_per_org for every competing org, that key is constant among
--     ties and the winner is decided by the THIRD key, d.org asc. Saturation is immediate at the
--     chart default max_per_org of 1, since ceil(ready / n) >= 1 always; at the recommended 2 it
--     takes ready > n for an org holding no slot, and is again immediate for one that holds any.
--     Among orgs holding equally many slots the next one served is therefore alphabetical, not
--     neediest-first.
--
-- Breadth before depth still holds regardless: it is the FIRST key, a_others asc, and it is
-- unaffected by any of this.

-- THE CLASS FALLBACK IS A PER-ROW LOOKUP NOW, NOT A JOIN, AND THIS IS THE INDEX THAT PAYS FOR IT.
--
-- The org resolver below reaches classes.github_org through a correlated scalar subquery rather
-- than through a left join. Two things follow, and only the first was the goal:
--
-- 1. THE RESOLVER BECOMES AN EXPRESSION OVER ONE QUEUE ROW, with no join obligation on whoever
--    uses it. That is what lets the same expression drive a scan that reads the whole backlog and
--    a scan that reads four rows and stops. A join has to be set up before anything can be
--    filtered, so the four-row scan was not available while the resolver needed one.
--
-- 2. THE PLANNER PRICES IT PER ROW, and that is what makes the four-row scan get CHOSEN rather
--    than merely be possible. `picked` asks for the n lowest ready msg_ids of one org; the planner
--    cannot estimate how selective an org predicate is, so it has to choose between reading the
--    primary key in order and stopping early, and reading everything and sorting. A correlated
--    subquery is costed per call, so both plans carry N times that cost while only the ordered one
--    gets to divide its total by the LIMIT fraction -- and the deeper the queue, the more
--    decisively the ordered plan wins. Replacing the subquery with something the planner thinks is
--    free (a jsonb map of the whole classes table, built once) flips `picked` back to
--    scan-and-sort: 1.8 ms per pinned claim becomes 10.9 ms at a 5000-message backlog. Measured,
--    not assumed. The corollary is that the early stop is a PLAN choice and not a structural
--    guarantee, so it is stable only while the resolver stays expensive enough to earn the
--    LIMIT-fraction discount.
--
-- WHAT IT BOUGHT. Per-claim milliseconds, before this rewrite and after, min of 3 runs of 20
-- claims against a 6000-message fixture over 4 orgs (70/10/10/10) and a 414-row public.classes:
--
--     queue depth   unpinned, fresh claim   pinned top-up    unpinned top-up
--               0       3.13 -> 2.87          3.08 -> 2.89     3.02 -> 2.92
--            2000       8.55 -> 6.86         10.55 -> 1.79    10.45 -> 6.59
--            5000      16.96 -> 12.64        22.80 -> 1.78    23.02 -> 12.05
--
-- The pinned top-up is the claim refill issues on every settled message, and it is now FLAT in
-- queue depth. EXPLAIN at depth 5000 says where that came from: 10,964 shared buffer hits and
-- 24.5-26.6 ms of execution become 111 hits and 0.96-1.30 ms. An unpinned claim still has to see
-- every org, so the same measurement gives 10,964 hits and 26.8-30.2 ms before against 2,799 and
-- 14.0-17.9 ms after.
--
-- WHAT IT COSTS, because it is not free. A left join reads classes once per statement; this reads
-- it once per message whose envelope carried no org, which production measures at about one in
-- seven. Without an index that is a sequential scan per row and it is ruinous -- 100 ms per call
-- on a 5000-message backlog against a few-hundred-row classes. With the index below it is 12 ms.
--
-- AND THERE IS A REGRESSION, ON THE UNPINNED PATH. That path scans the whole backlog either way, so
-- it gains nothing from the early stop while still paying a class lookup per fallback row. On the
-- 2400-message, six-org, one-in-three-fallback shape the concurrency scenario uses, an unpinned
-- claim goes from 8.01 ms to 10.07 ms and the storm's aggregate throughput from 143-147 to 114-120
-- claim calls per second. Production should see a milder version: its fallback rate is one in seven
-- rather than one in three, and globalCap 8 bounds the claimers to a sixth of the storm's 48
-- concurrent sessions. Milder is not absent, and this is the number to watch if unpinned claims
-- ever become the common ones.
--
-- THE BOUND IS NOT QUEUE DEPTH, IT IS THE OFFSET OF THE PINNED ORG'S FIRST READY MESSAGE, which is
-- the other thing the shape of the queue decides. `picked` walks msg_id ascending and stops at the
-- nth match, so a pinned claim is flat only while its org's work is reachable early. Laid out as
-- four contiguous 1250-message blocks, one org each, a pinned claim on the FRONT block goes
-- 16.12 -> 1.71 ms and one on the BACK block 16.34 -> 10.89 ms. The interleaved fixture above is
-- the realistic shape for a platform whose orgs release independently; one org's bulk enqueue
-- sitting entirely behind another's is not, and it is where the flatness stops.
--
-- Indexed on the SAME id::text the resolver compares, because the resolver deliberately casts the
-- class id rather than the envelope (a malformed class_id must not raise) and an index on plain
-- `id` cannot serve that comparison. classes is a few hundred rows written a few times a term, so
-- the maintenance cost is nil.
create index if not exists classes_id_text_idx on public.classes ((id::text));

drop function if exists pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer);
-- The 8-argument signature too, because the return type below changes from an inline
-- `returns table(...)` to this named composite and `create or replace` cannot change a return type.
-- Both drops are `if exists` so the migration applies to a database that has neither.
drop function if exists pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text);
drop type if exists pgmq_public.org_slot_row;

-- THE RETURN TYPE IS A NAMED COMPOSITE RATHER THAN AN INLINE `returns table(...)`, AND THE REASON IS
-- THE GENERATED TYPESCRIPT, NOT THE SQL. Both spellings behave identically in Postgres and on the
-- wire: PostgREST serializes either as an array of objects with these seven keys.
--
-- What differs is what `supabase gen types` can say about them. An inline `returns table(...)` is
-- OUT parameters, and a parameter carries a type but no nullability, so the generator has no choice
-- but to emit every column as non-null -- `org: string; msg_id: number; message: Json`. That is a
-- lie on the two status paths: `no_demand` and `no_capacity` return exactly one row with NULL in
-- every field except `status`, so a caller reading `.org.toLowerCase()` off a typed rpc() result
-- type-checks and then throws at runtime. The worker only escapes it by casting the response to its
-- own hand-written `OrgSlotRow`, whose fields are all nullable, in `orgSlotRpc`.
--
-- A named composite's attributes ARE nullable -- `create type` accepts no NOT NULL -- so the
-- generator emits it under `CompositeTypes` with `| null` on every field, and the rpc's `Returns`
-- becomes a reference to it. That is the same shape as `OrgSlotRow`, arrived at from the database
-- rather than by hand, and it survives `npm run client-local` because nothing post-processes it.
-- Fixing this in scripts/PostprocessSupabaseTypes.ts instead would mean a rewrite rule keyed on this
-- one function's name, re-applied to output nobody checks, and it would still leave the database's
-- own declaration saying the opposite.
create type pgmq_public.org_slot_row as (
  status text,
  org text,
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
);

comment on type pgmq_public.org_slot_row is
  'Return type of pgmq_public.claim_org_slot_and_read. A named composite rather than an inline '
  'returns table(...) so that generated clients see every field as nullable: the no_demand and '
  'no_capacity answers are one row carrying a status and NULL everywhere else.';

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
returns setof pgmq_public.org_slot_row
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
  -- THE PARTITION KEY, DEFINED ONCE. Both `demand` and `picked` below are handed THIS string by
  -- format(), because the two of them disagreeing about which org a message belongs to would mean
  -- claiming a slot for one org and then reading another org's work. It used to be written out once
  -- inside a `ready` CTE that `picked` then semijoined to on msg_id; carrying it as one interpolated
  -- expression is the same guarantee -- one definition, one place to edit -- without forcing every
  -- consumer to materialize the whole backlog first.
  --
  -- It is an expression over ONE QUEUE ROW and nothing else. `q` is the only alias it mentions, so
  -- any scan of a queue table can apply it directly, including one that stops after four rows. See
  -- the note above the classes index for why that matters and what it costs.
  --
  -- This MIRRORS the worker's own org resolver, the one guarding the circuit breaker in
  -- github-async-worker/index.ts (the `if (envelope.method === ...)` chain that ends in
  -- `throw new Error("Unknown method...")`). It has to: the budget must be charged to the org the
  -- handler is going to call, and that resolver is what decides which org that is.
  --
  --   create_repo, sync_student_team, sync_staff_team, sync_repo_permissions,
  --   archive_repo_and_lock, fetch_repo_analytics        -> args.org
  --   rerun_autograder                                   -> owner of args.repository
  --   sync_repo_to_handout                               -> owner of args.repository_full_name
  --
  -- The set is CLOSED, not open-ended: those eight are exactly the `case` labels in processEnvelope,
  -- whose `default` arm throws `Unknown async method`, so a ninth method fails on every delivery and
  -- ends up in the DLQ. Note the order, because it is the opposite of what "before it can reach
  -- here" would suggest: the claim runs FIRST, so an unknown method reaches this expression before
  -- any worker sees it, which is what the '(unknown-method)' bucket in decision 3 is for. The
  -- circuit-breaker resolver throws too, but that one is caught and reported to Sentry rather than
  -- failing the message. The three envelope fields are mutually exclusive by method, so the coalesce
  -- order among them does not matter. Four decisions:
  --
  -- 1. THE ENVELOPE FIRST. The handler calls GitHub against the owner baked into the envelope, not
  --    against whatever classes.github_org says today. If an instructor repoints a class at a new
  --    org while jobs are queued, attributing that in-flight work to the new org charges the budget
  --    to an org no handler is going to touch, and lets the old one exceed max_per_org.
  --    split_part(x, '/', 1) is the SQL spelling of the resolver's repo.split("/")[0].
  --
  --    KNOWN EXCEPTION, AND IT IS NOT THEORETICAL. That paragraph is true of syncStudentTeam and
  --    syncStaffTeam, which are called with args.org, but NOT of the invitation path in the same
  --    two handlers: github-async-worker/index.ts calls reinviteToOrgTeam with
  --    data.classes.github_org, the CURRENT value, a dozen lines above calling syncStudentTeam with
  --    args.org. So a repointed class makes one handler talk to two orgs at once: the invitation
  --    spends the NEW org's shared content limiter while the slot it is running under is charged to
  --    the OLD org. Concurrent stale and fresh envelopes can therefore push the new org past the
  --    occupancy this function exists to bound, and convoy invitations inside its limiter.
  --
  --    NOT FIXED HERE, because the two candidate fixes are product decisions rather than allocator
  --    ones: reject or re-enqueue a team-sync envelope whose args.org no longer matches its class,
  --    or make the invitation target args.org and accept that a repointed class stops inviting to
  --    the org it actually moved to. Changing this expression cannot fix it -- whichever org the
  --    allocator picks, the handler still calls two different ones. Raised by Codex on #982.
  -- 2. classes.github_org as the FALLBACK, and it carries real traffic: args.org is missing from
  --    about one envelope in seven, and those are not a random seventh. The lookup compares c.id::text rather than casting the envelope to bigint, which
  --    cannot raise on a malformed class_id, and it puts the cast on `classes` (a few hundred rows,
  --    indexed on exactly that expression above) instead of on every queued message. Because it
  --    sits inside the coalesce it runs only when every envelope arm came back null -- that same
  --    one row in seven -- rather than once per scanned row.
  --
  --    IT IS WRAPPED IN nullif(..., '') FOR THE SAME REASON THE THREE ENVELOPE ARMS ARE, and the
  --    consequence of leaving it unwrapped is worse here than a mis-labelled bucket. classes.github_org
  --    is nullable with no check constraint, and '' is a state this schema already expects: five other
  --    migrations guard it by hand (`c.github_org is not null and c.github_org <> ''` in
  --    20250908133405, 20251004115504 and 20260909170000, `nullif(trim(c.github_org), '') is not null`
  --    in 20260315200001 and 20260322000001). An unwrapped fallback answers `org = ''` for every message
  --    of such a class, and coalesce stops there, so the '(unresolved)' sentinel below is never
  --    reached. The claim then returns org = '' and _shared/orgLeaseRun.ts refuses to pin on it
  --    (`if (!held || heldQueueName === null || !heldOrgValue) return null`), so continuous refill
  --    quiesces on every top-up and the run silently degrades to the batch-at-a-time behaviour this
  --    whole branch exists to remove -- while every liveness signal stays green. With the nullif the
  --    class falls through to '(unresolved)', which is a non-empty org string like any other: it
  --    pins, it drains, and it is already documented in the function comment as a bucket a claim can
  --    come back holding. Whitespace-only is deliberately NOT trimmed here: ' ' resolves to a
  --    non-empty bucket that pins and drains correctly, so it does not exhibit this defect, and
  --    trimming it would silently re-bucket padded org names as an unrelated change.
  -- 3. A METHOD THIS LIST DOES NOT KNOW gets its own bucket rather than the class fallback. A method
  --    whose name we do not recognize is a method whose org field we may not recognize either, so
  --    falling back to the class would be the same silent mis-budgeting this whole expression exists
  --    to stop. The bucket still drains like any other org, so nothing is stranded. Because the
  --    worker's switch throws on every method outside the eight, a non-empty '(unknown-method)'
  --    bucket in async_worker_slots.org means the two lists have drifted, and the messages in it are
  --    on their way to the DLQ.
  -- 4. lower() over the whole thing. GitHub org names are case-insensitive and one class in prod
  --    already stores a mixed-case github_org, so 'Khoury-CS' and 'khoury-cs' are one org sharing
  --    one rate-limit bucket. Without the fold they would each draw a full max_per_org allowance
  --    against that single bucket.
  v_org_expr constant text := $ORG$
        case when q.message->>'method' in (
                  'create_repo', 'sync_student_team', 'sync_staff_team',
                  'sync_repo_permissions', 'archive_repo_and_lock', 'fetch_repo_analytics',
                  'rerun_autograder', 'sync_repo_to_handout')
             then lower(coalesce(
                    nullif(q.message->'args'->>'org', ''),
                    nullif(split_part(q.message->'args'->>'repository', '/', 1), ''),
                    nullif(split_part(q.message->'args'->>'repository_full_name', '/', 1), ''),
                    nullif((select c.github_org
                              from public.classes c
                             where c.id::text = q.message->>'class_id'), ''),
                    '(unresolved)'))
             else '(unknown-method)'
        end
  $ORG$;
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
  -- as an exception the worker reports, not as a silent change of behavior.
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
  -- max_per_org while no leaseholder is doing its work. The global advisory lock does not help,
  -- because it serializes allocators against each other and renew_org_slot never takes it.
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
    with demand as (
        -- HOW MANY READY MESSAGES EACH ORG HAS, except that the count is deliberately CAPPED and
        -- the scan is deliberately allowed to stop early when the caller pinned an org.
        --
        -- The org expression below is v_org_expr, the partition key declared once above, dropped
        -- in by format() at the sixth argument. Note that a literal percent sign cannot appear
        -- anywhere in this template -- including in these comments, which format() rewrites just
        -- like the SQL around them -- although it can appear inside an interpolated argument.
        --
        -- THE PIN FILTER IS HERE as well as in `winner` and in the status arm below, where it is
        -- now redundant. It is here because it is the only place it can stop the scan: a pinned
        -- caller has exactly one candidate org, so every row belonging to any other org is work
        -- this call will not use. The two redundant copies are left alone because they are where
        -- the pin's MEANING is argued, and re-testing an equality against the handful of rows
        -- `demand` returns costs nothing.
        --
        -- THE CAP, WHICH IS THE PART THAT NEEDS AN ARGUMENT. `ready` escapes this CTE through
        -- exactly one shape, least(ceil(ready / n) + a_all, max_per_org), which appears in the
        -- winner's admission test and in its second ORDER BY key; the status arm below needs only
        -- whether the org appears at all. That expression saturates: once ready >= n * max_per_org,
        -- ceil(ready / n) >= max_per_org, so least() returns max_per_org whatever a_all is, and
        -- below that the cap is not reached and the count is exact. A count clamped at
        -- n * max_per_org is therefore indistinguishable from the true count in every consumer.
        --
        -- The clamp holds a fortiori under what is actually in force, since the header proves the
        -- ceil arm cannot bind at all: the only thing this count decides today is whether the org
        -- appears. The saturation argument is written out anyway so the clamp stays justified if
        -- the admission test is ever repaired.
        --
        -- The clamp is applied ONLY on the pinned path, and that is not an accident. Clamping
        -- unpinned would need a per-org limit, which needs the orgs enumerated, which needs the
        -- whole scan -- there is nothing to save. It also keeps the clamp away from the one
        -- consumer whose value is not provably inert: the ORDER BY tiebreak. A pinned call has at
        -- most one candidate row, so it never orders anything.
        --
        -- LIMIT NULL is Postgres for "no limit", which is what the unpinned path gets: the same
        -- exact per-org counts over the same full scan as before.
        select r.org, count(*)::int as ready
          from (
                select r0.org
                  from (
                        select %6$s as org
                          from pgmq.%1$I q
                         where q.vt <= clock_timestamp()
                       ) r0
                 where $7 is null or r0.org = $7
                 limit case when $7 is null then null::bigint
                            else $2::bigint * $3::bigint end
               ) r
         group by 1
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
           -- target = ceil(ready/n) + slots already held, capped at max_per_org. In force today
           -- the ceil arm can never be the binding one, so this predicate is exactly
           -- a_others < max_per_org; the header proves that and says why the term is still here.
           -- Read the paragraph below as the record of why `+ a_all` was added, not as a live
           -- throttle.
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
        -- pgmq.read's CTE with one extra predicate: the same ORDER BY msg_id, the same LIMIT, the
        -- same FOR UPDATE SKIP LOCKED, and `OF q` rather than bare so locking stays on the queue
        -- table.
        --
        -- THE PREDICATE IS THE RESOLVER ITSELF, applied to the row in front of us, rather than a
        -- semijoin against a precomputed set of msg_ids. It is the same v_org_expr at the same
        -- format argument as in `demand`, so the two cannot disagree. The semijoin form had to
        -- materialize every ready row of the winning org and probe the queue's primary key once
        -- per row before the LIMIT could discard all but n of them, and at a 5000-message backlog a
        -- whole pinned claim cost 10,964 shared buffer hits to return four msg_ids. Written this
        -- way the LIMIT is what bounds the scan -- walk msg_id ascending, resolve, stop at the nth
        -- match -- and the same claim costs 111.
        --
        -- STOPPING EARLY IS A PLAN CHOICE, NOT A STRUCTURAL GUARANTEE, and the difference is what
        -- the note above the classes index is about: the correlated resolver is costed per row, so
        -- the LIMIT-fraction discount favors the ordered scan, and more decisively the deeper the
        -- queue. Make the resolver cheap and the planner goes back to scan-and-sort. The same note
        -- records what the bound actually is, which is the offset of the winning org's first ready
        -- message rather than the depth of the queue.
        --
        -- The SKIP LOCKED semantics are unchanged by that, and this is the reason the limit is NOT
        -- pushed into a subquery instead. LockRows sits under the Limit, so a row another reader
        -- holds is skipped and the scan CONTINUES to the next candidate. Picking four msg_ids
        -- first and locking them afterwards would return three messages whenever one of the four
        -- was busy, which is a different function.
        --
        -- If `claimed` produced no row the scalar subquery is NULL, every comparison is NULL, and
        -- nothing is picked. That is the "no org qualified or no slot free" path, and it claims
        -- nothing.
        --
        -- The `exists` says the same thing a second time, and it is not redundant. It is an
        -- uncorrelated subquery, so it is evaluated once and gates the scan as a one-time filter --
        -- the same idiom `free_slot` uses above. Without it the NULL comparison is a per-row filter
        -- that nothing can satisfy, and the scan still walks the entire queue in msg_id order
        -- before returning nothing. Every 'no_demand' and 'no_capacity' call takes that path, which
        -- is most of them once a burst is drained.
        select q.msg_id
          from pgmq.%3$I q
         where q.vt <= clock_timestamp()
           and exists (select 1 from claimed)
           and %6$s = (select k.org from claimed k)
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
    -- Note which way round the two answers are asymmetric for a caller deciding whether to release:
    -- 'no_demand' proves `claimed` never ran, whereas 'no_capacity' does NOT, because `claimed` can
    -- commit a live lease and `picked` still return nothing when every candidate row is locked. See
    -- the function comment below.
    select case when exists (select 1 from demand d where $7 is null or d.org = $7)
                then 'no_capacity' else 'no_demand' end,
           null::text, null::bigint, null::integer, null::timestamptz, null::timestamptz, null::jsonb
     where not exists (select 1 from drained)
  $QUERY$,
    v_qtable,
    make_interval(secs => lease_ttl_seconds),
    v_qtable,
    v_qtable,
    make_interval(secs => sleep_seconds),
    v_org_expr
  );

  return query execute v_sql using holder, n, max_per_org, global_cap, v_queue, v_own_slot, v_pin;
end;
$function$;

comment on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text) is
  'Atomically claim one drain lease for the neediest eligible GitHub org on `queue_name` and return '
  'up to n of that org''s ready messages, with vt and read_ct updated exactly as pgmq.read would. '
  'An org is admitted while it holds fewer than max_per_org slots: the expression in the winner CTE '
  'is least(ceil(ready/n) + slots_held, max_per_org), whose ceil arm provably cannot bind, so '
  'max_per_org is the only per-org constraint -- see the header. Orgs are ordered by slots-held '
  'ascending FIRST (breadth before depth), then by remaining headroom descending, then by org name; '
  'the second key is constant once headroom saturates, so ties break alphabetically. global_cap '
  'bounds the whole fleet across every queue''s pool. Messages whose class_id does not resolve to a '
  'classes.github_org are bucketed under the (unresolved) sentinel, and messages whose method this '
  'function does not know under (unknown-method), so both still drain and both can come back as the '
  'org of a claim. Exactly one row is returned with status no_demand (the queue, or the pinned org, '
  'has no visible work) or no_capacity (work is waiting but the caps are full, OR a slot was taken '
  'and every candidate message was locked by a concurrent reader) when no messages are returned, '
  'so a caller can tell the two apart before moving to a lower-priority queue. NOTE that '
  'no_capacity does NOT imply nothing was written: the slot UPDATE is a data-modifying CTE that '
  'commits whenever an org qualifies and a slot is free, even when the subsequent SKIP LOCKED read '
  'returns nothing, so a caller that gets no_capacity must still release. Serialized by one global '
  'advisory transaction lock, because the caps are counted across every queue''s pool. pin_org '
  'restricts the choice to one org, folded to lower case like every other org string here: with it '
  'set, no_demand means that org is drained and no_capacity means its caps are full, and the '
  'allocator never falls back to a different org.';


revoke all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text)
  from public, anon, authenticated;
grant all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text)
  to "service_role";
