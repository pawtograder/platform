-- Give handout syncs their own queue, and choose the queue with one deployment-wide setting.
--
-- Spec: docs/handout-sync-git-worker.md §3 (architecture), §3.1 (worker heartbeat) and §10
-- (rollout). Build plan: docs/handout-sync-git-build-plan.md, WP4 and decision D3.
--
-- WHY. sync_repo_to_handout moves file content through an edge isolate capped at 256 MB. On
-- 2026-10-26 one ~30 MB, 27-file handout (neu-cs5004/fa26-handout-hw-img1) ran that isolate out of
-- memory on every attempt; the OOM surfaces as `Uncaught null`, the message redelivers into the same
-- OOM until it is dead-lettered, and every other message sharing the isolate dies with it. The
-- replacement is a git-based worker running as its own Deployment, and it needs its own queue so
-- that the queue a message is on decides which engine runs it: the edge worker drains async_calls
-- and always runs the REST path, the new worker drains handout_sync and always runs git.
--
-- WHAT THIS MIGRATION ADDS.
--
--   1. pgmq queues handout_sync and handout_sync_dlq.
--   2. pgmq_public.set_vt, so the new worker can extend a message's visibility timeout while the
--      job runs (§3.1: 120 s VT, renewed every 45 s). PostgREST exposes pgmq_public, and nothing
--      there could move a VT before this.
--   3. The system_settings row handout_sync_engine, seeded as {"engine": "rest", "shadow": false}.
--   4. queue_repository_syncs routing on that row, with its in-flight claim widened to the new queue.
--   5. delete_assignment_with_all_data cancelling and refusing on handout_sync messages as well,
--      because it relies on seeing every queued sync (section 5 below).
--   6. public.handout_sync_shadow_results, where shadow runs record what the git engine would have
--      built.
--
-- NOTHING CHANGES AT DEPLOY. The seeded setting is the REST path, so every sync still goes to
-- async_calls exactly as before, with an identical message. Flipping the row is the rollout; setting
-- engine back to "rest" is the rollback. Neither needs a deploy.
--
-- DEPLOY STEP: run `NOTIFY pgrst, 'reload schema';` after this migration. pgmq_public.set_vt is a
-- new RPC, and PostgREST answers PGRST202 for it until its schema cache reloads.
--
-- PRODUCER AUDIT (§10). queue_repository_syncs is the only SQL path that sends sync_repo_to_handout.
-- 20260911030000 and 20260913120000 are earlier revisions of that same function, not separate
-- producers; 20260915120000 replaced both. No trigger, cron job or other function sends one. On the
-- TypeScript side, the only send of an existing envelope is requeueWithDelay in github-async-worker,
-- which sends to the queue the message was read from (processEnvelope's meta.queue_name), so a
-- handout_sync message requeues onto handout_sync. tests/e2e/fork-from-prior-assignment sends one
-- directly to async_calls to exercise the edge path, which is what it is testing.

-- ---------------------------------------------------------------------------------------------
-- 1. Queues
-- ---------------------------------------------------------------------------------------------
-- Same shape as async_calls_low_priority (20260322000001) and gradebook_row_recalculate_dlq
-- (20260811130200): a plain pgmq queue, created idempotently, with explicit table grants for
-- service_role. Migrations run as supabase_admin in the chart, whose default privileges in pgmq do
-- not include service_role, so the grants are not redundant there.
--
-- handout_sync_dlq is where the git worker parks a message after read_ct passes 5 (§3.1). It is a
-- sibling of async_calls_dlq rather than a reuse of it so that each worker's poison messages stay
-- with the worker that can replay them.
do $$
begin
  perform pgmq.create('handout_sync');
exception when others then
  -- queue likely exists; ignore
  null;
end $$;

do $$
begin
  perform pgmq.create('handout_sync_dlq');
exception when others then
  -- queue likely exists; ignore
  null;
end $$;

grant insert, select, delete, update on table pgmq.q_handout_sync to service_role;
grant insert, select, delete, update on table pgmq.a_handout_sync to service_role;
grant insert, select, delete, update on table pgmq.q_handout_sync_dlq to service_role;
grant insert, select, delete, update on table pgmq.a_handout_sync_dlq to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. pgmq_public.set_vt
-- ---------------------------------------------------------------------------------------------
-- The heartbeat. A job holds its message invisible for 120 s at a time and pushes the deadline out
-- every 45 s while it runs, so a pod that dies hands its message back within two minutes instead of
-- after the edge path's 480 s wall clock plus a full VT. The heartbeat also makes "is this message
-- being worked on right now?" answerable from the queue row alone (read_ct > 0 and vt in the
-- future), which section 5 relies on.
--
-- Written exactly like the other pgmq_public wrappers (20250417002136): SECURITY INVOKER, an empty
-- search_path, and a straight pass-through to pgmq. It returns the message rows pgmq.set_vt returns,
-- so an empty result tells the caller the message is gone (archived, deleted or cancelled by an
-- assignment delete) and the job no longer holds anything to renew.
--
-- No queue-name allowlist. The existing wrappers have none, and service_role, the only role that
-- can call this, can already read, archive and delete on every queue through them; an allowlist
-- here would restrict nothing that role cannot already do. queue_name reaches pgmq.set_vt as a
-- parameter, and pgmq.format_table_name rejects a name that is not a safe identifier before pgmq
-- interpolates it.
--
-- service_role only. Since 20261015120000 a new function gets no EXECUTE for PUBLIC by default, and
-- anon has no USAGE on pgmq_public, but the REVOKE is written out so the posture does not depend on
-- either default. A caller who could move a VT could hide any message in any queue indefinitely.
create or replace function pgmq_public.set_vt(queue_name text, message_id bigint, vt_offset_seconds integer)
 returns setof pgmq.message_record
 language plpgsql
 set search_path to ''
as $function$ begin return query select * from pgmq.set_vt( queue_name := queue_name, msg_id := message_id, vt := vt_offset_seconds ); end; $function$
;

revoke all on function pgmq_public.set_vt(text, bigint, integer) from public, anon, authenticated;
grant execute on function pgmq_public.set_vt(text, bigint, integer) to service_role;

comment on function pgmq_public.set_vt(text, bigint, integer) is
  'Sets a message''s visibility timeout to now() + vt_offset_seconds and returns the message, or no '
  'row if it is no longer in the queue. The handout-sync worker''s heartbeat. service_role only.';

