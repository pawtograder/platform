-- #1010, step 4b follow-up: saving New and Edit Assignment follows manage_assignments.
--
-- Why: step 4b shows New Assignment and Edit Assignment from useCapability("manage_assignments"), but
-- saving still required an instructor, so a grader on a custom role with the capability could fill in
-- either form and have it fail at the end. This moves every write those two saves make onto the
-- capability, with the rule in docs/capabilities.md.
--
-- What:
--   * assignments: the FOR ALL "instructors can read and edit in class" policy becomes SELECT and
--     DELETE (instructor-only, the same expression as before) plus INSERT and UPDATE on the capability.
--     The separate read policy for graders and released assignments is unchanged.
--   * assignment_self_review_settings: insert, update and delete on the capability. New creates the
--     settings row before the assignment, and Edit updates it.
--   * autograder: SELECT and UPDATE on the capability. Edit reads grader_repo before turning the
--     autograder on, and github-repo-configure-webhook stores the grader config with the caller's
--     client. INSERT and DELETE stay instructor-only; the row is created by the trigger below.
--   * assignments_grader_config_auto_populate(), the AFTER INSERT trigger that creates the autograder
--     row and the two rubrics: SECURITY DEFINER, so creating an assignment doesn't depend on the
--     caller's write access to those tables. It checks the capability itself, except when there is no
--     signed-in user (service role, seeds), like sync_staff_github_team.
--   * queue_repository_syncs() and create_all_repos_for_assignment(): admins, or holders of
--     manage_assignments in the class, instead of admins or instructors. Edit Assignment queues
--     student-repo workflow syncs through assignment-sync-autograder-workflow with the editor's JWT,
--     and the assignments trigger creates student repos when a save moves release_date into the past;
--     both refused a Head TA, so the save left student repos stale or rolled back. Each is the latest
--     body with only that check changed; signatures, grants and search_path are unchanged. Repository
--     Status's Sync buttons call queue_repository_syncs too, so they also work for manage_assignments
--     holders; that page is still hidden from them in the nav.
--
-- Every capability is on the default instructor role, so instructors keep exactly what they had, and
-- default graders, students and admins hold no manage_assignments. Rubric, Autograder page, Delete and
-- the other assignment tools are unchanged.

-- assignments ---------------------------------------------------------------

DROP POLICY "instructors can read and edit in class" ON public.assignments;

CREATE POLICY "instructors can read assignments in class"
ON public.assignments
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = assignments.class_id
      AND up.role = 'instructor'
  )
);

CREATE POLICY "instructors can delete assignments in class"
ON public.assignments
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = assignments.class_id
      AND up.role = 'instructor'
  )
);

CREATE POLICY "assignment managers can create assignments"
ON public.assignments
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

CREATE POLICY "assignment managers can edit assignments"
ON public.assignments
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

-- assignment_self_review_settings ------------------------------------------

DROP POLICY "instructors can insert self review settings" ON public.assignment_self_review_settings;
DROP POLICY "instructors can update self review settings" ON public.assignment_self_review_settings;
DROP POLICY "instructors can delete review settings" ON public.assignment_self_review_settings;

CREATE POLICY "assignment managers can create self review settings"
ON public.assignment_self_review_settings
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

CREATE POLICY "assignment managers can edit self review settings"
ON public.assignment_self_review_settings
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

CREATE POLICY "assignment managers can delete self review settings"
ON public.assignment_self_review_settings
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

-- autograder ----------------------------------------------------------------
-- autograder reaches its class through assignments, as the policy it replaces did: its own
-- class_id column is nullable.

DROP POLICY "instructors rw" ON public.autograder;

CREATE POLICY "assignment managers can read the autograder"
ON public.autograder
FOR SELECT TO authenticated
USING (
  (SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)
    IN (SELECT public.user_class_ids_with_capability('manage_assignments'))
);

CREATE POLICY "assignment managers can edit the autograder"
ON public.autograder
FOR UPDATE TO authenticated
USING (
  (SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)
    IN (SELECT public.user_class_ids_with_capability('manage_assignments'))
)
WITH CHECK (
  (SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)
    IN (SELECT public.user_class_ids_with_capability('manage_assignments'))
);

CREATE POLICY "instructors can create the autograder"
ON public.autograder
FOR INSERT TO authenticated
WITH CHECK (public.authorizeforclassinstructor((SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)));

CREATE POLICY "instructors can delete the autograder"
ON public.autograder
FOR DELETE TO authenticated
USING (public.authorizeforclassinstructor((SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)));

-- assignments_grader_config_auto_populate -----------------------------------

CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  rubric_id int;
  self_rubric_id int;
BEGIN
  -- The INSERT policy on assignments already requires the capability. This repeats the check because
  -- the function now writes as its owner.
  IF auth.uid() IS NOT NULL
     AND NEW.class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_assignments')) THEN
    RAISE EXCEPTION 'manage_assignments is required to create an assignment in class %', NEW.class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.autograder (id, class_id, max_submissions_count, max_submissions_period_secs)
  VALUES (NEW.id, NEW.class_id, 5, 86400);
  INSERT INTO public.rubrics (name, class_id, assignment_id, review_round)
  VALUES ('Grading Rubric', NEW.class_id, NEW.id, 'grading-review') RETURNING id INTO rubric_id;
  INSERT INTO public.rubrics (name, class_id, assignment_id, review_round)
  VALUES ('Self-Review Rubric', NEW.class_id, NEW.id, 'self-review') RETURNING id INTO self_rubric_id;
  UPDATE public.assignments SET grading_rubric_id = rubric_id WHERE id = NEW.id;
  UPDATE public.assignments SET self_review_rubric_id = self_rubric_id WHERE id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.assignments_grader_config_auto_populate() FROM PUBLIC, anon, authenticated;

-- queue_repository_syncs: latest body from 20260915120000_dedupe_queued_repository_syncs.sql, with
-- only the access check changed.
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
$function$;

-- create_all_repos_for_assignment(bigint, bigint, boolean): latest body from
-- 20260530120200_assignment-repo-config.sql, with only the access check changed. The integer overload
-- delegates to this one, and create_all_repos_for_assignment_internal has no check by design.
CREATE OR REPLACE FUNCTION public.create_all_repos_for_assignment(course_id bigint, assignment_id bigint, p_force boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if course_id is null or assignment_id is null then
    raise warning 'create_all_repos_for_assignment called with NULL parameters, skipping';
    return;
  end if;

  -- Admins of any course, or holders of manage_assignments in this class (#1010): the
  -- assignments trigger calls this when a save moves release_date into the past.
  if auth.uid() is not null and not (
    exists (select 1 from public.user_privileges up where up.user_id = auth.uid() and up.role = 'admin')
    or course_id::bigint in (select public.user_class_ids_with_capability('manage_assignments'))
  ) then
    raise exception 'Access denied: manage_assignments is required to create repos for class %', course_id;
  end if;

  perform public.create_all_repos_for_assignment_internal(course_id, assignment_id, p_force);
end;
$function$;
