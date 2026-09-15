-- Let an instructor retry a sync that was blocked by the student's own work.
--
-- THE TRAP. queue_repository_syncs enqueues a repo only when
-- `desired_handout_sha is null or desired_handout_sha <> latest_template_sha`, and it SETS
-- desired_handout_sha to latest_template_sha itself immediately before enqueueing. So once
-- a job has been queued for a revision, the condition that queued it is already false.
--
-- That is harmless for a sync that finishes, because it either merges (synced advances) or
-- leaves a PR open for the student (the PR is the thing to act on). It strands the outcome
-- added alongside this migration: a sync where every changed file is the student's own work
-- writes nothing, opens no PR, and reports blocked_by_student_changes. The repo is behind
-- the handout with nothing to click on, and pressing Sync again finds desired already equal
-- to the latest sha, enqueues nothing, and reports the repo up to date. It is stuck there
-- permanently, and nothing an instructor can see says so.
--
-- THE FIX. Enqueue a repo whose last sync says it is blocked, whatever desired_handout_sha
-- says. Pressing Sync then re-runs it, which is exactly what an instructor expects that
-- button to do after they have asked the student to deal with the conflict.
--
-- The alternative was to have the worker put desired_handout_sha back to the repo's current
-- synced_handout_sha, which needs no migration. It was rejected because that column is what
-- tells an instructor the repo is behind: setting it back makes a blocked repo read as up
-- to date, trading the visibility for the retry when the point is to have both.
--
-- Re-running a blocked sync is idempotent. It re-classifies, re-blocks, and overwrites the
-- same sync_data object, so nothing accumulates, and a student resolving the conflict makes
-- the next run take the ordinary path and clear the status.
--
-- Body is otherwise verbatim from 20260530120200_assignment-repo-config.sql, which is the
-- current definition; only the select list and the enqueue condition change.

create or replace function public.queue_repository_syncs(
    p_repository_ids bigint[]
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
    v_error_count integer := 0;
    v_errors jsonb[] := '{}';
    v_sync_strategy text;
    v_upstream_repo_full_name text;
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

            if v_repo_record.desired_handout_sha is null or
               v_repo_record.desired_handout_sha <> v_repo_record.latest_template_sha or
               v_repo_record.sync_data ->> 'status' = 'blocked_by_student_changes' then

                update public.repositories
                set desired_handout_sha = v_repo_record.latest_template_sha
                where id = v_repo_record.id;

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
        'error_count', v_error_count,
        'errors', v_errors
    );
end;
$$;
