-- queue_repository_syncs: latest body from 20261106140000_assignments_save_by_capability.sql, with
-- Forgejo repositories left out and counted in skipped_forgejo_count.
--
-- sync_repo_to_handout only knows GitHub: it compares the handout and opens the pull request through
-- the GitHub API. A Forgejo repository passed every check here (assignment-create-handout-repo sets
-- latest_template_sha on a Forgejo handout, and the reconciler marks its repos is_github_ready), so a
-- Sync press queued a job that asked GitHub for a repository that only exists on Forgejo. Counted
-- rather than silently dropped, so the Repository Status page can say why nothing was queued.
CREATE OR REPLACE FUNCTION public.queue_repository_syncs(p_repository_ids bigint[], p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_class_id bigint;
    v_repo_record record;
    v_queued_count integer := 0;
    v_skipped_count integer := 0;
    v_skipped_in_flight_count integer := 0;
    v_skipped_forgejo_count integer := 0;
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

    -- Admins of any course, or holders of manage_assignments in this class (#1010): Edit Assignment
    -- queues these syncs through assignment-sync-autograder-workflow with the editor's own JWT.
    if not (
        exists (select 1 from public.user_privileges up where up.user_id = auth.uid() and up.role = 'admin')
        or v_class_id in (select public.user_class_ids_with_capability('manage_assignments'))
    ) then
        raise exception 'manage_assignments is required to queue repository syncs for class %', v_class_id;
    end if;

    -- Counted before the template and readiness filters below, so every Forgejo repository asked
    -- for is reported, not only the ones that would otherwise have been queued.
    select count(*) into v_skipped_forgejo_count
    from public.repositories r
    where r.id = any(p_repository_ids)
      and r.git_provider = 'forgejo';

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
          and r.git_provider <> 'forgejo'
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
        'skipped_forgejo_count', v_skipped_forgejo_count,
        'error_count', v_error_count,
        'errors', v_errors
    );
end;
$function$;