-- ---------------------------------------------------------------------------------------------
-- 3. The routing switch
-- ---------------------------------------------------------------------------------------------
-- One row, read by queue_repository_syncs each time it is called (D3: one deployment-wide switch,
-- no per-class routing). system_settings is admin-only under RLS (20250823074648), and
-- queue_repository_syncs is SECURITY DEFINER, so an instructor's press can read it and cannot
-- change it.
--
--   {"engine": "git"}                    sync messages go to handout_sync only.
--   {"engine": "rest", "shadow": true}   the REST message goes to async_calls unchanged, and a
--                                        marked copy goes to handout_sync for a plan-only run.
--   anything else                        the REST path, exactly as before this migration.
--
-- "Anything else" is deliberate. The row is jsonb edited by hand, and a typo ("Git", "shadow":
-- "true", a bare string, a deleted row) must land on the path that has been running in production,
-- never on the new one. So engine has to be the JSON string "git" and shadow the JSON boolean
-- true; every other value reads as rest without shadow.
--
-- shadow is ignored when engine is git. A shadow run is a prediction to be compared against what
-- the REST path pushed, and with git routing there is no REST push to compare it to.
--
-- ON CONFLICT DO NOTHING, so a row someone already set (say, staging flipped by hand before this
-- migration reached it) is not reset to rest.
insert into public.system_settings (key, value)
values ('handout_sync_engine', '{"engine": "rest", "shadow": false}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 4. queue_repository_syncs
-- ---------------------------------------------------------------------------------------------
-- Copied from 20260915120000_dedupe_queued_repository_syncs.sql, with the access check of
-- 20261106140000_assignments_save_by_capability.sql. The 20260915 header explains the claim
-- this keeps: the unarchived queue message IS the claim that a sync for this repository at this
-- revision is queued or running, read after `for update of r`, with an unreadable queue answering
-- "nothing pending". Every guarantee in that header still holds. What changes:
--
-- WHERE THE MESSAGE GOES. The setting is read once per call, before the loop, so one press routes
-- every repository it queues the same way even if an admin flips the row mid-call. The message body
-- is the same on both routes: the queue decides the engine, so the envelope does not need to say.
--
-- THE CLAIM COVERS handout_sync TOO. A sync queued on either engine is a job that will reset the
-- sync branch and open or reset the pull request, so a duplicate on the other queue does the same
-- damage the 20260915 header describes. Scanning all three queues also covers the transition: after
-- the switch flips to git, messages already in async_calls keep draining on the edge path (§10),
-- and a press for the same revision must not start a second job on the git path beside them. The
-- reverse holds on rollback.
--
-- SHADOW COPIES ARE NOT CLAIMS. A shadow message is plan-only: no push, no PR, no write to the
-- repositories row (build plan WP5). It cannot collide with a real job, so it must not make a real
-- job look in flight. Without the filter, a shadow copy of revision R sitting unread in handout_sync
-- would make the next press of R report skipped_in_flight_count after the REST job it shadowed had
-- already finished. Every shadow copy is sent together with a real message in the same transaction,
-- so ignoring shadow copies cannot hide a real job.
--
-- WHAT A SHADOW COPY CARRIES. The REST envelope with "shadow": true at the top level and
-- args.synced_repo_sha added. args.from_sha is already the row's synced_handout_sha. Both are read
-- from the row this function holds locked, so they are the inputs the REST job would see if it ran
-- now. The REST job rereads the row when it runs (github-async-worker, "Both sides of the comparison
-- have to come from one moment") and then advances it, so a shadow run that also read the row would
-- be racing the job it is meant to predict.
--
-- A FAILED SHADOW SEND DOES NOT FAIL THE SYNC. It runs in its own exception block and leaves a
-- WARNING in the Postgres log. Shadow mode exists to observe the REST path, so a problem with the
-- observer must never cost the instructor the sync.
create or replace function public.queue_repository_syncs(
    p_repository_ids bigint[],
    p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_class_id bigint;
    v_repo_record record;
    v_queued_count integer := 0;
    v_skipped_count integer := 0;
    v_skipped_in_flight_count integer := 0;
    v_error_count integer := 0;
    v_errors jsonb[] := '{}';
    v_sync_strategy text;
    v_upstream_repo_full_name text;
    v_sync_already_queued boolean;
    v_claimed_id bigint;
    v_engine_setting jsonb;
    v_route_git boolean := false;
    v_send_shadow boolean := false;
    v_message jsonb;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated';
    end if;

    select r.class_id into v_class_id
    from public.repositories r
    where r.id = any(p_repository_ids)
    limit 1;

    if v_class_id is null then
        raise exception 'No repositories found with provided IDs';
    end if;

    if (select count(distinct r.class_id)
        from public.repositories r
        where r.id = any(p_repository_ids)) > 1 then
        raise exception 'All repositories must belong to the same class';
    end if;

    -- Admins of any course, or holders of manage_assignments in this class (#1010): Edit Assignment
    -- queues these syncs through assignment-sync-autograder-workflow with the editor's own JWT.
    -- Carried over unchanged from 20261106140000_assignments_save_by_capability.sql.
    if not (
        exists (select 1 from public.user_privileges up where up.user_id = auth.uid() and up.role = 'admin')
        or v_class_id in (select public.user_class_ids_with_capability('manage_assignments'))
    ) then
        raise exception 'manage_assignments is required to queue repository syncs for class %', v_class_id;
    end if;

    -- The routing switch (section 3 of 20261109120000). Strict comparisons on purpose: a missing
    -- row, a non-object value or a mistyped field all leave both flags false, which is the REST
    -- path this function took before the switch existed. `->` on a jsonb scalar or array yields
    -- NULL rather than raising, so no shape of the value can make this statement fail.
    select s.value into v_engine_setting
    from public.system_settings s
    where s.key = 'handout_sync_engine';

    v_route_git := coalesce(v_engine_setting -> 'engine' = '"git"'::jsonb, false);
    v_send_shadow := not v_route_git
        and coalesce(v_engine_setting -> 'shadow' = 'true'::jsonb, false);

    for v_repo_record in
        select
            r.id,
            r.repository,
            r.profile_id,
            r.assignment_group_id,
            r.synced_handout_sha,
            r.synced_repo_sha,
            r.desired_handout_sha,
            r.sync_blocked_at,
            r.sync_data,
            r.class_id,
            a.id as assignment_id,
            a.template_repo,
            a.latest_template_sha,
            a.title as assignment_title,
            a.repo_mode,
            a.source_assignment_id
        from public.repositories r
        join public.assignments a on r.assignment_id = a.id
        where r.id = any(p_repository_ids)
          and a.template_repo is not null
          and a.template_repo <> ''
          and a.latest_template_sha is not null
          and r.is_github_ready = true
        -- Lock each repository as it is read, so a concurrent call sees this one's claim
        -- instead of the state it started from. `of r` locks the repository alone: the
        -- assignment is read for its template and must not be locked by a sync press, or one
        -- instructor queueing a sync would block another editing the assignment. `order by
        -- r.id` fixes the order two overlapping bulk presses take the locks in, which is what
        -- keeps them waiting for each other instead of deadlocking.
        order by r.id
        for update of r
    loop
        begin
            -- Resolve sync strategy + upstream from repo_mode.
            v_upstream_repo_full_name := null;
            if v_repo_record.repo_mode = 'template_with_student_forks' then
                v_sync_strategy := 'fork_merge_upstream';
                v_upstream_repo_full_name := v_repo_record.template_repo;
            elsif v_repo_record.repo_mode = 'fork_from_prior_assignment' then
                v_sync_strategy := 'fork_merge_upstream';
                -- Match the student's or group's prior-assignment repo. Group repos
                -- are matched via assignment_group_id directly (group rows live on
                -- both assignments under different group ids but with the same name —
                -- we resolve by name here to mirror the create-time mapping).
                if v_repo_record.assignment_group_id is not null then
                    select prior_r.repository into v_upstream_repo_full_name
                    from public.repositories prior_r
                    join public.assignment_groups prior_ag on prior_ag.id = prior_r.assignment_group_id
                    join public.assignment_groups this_ag on this_ag.id = v_repo_record.assignment_group_id
                    where prior_r.assignment_id = v_repo_record.source_assignment_id
                      and prior_ag.name = this_ag.name
                    limit 1;
                else
                    select prior_r.repository into v_upstream_repo_full_name
                    from public.repositories prior_r
                    where prior_r.assignment_id = v_repo_record.source_assignment_id
                      and prior_r.profile_id = v_repo_record.profile_id
                    limit 1;
                end if;
            else
                -- template_only_staff (or any future repo-bearing mode without a
                -- direct fork relationship) — keep the existing template_pr flow.
                v_sync_strategy := 'template_pr';
            end if;

            -- Is a sync for this repository at this revision already queued or running?
            --
            -- Asked of pgmq's own queue table, and of every message in it whether the worker can
            -- currently see it or not: a message whose visibility timeout has it hidden is a
            -- message being worked on right now, which is precisely the one a second job must
            -- not join. The row appears in this transaction when the claim is made and is gone
            -- when the worker archives it, which happens after the terminal write -- so the
            -- claim covers the job's whole life without a timestamp to expire or renew.
            --
            -- Every queue a sync can be on, whichever engine the switch currently names: the
            -- other engine's queue can still hold a job queued before the switch last moved.
            -- async_calls_low_priority has never held a sync; it is scanned, matching
            -- `repo_ids_with_queued_create`, so that a routing change cannot silently turn the
            -- claim off. Shadow copies in handout_sync are not claims (see the migration header).
            --
            -- One scan per repository this call is considering, deliberately not one scan
            -- hoisted out of the loop: the answer has to be read AFTER `for update of r` has
            -- been granted, or a concurrent caller that started before this one committed would
            -- read a snapshot with no message in it and queue a duplicate -- the exact race the
            -- lock is here to stop. The table holds only unarchived messages, so each scan is
            -- over a live queue rather than a history.
            v_sync_already_queued := false;
            begin
                select exists (
                    select 1
                    from (
                        select q.message
                        from pgmq.q_async_calls q
                        where q.message ->> 'method' = 'sync_repo_to_handout'
                        union all
                        select q.message
                        from pgmq.q_async_calls_low_priority q
                        where q.message ->> 'method' = 'sync_repo_to_handout'
                        union all
                        select q.message
                        from pgmq.q_handout_sync q
                        where q.message ->> 'method' = 'sync_repo_to_handout'
                          and q.message -> 'shadow' is distinct from 'true'::jsonb
                    ) m
                    where m.message -> 'args' ->> 'repository_id' = v_repo_record.id::text
                      and m.message -> 'args' ->> 'to_sha' = v_repo_record.latest_template_sha
                ) into v_sync_already_queued;
            exception when others then
                -- See the header: an unreadable queue answers "nothing pending" rather than
                -- failing the repository, because a duplicate costs GitHub calls and a raise
                -- costs the instructor the ability to sync at all.
                v_sync_already_queued := false;
            end;

            if v_sync_already_queued then
                v_skipped_in_flight_count := v_skipped_in_flight_count + 1;
            elsif p_force or
               v_repo_record.desired_handout_sha is null or
               v_repo_record.desired_handout_sha <> v_repo_record.latest_template_sha or
               v_repo_record.sync_blocked_at is not null then

                -- sync_data is deliberately NOT written here. The message is the claim, so
                -- there is nothing to record, and writing a 'queued' status into it would
                -- replace the one the page is reading -- dropping a repository out of the
                -- "Sync Blocked" badge, and out of the list of files that explains it, at the
                -- exact moment an instructor pressed Sync to deal with them.
                --
                -- Reset explicitly rather than trusting an UPDATE that matches nothing to
                -- clear it: this runs once per repository in the loop, and a value left over
                -- from the previous one would read as a successful claim.
                v_claimed_id := null;

                update public.repositories
                set desired_handout_sha = v_repo_record.latest_template_sha
                where id = v_repo_record.id
                returning id into v_claimed_id;

                if v_claimed_id is null then
                    -- The row vanished between the read and the write. Nothing to queue, and
                    -- nothing that would tell a worker where to send it.
                    v_skipped_count := v_skipped_count + 1;
                else
                    v_message := jsonb_build_object(
                        'method', 'sync_repo_to_handout',
                        'args', jsonb_build_object(
                            'repository_id', v_repo_record.id,
                            'repository_full_name', v_repo_record.repository,
                            'template_repo', v_repo_record.template_repo,
                            'from_sha', v_repo_record.synced_handout_sha,
                            'to_sha', v_repo_record.latest_template_sha,
                            'assignment_title', v_repo_record.assignment_title,
                            'sync_strategy', v_sync_strategy,
                            'upstream_repo_full_name', v_upstream_repo_full_name
                        ),
                        'class_id', v_repo_record.class_id,
                        'repo_id', v_repo_record.id
                    );

                    perform pgmq_public.send(
                        case when v_route_git then 'handout_sync' else 'async_calls' end,
                        v_message
                    );

                    if v_send_shadow then
                        begin
                            perform pgmq_public.send(
                                'handout_sync',
                                v_message
                                    || jsonb_build_object('shadow', true)
                                    || jsonb_build_object('args', (v_message -> 'args')
                                        || jsonb_build_object('synced_repo_sha', v_repo_record.synced_repo_sha))
                            );
                        exception when others then
                            -- See the header: a shadow copy is an observation of the REST job,
                            -- and losing one must not cost the instructor the sync it observes.
                            -- The warning lands in the Postgres log, which is the only trace.
                            raise warning 'queue_repository_syncs: shadow copy for repository % not sent: %',
                                v_repo_record.id, sqlerrm;
                        end;
                    end if;

                    v_queued_count := v_queued_count + 1;
                end if;
            else
                v_skipped_count := v_skipped_count + 1;
            end if;
        exception when others then
            v_error_count := v_error_count + 1;
            v_errors := array_append(v_errors, jsonb_build_object(
                'repository_id', v_repo_record.id,
                'repository', v_repo_record.repository,
                'error', sqlerrm
            ));
        end;
    end loop;

    return jsonb_build_object(
        'success', true,
        'queued_count', v_queued_count,
        'skipped_count', v_skipped_count,
        'skipped_in_flight_count', v_skipped_in_flight_count,
        'error_count', v_error_count,
        'errors', v_errors
    );
end;
$$;

-- Grants as 20261015120000 left them. CREATE OR REPLACE keeps the existing ACL, so these restate
-- it rather than change it.
revoke all on function public.queue_repository_syncs(bigint[], boolean) from public, anon;
grant execute on function public.queue_repository_syncs(bigint[], boolean) to authenticated, service_role;

comment on function public.queue_repository_syncs is
    'Queue handout syncs for the given repositories. Instructors and admins only. Sends each sync to async_calls (REST engine) or handout_sync (git engine) as the system_settings row handout_sync_engine says; a missing or malformed row means async_calls. With {"engine":"rest","shadow":true} it also sends a plan-only copy marked "shadow": true to handout_sync. Locks each repository row and checks async_calls, async_calls_low_priority and handout_sync (ignoring shadow copies) for an unarchived sync_repo_to_handout message at the same revision, so a repository whose sync is already queued or running is reported under skipped_in_flight_count rather than queued a second time -- the message itself is the claim, so it needs no expiry and cannot park a repository. Pass p_force => true for a press the user made explicitly, which queues the repo whatever its recorded revision or block state says; the default also skips repos already at the assignment''s latest template sha.';

-- ---------------------------------------------------------------------------------------------
-- 5. delete_assignment_with_all_data
-- ---------------------------------------------------------------------------------------------
-- 20261016120000 made an assignment delete cancel the repositories' queued syncs and refuse while
-- one is running, after the 2026-10-15 incident in which 238 sync jobs were queued against
-- repositories an archive was tearing down. It finds those syncs by scanning async_calls and
-- async_calls_low_priority, and its comment states the invariant it depends on: every sync
-- queue_repository_syncs makes is visible to that scan. Section 4 sends syncs to handout_sync, so
-- without this change flipping the switch to git (a settings edit, no deploy) would silently turn
-- that protection off.
--
-- The body is copied from 20261016120000 with one more locked scan, over handout_sync. What counts
-- as RUNNING there:
--   * a claimed message, read_ct > 0 with vt in the future. With the git worker's heartbeat this is
--     exact for the whole life of a job, which on the edge path it is not (the 20261016 comment on
--     handlers that outlive their VT): the worker keeps pushing vt forward while the job runs, and
--     stops when the job or its pod ends.
--   * a message whose handler planted the in_progress marker. The git worker runs the same
--     processEnvelope handler, which writes the marker before any GitHub write, so this covers a
--     heartbeat that failed while the job kept going. msg_ids are per queue, so a marker left by an
--     async_calls job can equal a handout_sync msg_id for the same repository. That reads as
--     running and makes the delete refuse and be retried; it can never make it cancel a job that is
--     running.
--   * NOT the org-slot arm. handout_sync has no per-org lease (spec §10), so there is no slot to
--     consult, and the heartbeat makes it unnecessary.
--   * NEVER a shadow copy. A shadow run pushes nothing and writes nothing to the repository, so it
--     cannot damage a repository being archived, and refusing the delete for it would only make an
--     instructor wait. Shadow copies are cancelled whether or not a worker holds them. A worker that
--     already holds one gets nothing back from its heartbeat and its archive, which is the signal
--     that the message is gone.
--
-- Grants and the function comment are restated from 20261016120000 unchanged.
--
-- REVIEW NOTE. Against 20261016120000 the only differences are: the v_handout_sync_msg_ids
-- variable, the git_q CTE, its terms in the final SELECT, the pgmq.delete on handout_sync, and the
-- comment above the scan.
CREATE OR REPLACE FUNCTION public.delete_assignment_with_all_data(
    p_assignment_id bigint,
    p_class_id bigint,
    p_enqueue_github_archives boolean DEFAULT false,
    p_expected_repository_ids bigint[] DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_assignment_title text;
    v_template_repo text;
    v_grader_repo text;
    v_assignment_group_ids bigint[];
    v_gradebook_column_id bigint;
    v_repository_ids bigint[];
    v_repository_names text[];
    v_github_repositories jsonb := '[]'::jsonb;
    v_target record;
    v_index integer := 0;
    v_archives_queued integer := 0;
    v_sync_msg_ids bigint[];
    v_low_priority_sync_msg_ids bigint[];
    v_handout_sync_msg_ids bigint[];
    v_syncs_in_flight integer := 0;
    v_syncs_cancelled integer := 0;
BEGIN
    -- Only service_role and postgres may call this (see the REVOKE below); authorization of
    -- the human behind the request is the calling edge function's job.

    -- Check if assignment exists and belongs to the specified class
    SELECT title, template_repo INTO v_assignment_title, v_template_repo
    FROM public.assignments
    WHERE id = p_assignment_id AND class_id = p_class_id FOR UPDATE; -- Lock the assignment row

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment not found or does not belong to this class'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Check for released submission reviews (safety check)
    IF EXISTS (
        SELECT 1 FROM public.submission_reviews sr
        JOIN public.submissions s ON sr.submission_id = s.id
        WHERE s.assignment_id = p_assignment_id AND sr.released = true
    ) THEN
        RAISE EXCEPTION 'Cannot delete assignment: This assignment has released submission reviews. Delete cannot proceed.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Read before the autograder row is deleted below.
    SELECT grader_repo INTO v_grader_repo FROM public.autograder WHERE id = p_assignment_id;

    -- Lock this assignment's repository rows before looking at the queue. The only producer of
    -- handout syncs, queue_repository_syncs, locks the same rows (`FOR UPDATE OF r`, ordered by
    -- id, as here) before it enqueues. So a sync press either committed before this point, and
    -- its message is visible to the scan below, or it waits here and, once this transaction
    -- commits, finds the rows deleted and queues nothing. Without this lock it could enqueue
    -- after the scan and a worker could start on a repository this delete is about to archive.
    SELECT array_agg(id ORDER BY id) INTO v_repository_ids
      FROM (
        SELECT id FROM public.repositories
         WHERE assignment_id = p_assignment_id
         ORDER BY id
         FOR UPDATE
      ) locked;

    -- The repositories the caller ran its safety checks on (that each holds only template
    -- commits). A row created since then, e.g. by a repository-creation job that committed in
    -- between, has not been checked, and this call would archive it or, on the synchronous
    -- path, the edge function would DELETE it from GitHub, student work included. Now that the
    -- rows are locked the set cannot change, so compare it and let the caller re-check.
    IF p_expected_repository_ids IS NOT NULL
       AND COALESCE(v_repository_ids, ARRAY[]::bigint[])
           IS DISTINCT FROM COALESCE(ARRAY(SELECT DISTINCT u FROM unnest(p_expected_repository_ids) u ORDER BY u), ARRAY[]::bigint[])
    THEN
        RAISE EXCEPTION 'Cannot delete assignment: its repositories changed while the delete was being checked. Try again.'
            USING ERRCODE = 'serialization_failure';
    END IF;

    -- Handout syncs already queued for those repositories, on every queue a sync can be on:
    -- async_calls and async_calls_low_priority (the edge worker) and handout_sync (the git
    -- worker, 20261109120000, whose running test is different and is described at git_q).
    -- An unclaimed one would write a sync branch into a repository that is about to be
    -- archived, so it is cancelled. A RUNNING one (defined below) cannot be
    -- stopped from here: deleting its queue row does not stop the worker holding the envelope,
    -- which may be past its row check and mutating GitHub. So the delete refuses and the
    -- caller retries once it finishes. FOR UPDATE keeps the answer true for the rest of this
    -- transaction, because pgmq.read claims with FOR UPDATE SKIP LOCKED. (read_ct = 0 with a
    -- future vt is a delayed requeue, not a claim.)
    --
    -- The refusal applies only to a caller that leaves GitHub cleanup to this function. A
    -- caller passing p_enqueue_github_archives = false is an assignment-delete from before this
    -- migration, which has ALREADY committed its archive jobs: refusing it would leave those
    -- jobs archiving an assignment that stays live, the very failure this migration fixes. It
    -- gets the old behaviour (delete, cancel only what is not running) during the rollout.
    IF v_repository_ids IS NOT NULL THEN
        -- What counts as RUNNING, not merely queued:
        --   * a claimed message: read_ct > 0 and still invisible; or
        --   * a message whose handler has planted its marker on the repository row. A handler
        --     that outlives its visibility timeout (a batch of 4 has been measured at ~420s
        --     against the chart's 300s default) has a message that LOOKS unclaimed again while
        --     its worker is still mutating GitHub. Before any GitHub write the handler sets
        --     sync_data = {status: in_progress, msg_id, ...} and overwrites it when it ends,
        --     so the marker lasts exactly as long as the handler. Only markers whose message is
        --     still in the queue count: one whose message has left it (archived when the
        --     handler ended, dead-lettered, or replaced by a requeue under a new msg_id) is
        --     stale, so a crashed worker cannot pin an assignment for good.
        --   * a message some worker has read (read_ct > 0) while a drain lease for its org is
        --     live. The marker is one value per repository, so two overlapping handlers for the
        --     same repository (H2 and H3: queue_repository_syncs serializes nothing per
        --     repository) share it, and the newer one can overwrite and then clear it while the
        --     older one, past its timeout, is still running. What does last for every handler is
        --     the org slot it runs under: a leaseholder renews async_worker_slots while it works
        --     and releases it only after every in-flight message finishes. The org is the one
        --     the slot allocator charges a sync to (claim_org_slot_and_read,
        --     20260914120000_async_lease_pin_org.sql): the owner in args.repository_full_name,
        --     lowercased, on the same queue. No new handler can pick these messages up while
        --     this transaction holds them, so a live slot means one that already has may still
        --     be running. It is coarse (any work for the org keeps the slot live), so it is
        --     applied only to messages that have been read at least once.
        --     With org slots disabled (orgSlotGlobalCap 0, the chart default) there is no lease
        --     to consult and this arm never fires; production runs with them enabled.
        -- The window before the marker is written needs no check: the worker plants it with a
        -- guarded UPDATE of these repository rows, which this transaction holds locked; after
        -- the commit that UPDATE matches nothing and the worker drops the job without touching
        -- GitHub (retireStaleSync: "the repository row is gone").
        --
        -- One locked scan per queue (FOR UPDATE is not allowed under UNION, but is in a CTE).
        WITH markers AS (
            -- CASE, not a WHERE conjunct: SQL does not promise to test the pattern before
            -- the cast, and a malformed marker must be ignored rather than fail the delete.
            SELECT CASE WHEN sync_data->>'msg_id' ~ '^[0-9]{1,18}$' THEN (sync_data->>'msg_id')::bigint END AS msg_id
              FROM public.repositories
             WHERE id = ANY (v_repository_ids)
               AND sync_data->>'status' = 'in_progress'
        ), main_q AS (
            SELECT q.msg_id,
                   (q.read_ct > 0 AND q.vt > clock_timestamp())
                   OR q.msg_id IN (SELECT msg_id FROM markers)
                   OR (q.read_ct > 0 AND EXISTS (
                         SELECT 1 FROM public.async_worker_slots sl
                          WHERE sl.queue_name = 'async_calls'
                            AND sl.org = lower(split_part(q.message->'args'->>'repository_full_name', '/', 1))
                            AND sl.expires_at > clock_timestamp())) AS running
              FROM pgmq.q_async_calls q
             WHERE q.message->>'method' = 'sync_repo_to_handout'
               AND q.message->'args'->>'repository_id' = ANY (v_repository_ids::text[])
               FOR UPDATE OF q
        ), low_q AS (
            SELECT q.msg_id,
                   (q.read_ct > 0 AND q.vt > clock_timestamp())
                   OR q.msg_id IN (SELECT msg_id FROM markers)
                   OR (q.read_ct > 0 AND EXISTS (
                         SELECT 1 FROM public.async_worker_slots sl
                          WHERE sl.queue_name = 'async_calls_low_priority'
                            AND sl.org = lower(split_part(q.message->'args'->>'repository_full_name', '/', 1))
                            AND sl.expires_at > clock_timestamp())) AS running
              FROM pgmq.q_async_calls_low_priority q
             WHERE q.message->>'method' = 'sync_repo_to_handout'
               AND q.message->'args'->>'repository_id' = ANY (v_repository_ids::text[])
               FOR UPDATE OF q
        ), git_q AS (
            -- The git worker's queue (20261109120000). Its heartbeat keeps vt in the future for
            -- as long as a job runs, so a claimed message is a running one and there is no org
            -- slot to consult; the marker arm still covers a heartbeat that failed mid-job. A
            -- shadow copy pushes nothing and writes nothing to the repository, so it is never
            -- running and is always cancelled.
            SELECT q.msg_id,
                   q.message->'shadow' IS DISTINCT FROM 'true'::jsonb
                   AND ((q.read_ct > 0 AND q.vt > clock_timestamp())
                        OR q.msg_id IN (SELECT msg_id FROM markers)) AS running
              FROM pgmq.q_handout_sync q
             WHERE q.message->>'method' = 'sync_repo_to_handout'
               AND q.message->'args'->>'repository_id' = ANY (v_repository_ids::text[])
               FOR UPDATE OF q
        )
        SELECT (SELECT array_agg(msg_id) FROM main_q WHERE NOT running),
               (SELECT array_agg(msg_id) FROM low_q WHERE NOT running),
               (SELECT array_agg(msg_id) FROM git_q WHERE NOT running),
               (SELECT count(*) FROM main_q WHERE running) + (SELECT count(*) FROM low_q WHERE running)
                 + (SELECT count(*) FROM git_q WHERE running)
          INTO v_sync_msg_ids, v_low_priority_sync_msg_ids, v_handout_sync_msg_ids, v_syncs_in_flight;

        IF v_syncs_in_flight > 0 AND p_enqueue_github_archives THEN
            RAISE EXCEPTION 'Cannot delete assignment: % handout sync(s) for its repositories are running right now. Try again in a few minutes.',
                v_syncs_in_flight
                USING ERRCODE = 'object_in_use';
        END IF;

        IF v_sync_msg_ids IS NOT NULL THEN
            SELECT count(*) INTO v_syncs_cancelled FROM pgmq.delete('async_calls', v_sync_msg_ids);
        END IF;
        IF v_low_priority_sync_msg_ids IS NOT NULL THEN
            v_syncs_cancelled := v_syncs_cancelled
                + (SELECT count(*) FROM pgmq.delete('async_calls_low_priority', v_low_priority_sync_msg_ids));
        END IF;
        IF v_handout_sync_msg_ids IS NOT NULL THEN
            v_syncs_cancelled := v_syncs_cancelled
                + (SELECT count(*) FROM pgmq.delete('handout_sync', v_handout_sync_msg_ids));
        END IF;
    END IF;

    -- Get assignment group IDs for this assignment
    SELECT array_agg(id) INTO v_assignment_group_ids
    FROM public.assignment_groups
    WHERE assignment_id = p_assignment_id;

    -- Get the gradebook column ID for this assignment
    SELECT gradebook_column_id INTO v_gradebook_column_id
    FROM public.assignments
    WHERE id = p_assignment_id;

    -- Start transaction
    BEGIN
        -- Remove gradebook column dependencies first (if this assignment has a gradebook column)
        IF v_gradebook_column_id IS NOT NULL THEN
            UPDATE public.gradebook_columns
            SET dependencies = jsonb_set(
                COALESCE(dependencies, '{}'::jsonb),
                '{gradebook_columns}',
                to_jsonb(
                    array_remove(
                        ARRAY(SELECT jsonb_array_elements_text(COALESCE(dependencies->'gradebook_columns', '[]'::jsonb)))::bigint[],
                        v_gradebook_column_id
                    )
                )
            )
            WHERE class_id = p_class_id
              AND id != v_gradebook_column_id
              AND dependencies IS NOT NULL
              AND dependencies->'gradebook_columns' IS NOT NULL
              AND dependencies->'gradebook_columns' @> to_jsonb(ARRAY[v_gradebook_column_id]::bigint[]);
        END IF;

        -- Delete in order to respect foreign key constraints

        -- Delete submission regrade request comments
        DELETE FROM public.submission_regrade_request_comments srrc
        USING public.submission_regrade_requests srr
        WHERE srrc.submission_regrade_request_id = srr.id AND srr.assignment_id = p_assignment_id;

        -- Handle circular FK constraints: clear regrade_request_id references first
        UPDATE public.submission_comments
        SET regrade_request_id = NULL
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );

        UPDATE public.submission_file_comments
        SET regrade_request_id = NULL
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );

        UPDATE public.submission_artifact_comments
        SET regrade_request_id = NULL
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );

        -- Delete submission regrade requests (now safe after clearing circular FK)
        DELETE FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id;

        -- Delete submission artifact comments first (before submission artifacts)
        DELETE FROM public.submission_artifact_comments sac
        USING public.submission_artifacts sa
        JOIN public.submissions s ON sa.submission_id = s.id
        WHERE sac.submission_artifact_id = sa.id AND s.assignment_id = p_assignment_id;

        -- Delete submission artifacts (before submission files due to FK constraint)
        DELETE FROM public.submission_artifacts sa
        USING public.submissions s
        WHERE sa.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Delete submission file comments
        DELETE FROM public.submission_file_comments sfc
        USING public.submission_files sf
        JOIN public.submissions s ON sf.submission_id = s.id
        WHERE sfc.submission_file_id = sf.id AND s.assignment_id = p_assignment_id;

        -- Delete submission files
        DELETE FROM public.submission_files sf
        USING public.submissions s
        WHERE sf.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Delete submission comments (only those that don't reference regrade requests)
        DELETE FROM public.submission_comments sc
        USING public.submissions s
        WHERE sc.submission_id = s.id AND s.assignment_id = p_assignment_id
          AND sc.regrade_request_id IS NULL;

        -- Delete grader result test output first (before grader result tests)
        DELETE FROM public.grader_result_test_output grto
        USING public.grader_result_tests grt
        JOIN public.grader_results gr ON grt.grader_result_id = gr.id
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grto.grader_result_test_id = grt.id AND s.assignment_id = p_assignment_id;

        -- Delete grader result tests (before grader results)
        DELETE FROM public.grader_result_tests grt
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grt.grader_result_id = gr.id AND s.assignment_id = p_assignment_id;

        -- Delete grader result output (before grader results)
        DELETE FROM public.grader_result_output gro
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE gro.grader_result_id = gr.id AND s.assignment_id = p_assignment_id;

        -- Delete grader results
        DELETE FROM public.grader_results gr
        USING public.submissions s
        WHERE gr.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Clear grading_review_id references before deleting submission reviews
        UPDATE public.submissions
        SET grading_review_id = NULL
        WHERE assignment_id = p_assignment_id AND grading_review_id IS NOT NULL;

        -- Delete review assignments (before submission reviews due to FK constraint)
        DELETE FROM public.review_assignments WHERE assignment_id = p_assignment_id;

        -- Delete submission reviews
        DELETE FROM public.submission_reviews sr
        USING public.submissions s
        WHERE sr.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Delete submissions
        DELETE FROM public.submissions WHERE assignment_id = p_assignment_id;

        -- Delete repository check runs (before repositories due to FK constraint)
        DELETE FROM public.repository_check_runs rcr
        USING public.repositories r
        WHERE rcr.repository_id = r.id AND r.assignment_id = p_assignment_id;

        -- Delete workflow events that reference repositories for this assignment
        DELETE FROM public.workflow_events we
        USING public.repositories r
        WHERE we.repository_id = r.id AND r.assignment_id = p_assignment_id;

        -- Delete workflow run errors that reference repositories for this assignment
        DELETE FROM public.workflow_run_error wre
        USING public.repositories r
        WHERE wre.repository_id = r.id AND r.assignment_id = p_assignment_id;

        -- Delete repositories, keeping exactly what was removed: these are the GitHub targets.
        WITH deleted AS (
            DELETE FROM public.repositories WHERE assignment_id = p_assignment_id
            RETURNING id, repository
        )
        SELECT array_agg(id ORDER BY id), array_agg(repository ORDER BY id)
          INTO v_repository_ids, v_repository_names
          FROM deleted;

        -- Delete assignment group members
        DELETE FROM public.assignment_groups_members WHERE assignment_id = p_assignment_id;

        -- Delete assignment group invitations for this assignment's groups
        IF v_assignment_group_ids IS NOT NULL AND array_length(v_assignment_group_ids, 1) > 0 THEN
            DELETE FROM public.assignment_group_invitations
            WHERE assignment_group_id = ANY(v_assignment_group_ids);
        END IF;

        -- Delete assignment group join requests
        DELETE FROM public.assignment_group_join_request WHERE assignment_id = p_assignment_id;

        -- Delete assignment groups
        DELETE FROM public.assignment_groups WHERE assignment_id = p_assignment_id;

        -- Delete due date exceptions
        DELETE FROM public.assignment_due_date_exceptions WHERE assignment_id = p_assignment_id;

        -- Clear rubric references in assignments before deleting rubrics
        UPDATE public.assignments
        SET grading_rubric_id = NULL,
            meta_grading_rubric_id = NULL,
            self_review_rubric_id = NULL
        WHERE id = p_assignment_id AND (
            grading_rubric_id IS NOT NULL OR
            meta_grading_rubric_id IS NOT NULL OR
            self_review_rubric_id IS NOT NULL
        );

        -- Delete rubric-related data (in dependency order)
        DELETE FROM public.rubric_checks rc
        USING public.rubric_criteria rcrit
        JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
        JOIN public.rubrics r ON rp.rubric_id = r.id
        WHERE rc.rubric_criteria_id = rcrit.id AND r.assignment_id = p_assignment_id;

        DELETE FROM public.rubric_criteria rcrit
        USING public.rubric_parts rp
        JOIN public.rubrics r ON rp.rubric_id = r.id
        WHERE rcrit.rubric_part_id = rp.id AND r.assignment_id = p_assignment_id;

        DELETE FROM public.rubric_parts rp
        USING public.rubrics r
        WHERE rp.rubric_id = r.id AND r.assignment_id = p_assignment_id;

        DELETE FROM public.rubrics WHERE assignment_id = p_assignment_id;

        -- Delete assignment handout commits (before assignment due to FK constraint)
        DELETE FROM public.assignment_handout_commits WHERE assignment_id = p_assignment_id;

        -- Delete autograder commits (before autograder due to FK constraint)
        DELETE FROM public.autograder_commits ac
        USING public.autograder a
        WHERE ac.autograder_id = a.id AND a.id = p_assignment_id;

        -- Delete autograder regression tests (before autograder due to FK constraint)
        DELETE FROM public.autograder_regression_test art
        USING public.autograder a
        WHERE art.autograder_id = a.id AND a.id = p_assignment_id;

        -- Delete autograder if exists
        DELETE FROM public.autograder WHERE id = p_assignment_id;

        -- Delete gradebook column students (before gradebook column due to FK constraint)
        IF v_gradebook_column_id IS NOT NULL THEN
            DELETE FROM public.gradebook_column_students
            WHERE gradebook_column_id = v_gradebook_column_id;
        END IF;

        -- Delete gradebook column (using the assignment's gradebook_column_id)
        DELETE FROM public.gradebook_columns
        WHERE id = (SELECT gradebook_column_id FROM public.assignments WHERE id = p_assignment_id);

        -- Finally, delete the assignment itself
        DELETE FROM public.assignments
        WHERE id = p_assignment_id AND class_id = p_class_id;

        -- GitHub targets: students, then template, then solution, deduplicated case-insensitively
        -- and limited to well-formed owner/repo names, matching collectGitHubRepoTargets in
        -- supabase/functions/assignment-delete/repositoryCleanup.ts. Malformed student names are
        -- skipped; the edge function rejects a malformed template/solution before calling.
        FOR v_target IN
            -- Parsed exactly like parseGitHubRepoFullName: trim ASCII spaces, split on '/', require
            -- exactly two parts, trim each, and require GitHub's name characters in both. "Org /
            -- repo" is Org/repo on both sides; a tab, newline or non-breaking space is invalid on
            -- both sides. Any difference would let the edge function validate a target that this
            -- loop drops or queues malformed.
            WITH raw AS (
                SELECT 'student'::text AS kind, name AS value, ord AS ord
                  FROM unnest(COALESCE(v_repository_names, ARRAY[]::text[])) WITH ORDINALITY AS u(name, ord)
                UNION ALL SELECT 'template', v_template_repo, 1000000001
                UNION ALL SELECT 'solution', v_grader_repo, 1000000002
            ), parts AS (
                SELECT kind, ord, string_to_array(btrim(value, ' '), '/') AS p
                  FROM raw WHERE btrim(value, ' ') <> ''
            ), parsed AS (
                SELECT kind, ord, btrim(p[1], ' ') AS org, btrim(p[2], ' ') AS repo
                  FROM parts WHERE cardinality(p) = 2
            ), valid AS (
                SELECT kind, ord, org, repo, org || '/' || repo AS full_name,
                       row_number() OVER (PARTITION BY lower(org || '/' || repo) ORDER BY ord) AS dup
                  FROM parsed
                 WHERE org ~ '^[A-Za-z0-9._-]+$' AND repo ~ '^[A-Za-z0-9._-]+$'
            )
            SELECT kind, full_name, org, repo
              FROM valid WHERE dup = 1 ORDER BY ord
        LOOP
            v_github_repositories := v_github_repositories
                || jsonb_build_object('kind', v_target.kind, 'full_name', v_target.full_name);
            IF p_enqueue_github_archives THEN
                -- Same debug_id shape as buildAssignmentDeleteArchiveDebugId.
                PERFORM public.enqueue_github_archive_repo(
                    p_class_id,
                    v_target.org,
                    v_target.repo,
                    format('assignment-delete-%s-%s-%s-%s', p_assignment_id, v_target.kind, v_index + 1,
                           left(regexp_replace(v_target.repo, '[^a-zA-Z0-9_.-]+', '-', 'g'), 80))
                );
                v_archives_queued := v_archives_queued + 1;
            END IF;
            v_index := v_index + 1;
        END LOOP;

        RETURN jsonb_build_object(
            'success', true,
            'message', format('Assignment "%s" has been successfully deleted along with all related data.', v_assignment_title),
            'assignment_id', p_assignment_id,
            'class_id', p_class_id,
            'github_repositories', v_github_repositories,
            'github_archives_queued', v_archives_queued,
            'handout_syncs_cancelled', v_syncs_cancelled
        );

    EXCEPTION
        WHEN OTHERS THEN
            RAISE;
    END;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint, boolean, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint, boolean, bigint[]) TO service_role, postgres;

COMMENT ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint, boolean, bigint[]) IS
  'Deletes an assignment and all its associated data in one transaction. With p_enqueue_github_archives, also queues archive_repo_and_lock for every deleted repository plus the template and grader repos, so GitHub cleanup commits or rolls back with the delete. Locks the repositories and cancels their queued sync_repo_to_handout jobs on async_calls, async_calls_low_priority and handout_sync, refusing (55006) while one is running (claimed, or an in_progress marker whose message is still queued; shadow copies never count as running). Returns the GitHub targets it removed. false = legacy caller that queued its own archives. service_role/postgres only.';

-- ---------------------------------------------------------------------------------------------
-- 6. handout_sync_shadow_results
-- ---------------------------------------------------------------------------------------------
-- One row per shadow run: the inputs the run was given (from the message, so from the moment the
-- sync was queued), and what the git engine would have built from them. The S2/S4 comparison reads
-- the tree of the commit the REST path actually pushed for (repository_id, to_sha) and diffs it
-- against predicted_tree. unresolved is the list of paths the engine would leave to the student;
-- error is set instead when the plan itself failed.
--
-- msg_id is the handout_sync message the run came from, and it is unique: the worker writes with
-- `insert ... on conflict (msg_id) do nothing`, so a shadow message that is redelivered (its pod died
-- after the insert but before the archive) cannot record a second prediction for the same sync.
--
-- NO FOREIGN KEY TO repositories, deliberately. Foreign keys into repositories are NO ACTION, never
-- CASCADE, so that a delete path which misses a child table fails rather than destroying graded
-- work (fail-safe deletes, PR #1175 and scripts/CheckDeletePaths.ts there). A NO ACTION key here
-- would make every repository delete path (delete_repository_rows,
-- cleanup_individual_repositories_for_assignment, delete_assignment_with_all_data, and the
-- direct deletes #1175 replaces) fail with 23503 for any repository that was ever shadowed, until
-- each one was taught to clear this table, all to protect rows that are diagnostic output and
-- worth nothing once their repository is gone. A CASCADE key is the thing the rule forbids. With no
-- key, deleting a repository never touches or trips on this table, and a shadow row for a deleted
-- repository is a harmless orphan the comparison skips because its join to repositories finds
-- nothing. Nothing reads these rows except that comparison, and the whole table goes away with the
-- REST path in Phase 3.
--
-- service_role only. RLS is on with no policies, so anon and authenticated see nothing even if a
-- grant were added by mistake; service_role bypasses RLS. Supabase's default privileges grant
-- anon and authenticated full access to new tables in public, so those are revoked explicitly.
create table if not exists public.handout_sync_shadow_results (
    id bigint generated always as identity primary key,
    msg_id bigint not null,
    repository_id bigint not null,
    to_sha text not null,
    from_sha text,
    synced_repo_sha text,
    predicted_tree text,
    predicted_commit_parent text,
    unresolved jsonb,
    error text,
    created_at timestamptz not null default now(),
    constraint handout_sync_shadow_results_msg_id_key unique (msg_id)
);

create index if not exists handout_sync_shadow_results_repository_to_sha_idx
    on public.handout_sync_shadow_results (repository_id, to_sha);

alter table public.handout_sync_shadow_results enable row level security;

revoke all on table public.handout_sync_shadow_results from public, anon, authenticated;
grant select, insert, delete on table public.handout_sync_shadow_results to service_role;

comment on table public.handout_sync_shadow_results is
    'What the git handout-sync engine would have built for a sync the REST path ran, recorded by '
    'plan-only shadow runs (system_settings handout_sync_engine shadow=true). from_sha and '
    'synced_repo_sha are the inputs as read when the sync was queued. msg_id (the handout_sync '
    'message) is unique, so a redelivered shadow message cannot add a second row: insert with '
    'on conflict (msg_id) do nothing. No foreign key to repositories '
    'on purpose: these are diagnostic rows and must not block or be removed by a repository delete. '
    'service_role only.';
