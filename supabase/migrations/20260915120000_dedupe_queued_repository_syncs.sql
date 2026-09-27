-- Stop one repository from being queued twice while a sync for it is still running.
--
-- WHAT WAS WRONG. queue_repository_syncs read each repository, decided it was behind, raised
-- desired_handout_sha and sent a sync_repo_to_handout message -- and left every input to that
-- decision exactly as it found it. Nothing about the row said "a job for this is already in
-- flight", so a second call made a second identical decision. That is reachable three ways
-- and all three happen:
--
--   * 20260913120000 made a repository with sync_blocked_at set queueable whatever
--     desired_handout_sha says. The worker only clears that timestamp when a sync delivers
--     something, so until then EVERY call -- the per-row button, the bulk press, the
--     autograder toggle sweeping a whole assignment -- enqueues the same repository again.
--   * The repositories page re-enables its Sync button as soon as the RPC returns, which is
--     long before the job it queued has run.
--   * Two callers running at once read the row before either writes, so both queue.
--
-- Duplicate jobs for one repository are not harmless. They race on the same sync branch and
-- the same pull request: one resets the branch the other is committing onto, and they open,
-- close and reset each other's work. github-async-worker now refuses to WRITE a conclusion
-- that was computed against a revision the row has moved past, which stops a duplicate from
-- corrupting the recorded state, but it cannot stop the wasted GitHub work, and it cannot stop
-- the branch churn in the student's repository. The fix belongs where the duplicate is
-- created.
--
-- WHAT A CLAIM IS HERE. The queue message IS the claim, and the test is the exact question:
-- is there an unarchived sync_repo_to_handout message for this repository at this revision?
-- `repo_ids_with_queued_create` (20260816120000) asks the same thing for repository creation and
-- for the same reason, so this follows it: scan pgmq's own queue table, invisible messages
-- included, because a message being worked on right now is exactly the one that must not be
-- queued twice.
--
-- Reading the queue rather than mirroring its state into a column is what makes the claim
-- correct for the whole life of the job and not just the part we guessed at. A first attempt
-- wrote a timestamp into sync_data and treated it as live for fifteen minutes, which is shorter
-- than this queue's own worst case: the visibility timeout can be configured up to 1800s, a
-- message can wait behind a backlog, and pgmq redelivers up to ten times before the worker
-- dead-letters it. Any window long enough to cover that would park a repository for hours after
-- an isolate died; any window short enough not to would let a duplicate through. The message
-- row has neither problem. It appears the instant the claim is made -- in this transaction,
-- alongside the send -- and it disappears the instant the worker archives it, which happens
-- after the terminal write. There is nothing to expire, and nothing to renew.
--
-- A claim is per REVISION, because that is where the damage is: the sync branch is named
-- `sync-to-<sha7>`, so two jobs for one revision reset and commit to the same branch and open,
-- close and reset each other's pull request, while jobs for different revisions use different
-- branches and are not in each other's way. Matching on the message's own `to_sha` gets this
-- for free. It also keeps the case that made the first attempt wrong:
-- assignment-sync-autograder-workflow edits grade.yml in the handout and then queues every
-- repository in the assignment, and nothing else ever queues them, so a repository whose
-- in-flight sync was already heading somewhere older has to be queued, not counted as busy.
--
-- skipped_in_flight_count is reported separately from skipped_count, because "a sync is already
-- running" and "this repository is already up to date" are different answers and only one of
-- them means the instructor has nothing to wait for.
--
-- AN UNREADABLE QUEUE MUST NOT STOP AN INSTRUCTOR. The scan is wrapped in its own exception
-- block: if pgmq's table cannot be read, the answer is "nothing is pending", which is the
-- behavior this function had before the check existed. A duplicate job wastes GitHub calls and
-- has its write discarded by the worker's revision guard; a queueing path that raises instead
-- leaves an instructor unable to sync at all.
--
-- WHY p_force DOES NOT SKIP IT. p_force exists so a press always queues a repository whose
-- recorded state we got wrong; it is not a reason to run two syncs of one repository at once,
-- which is the thing that damages the branch. A forced call still ignores desired_handout_sha
-- and sync_blocked_at -- everything it was added for -- and still declines to pile a second job
-- for the same revision onto one that is already queued or running. The press is not lost: the
-- answer names the reason, the message it waited on is one the worker is already going to run,
-- and a press made after the handout moves is a different revision and queues immediately.

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

    if not exists (
        select 1 from public.user_privileges up
        where up.user_id = auth.uid()
          and (up.role = 'admin' or (up.class_id = v_class_id and up.role = 'instructor'))
    ) then
        raise exception 'Only instructors can queue repository syncs';
    end if;

    for v_repo_record in
        select
            r.id,
            r.repository,
            r.profile_id,
            r.assignment_group_id,
            r.synced_handout_sha,
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
            -- Both queues, matching `repo_ids_with_queued_create`. Syncs are only ever sent to
            -- async_calls today, and a routing change should not be able to silently turn the
            -- claim off.
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
                    perform pgmq_public.send(
                        'async_calls',
                        jsonb_build_object(
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
                        )
                    );

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

grant execute on function public.queue_repository_syncs(bigint[], boolean) to authenticated;

comment on function public.queue_repository_syncs is
    'Queue handout syncs for the given repositories. Instructors and admins only. Locks each repository row and checks pgmq for an unarchived sync_repo_to_handout message at the same revision, so a repository whose sync is already queued or running is reported under skipped_in_flight_count rather than queued a second time -- the message itself is the claim, so it needs no expiry and cannot park a repository. Pass p_force => true for a press the user made explicitly, which queues the repo whatever its recorded revision or block state says; the default also skips repos already at the assignment''s latest template sha.';
