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
-- WHAT A CLAIM IS HERE. The row is marked as queued in the SAME transaction as the send, so
-- there is no window between deciding and recording. A call that finds a fresh claim already
-- there does not queue, and says so: skipped_in_flight_count is reported separately from
-- skipped_count, because "a sync is already running" and "this repository is already up to
-- date" are different answers and only one of them means the instructor has nothing to wait
-- for.
--
-- A claim names the REVISION it is for, and only suppresses a job for that same revision. The
-- sync branch is `sync-to-<sha7>`, so it is jobs sharing a revision that fight over one branch
-- and one pull request; jobs for different revisions are not in each other's way, and
-- suppressing a newer one would leave the autograder toggle unable to deliver grade.yml to a
-- repository whose in-flight sync was already heading somewhere older.
--
-- WHY sync_data AND NOT A NEW COLUMN. The claim has to be released by the worker, and the
-- worker already replaces sync_data wholesale at every outcome it has -- in_progress before
-- the long work, then merged, blocked, no_changes_needed or error. So 'queued' is released by
-- the machinery that already exists, with nothing to remember to clear and no outcome that can
-- forget. A column would need every one of those writes to reset it, and the one that got
-- missed would park the repository. That is the opposite trade from sync_blocked_at, which
-- needed a column precisely BECAUSE the worker overwrites sync_data: a durable record has to
-- survive those writes, and a claim has to die with them.
--
-- WHY IT EXPIRES. An isolate killed mid-handler leaves 'in_progress' behind forever, and a
-- claim with no expiry would then make the repository permanently unqueueable -- the exact
-- failure 20260911030000 and 20260913120000 were written to close, re-entered through the
-- front door. So a claim only counts while it is fresh. Fifteen minutes is longer than a sync
-- takes (a batch's whole visibility timeout is 300s by default, 1800s at its configured
-- maximum) and short enough that a dead attempt costs one wait, not an instructor's afternoon.
-- Past that the repository queues again whatever sync_data says.
--
-- WHY p_force DOES NOT SKIP IT. p_force exists so a press always queues a repository whose
-- recorded state we got wrong; it is not a reason to run two syncs of one repository at once,
-- which is the thing that damages the branch. A forced call still ignores desired_handout_sha
-- and sync_blocked_at -- everything it was added for -- and still declines to pile a second job
-- for the same revision onto a live one. The press is not lost: the answer names the reason,
-- the claim it waited on expires, and a press made after the handout moves is a different
-- revision and queues immediately.

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
    v_claim_window interval := interval '15 minutes';
    v_claim_started timestamptz;
    v_claim_target text;
    v_claim_is_live boolean;
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

            -- Is a job for this repository already in flight? Only the two statuses that mean
            -- one is: 'queued', written by this function, and 'in_progress', written by the
            -- worker before the long work. Every other status is an outcome, which means
            -- whatever was queued has reported back. The timestamp is read from whichever
            -- field the status that set it writes.
            v_claim_started := case v_repo_record.sync_data ->> 'status'
                when 'queued' then (v_repo_record.sync_data ->> 'sync_queued_at')::timestamptz
                when 'in_progress' then (v_repo_record.sync_data ->> 'started_at')::timestamptz
                else null
            end;
            -- WHICH REVISION that in-flight job is carrying, which is the difference between a
            -- duplicate and a second, necessary sync.
            --
            -- A claim only suppresses a job for the SAME revision. That is where the damage is:
            -- the sync branch is named `sync-to-<sha7>`, so two jobs for one revision reset and
            -- commit to the same branch and open, close and reset each other's pull request.
            -- Two jobs for DIFFERENT revisions use different branches and are not in each
            -- other's way, and suppressing the newer one would be the worse bug: the autograder
            -- toggle queues every repository in an assignment after editing grade.yml in the
            -- handout, and a repository whose in-flight sync was already heading somewhere
            -- older would have been skipped, never queued again by anything, and left without
            -- the workflow the toggle exists to deliver.
            --
            -- The worker writes `to_sha` into the in_progress marker; this function writes
            -- `sync_queued_to` when it claims. A target we cannot read does not match, so the
            -- repository is queued: a job whose write is discarded by the worker's own
            -- revision guard costs one wasted attempt, and an undelivered revision costs an
            -- instructor an assignment they think has propagated.
            v_claim_target := case v_repo_record.sync_data ->> 'status'
                when 'queued' then v_repo_record.sync_data ->> 'sync_queued_to'
                when 'in_progress' then v_repo_record.sync_data ->> 'to_sha'
                else null
            end;
            v_claim_is_live := v_claim_started is not null
                and v_claim_started > now() - v_claim_window
                and v_claim_target is not null
                and v_claim_target = v_repo_record.latest_template_sha;

            if v_claim_is_live then
                v_skipped_in_flight_count := v_skipped_in_flight_count + 1;
            elsif p_force or
               v_repo_record.desired_handout_sha is null or
               v_repo_record.desired_handout_sha <> v_repo_record.latest_template_sha or
               v_repo_record.sync_blocked_at is not null then

                -- The claim and the message are one statement apart in one transaction, so a
                -- send that fails rolls the claim back and the repository stays queueable.
                -- sync_data is MERGED rather than replaced: unresolved_paths and the pull
                -- request an earlier revision opened are what the page shows while this job
                -- runs, and a claim is no reason to erase them.
                -- Reset explicitly rather than trusting an UPDATE that matches nothing to
                -- clear it: this runs once per repository in the loop, and a value left over
                -- from the previous one would read as a successful claim.
                v_claimed_id := null;

                update public.repositories
                set desired_handout_sha = v_repo_record.latest_template_sha,
                    sync_data = coalesce(sync_data, '{}'::jsonb) || jsonb_build_object(
                        'status', 'queued',
                        'sync_queued_at', to_jsonb(now()),
                        -- The revision this claim is for. Without it the claim cannot tell a
                        -- duplicate from a sync of a newer handout; see the note above.
                        'sync_queued_to', v_repo_record.latest_template_sha
                    )
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
    'Queue handout syncs for the given repositories. Instructors and admins only. Claims each repository in the same transaction as the message it sends, so a repository with a sync already queued or running is reported under skipped_in_flight_count rather than queued a second time; the claim lives in sync_data and expires after 15 minutes so an attempt that dies mid-flight cannot park the repository. Pass p_force => true for a press the user made explicitly, which queues the repo whatever its recorded revision or block state says; the default also skips repos already at the assignment''s latest template sha.';
