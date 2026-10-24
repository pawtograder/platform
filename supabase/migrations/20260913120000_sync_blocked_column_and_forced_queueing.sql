-- Give a sync that ended needing a person a durable record to retry from, and let an
-- instructor's press always queue.
--
-- WHY A COLUMN. 20260911030000 made queue_repository_syncs enqueue a repo whose
-- `sync_data ->> 'status'` reads 'blocked_by_student_changes', because desired_handout_sha has
-- already been raised to the latest template sha by the time the block is recorded and so can
-- no longer queue anything. The field it chose is one the worker itself overwrites on every
-- attempt: 'in_progress' before the long work, 'error' from the catch. A repo blocked at X whose
-- retry is killed mid-flight — the isolate hits the memory limit, GitHub 502s — ends with
-- desired_handout_sha equal to the latest sha and a status of 'error'. Neither clause matches,
-- so every future press reports the repo up to date and queues nothing. That is the same trap
-- that migration was written to close, one attempt further along, and nothing an instructor
-- can see says so.
--
-- sync_blocked_at means "this sync ended needing a person", and every outcome of that shape
-- writes it. Two exist. One is the blocked outcome above: the handout held something new and
-- every changed file is the student's own work, so nothing could be written. The other is a
-- terminal failure — sync_branch_not_ours (a student is resolving the update by hand on the
-- sync branch), sync_branch_moved, sync_tree_too_large — which fails identically on every
-- attempt until somebody changes the situation. Both leave a repo behind the handout with
-- desired_handout_sha already raised, which is the state the enqueue condition could not see;
-- a column that covered only the first would leave the second reachable by p_force alone,
-- invisible to the autograder toggle, which would then report an assignment fully propagated
-- while a repository still holds the wrong workflow.
--
-- It is cleared only by an outcome that delivered something (merged, PR opened, nothing to
-- deliver). An interrupted attempt leaves it exactly as it was, so the repo stays queueable
-- however many times a retry dies. sync_data keeps carrying the display status, and nothing
-- durable depends on it any more.
--
-- Nothing can loop on this. queue_repository_syncs is the only producer of
-- sync_repo_to_handout jobs in the entire system — no trigger, no cron job, no webhook path
-- reaches it — and it opens with an auth.uid() check, so every job exists because a person
-- asked for one. A repository that keeps ending this way costs one job per press.
--
-- WHY p_force. Every caller of this function is a human action: the Sync button on the
-- repositories page (single and bulk), and the autograder toggle, which forwards the
-- instructor's own Authorization header — the body opens with `if auth.uid() is null then raise
-- exception`, so nothing automated can reach it. A press that reports "0 queued, 1 skipped
-- (already up to date)" for a repo the instructor can see is behind is the failure mode people
-- actually hit, and no state machine we get wrong should be able to produce it. p_force defaults
-- to false so the toggle path keeps skipping repos already at the target revision, which is what
-- keeps it from queueing one job per repo in a 1000-student course on every flip.
--
-- Adding a defaulted argument to the existing signature would leave both resolvable and make
-- every named call ambiguous ("function is not unique"), so the one-argument form is dropped and
-- replaced rather than re-created.

alter table public.repositories
    add column if not exists sync_blocked_at timestamptz,
    add column if not exists sync_block_reason text;

comment on column public.repositories.sync_blocked_at is
    'Set when a handout sync ended needing a person: every changed file was the student''s own work, or the sync failed terminally (sync_branch_not_ours, sync_branch_moved, sync_tree_too_large). Cleared by the next sync that delivers something. queue_repository_syncs treats a non-null value as "queue this repo whatever desired_handout_sha says", so the retry survives an attempt that dies mid-flight.';

comment on column public.repositories.sync_block_reason is
    'Human-readable reason recorded alongside sync_blocked_at, naming what a person has to do. On a terminal failure it is prefixed with the reason code. Where the student''s own changes blocked the sync, the paths themselves live in sync_data.unresolved_paths.';

-- Carry over the repos that are blocked right now, so swapping the enqueue condition below does
-- not silently drop the retry record for the rows that have it today. Only the student-changes
-- shape needs carrying: the terminal outcome is recorded for the first time by the change this
-- migration ships with, so no existing row can be in it.
update public.repositories
set sync_blocked_at = coalesce((sync_data ->> 'last_sync_attempt')::timestamptz, now()),
    sync_block_reason = 'Blocked by the student''s own changes to ' ||
        coalesce(jsonb_array_length(case
            when jsonb_typeof(sync_data -> 'unresolved_paths') = 'array' then sync_data -> 'unresolved_paths'
            else '[]'::jsonb
        end), 0)::text || ' file(s)'
where sync_blocked_at is null
  and sync_data ->> 'status' = 'blocked_by_student_changes';

-- synced_repo_sha is the repo-side commit the last sync produced, and it is the baseline the
-- conflict guard classifies against: a file that differs from it is the student's work. Rows that
-- merged a sync PR already recorded that commit in sync_data.merge_sha, so where the column is
-- null and that value is a real sha, the pair can be restored exactly. Every other null is left
-- alone — there is no value to derive, and inventing one would tell the guard that work it has
-- never seen is machine-written.
update public.repositories
set synced_repo_sha = sync_data ->> 'merge_sha'
where synced_repo_sha is null
  and sync_data ->> 'merge_sha' ~ '^[0-9a-f]{40}$';

drop function if exists public.queue_repository_syncs(bigint[]);

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

            if p_force or
               v_repo_record.desired_handout_sha is null or
               v_repo_record.desired_handout_sha <> v_repo_record.latest_template_sha or
               v_repo_record.sync_blocked_at is not null then

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

grant execute on function public.queue_repository_syncs(bigint[], boolean) to authenticated;

comment on function public.queue_repository_syncs is
    'Queue handout syncs for the given repositories. Instructors and admins only. Pass p_force => true for a press the user made explicitly, which queues the repo whatever its recorded state says; the default skips repos already at the assignment''s latest template sha.';
