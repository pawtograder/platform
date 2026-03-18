-- Re-enable repo analytics fetch (was disabled in 20260316000000) and stagger daily cron
-- to enqueue one assignment per minute during 2am UTC instead of all at once.

-- 1. Restore the full enqueue_repo_analytics_fetch implementation
create or replace function public.enqueue_repo_analytics_fetch(
    p_class_id bigint,
    p_assignment_id bigint,
    p_org text,
    p_repository_id bigint default null
) returns bigint
language plpgsql
security definer
as $$
declare
    message_id bigint;
    last_req timestamptz;
    v_org text;
begin
    v_org := nullif(trim(p_org), '');
    if v_org is null then
        select c.github_org into v_org from public.classes c where c.id = p_class_id;
        v_org := nullif(trim(v_org), '');
    end if;
    if v_org is null then
        raise exception 'Class % has no GitHub org configured; cannot enqueue repo analytics fetch', p_class_id;
    end if;

    if auth.role() = 'anon' then
        raise exception 'Access denied: authentication required';
    elsif auth.uid() is not null
        and not (public.authorizeforclassgrader(p_class_id) or public.authorizeforclassinstructor(p_class_id))
    then
        raise exception 'Access denied: insufficient permissions for class %', p_class_id;
    end if;

    if not exists (select 1 from public.assignments where id = p_assignment_id and class_id = p_class_id) then
        raise exception 'Assignment % does not belong to class %', p_assignment_id, p_class_id;
    end if;

    if p_repository_id is not null then
        if not exists (
            select 1 from public.repositories r
            where r.id = p_repository_id and r.assignment_id = p_assignment_id
        ) then
            raise exception 'Repository % does not belong to assignment %', p_repository_id, p_assignment_id;
        end if;

        insert into public.repository_analytics_fetch_status (
            assignment_id, class_id, repository_id, last_requested_at, status
        )
        select p_assignment_id, p_class_id, p_repository_id, now(), 'fetching'
        from public.repositories r
        where r.id = p_repository_id and r.assignment_id = p_assignment_id
        on conflict (assignment_id, repository_id)
        do update set last_requested_at = now(), status = 'fetching'
        where repository_analytics_fetch_status.last_requested_at < now() - interval '10 minutes'
           or repository_analytics_fetch_status.last_requested_at is null
        returning last_requested_at into last_req;

        if not found then
            select last_requested_at into last_req
            from public.repository_analytics_fetch_status
            where assignment_id = p_assignment_id and repository_id = p_repository_id;
            raise exception 'Rate limited: try again after %', last_req + interval '10 minutes';
        end if;
    end if;

    select pgmq_public.send(
        'async_calls',
        jsonb_build_object(
            'method', 'fetch_repo_analytics',
            'class_id', p_class_id,
            'args', jsonb_build_object(
                'assignment_id', p_assignment_id,
                'org', v_org,
                'repository_id', p_repository_id
            )
        )
    ) into message_id;

    return message_id;
end;
$$;

-- 2. Stagger daily cron: enqueue one assignment per minute during 2am UTC
--    instead of all assignments at 2:00. Uses minute-of-hour to pick which assignment.
CREATE OR REPLACE FUNCTION "public"."check_assignment_deadlines_passed"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    r RECORD;
    v_minute int;
    v_total int;
BEGIN
    -- First, create any missing submission reviews for students whose lab-based due dates have passed
    INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
    SELECT DISTINCT
        0, false, 0, a.class_id, s.id, 'Self Review', a.self_review_rubric_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student' AND ur.disabled = false
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND a.self_review_rubric_id IS NOT NULL
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    AND NOT EXISTS (
        SELECT 1 FROM submission_reviews sr 
        WHERE sr.submission_id = s.id AND sr.rubric_id = a.self_review_rubric_id
    );

    -- Then, create review assignments for those submission reviews
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    )
    SELECT DISTINCT
        public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) + (INTERVAL '1 hour' * ars.deadline_offset),
        prof.id,
        s.id,
        sr.id,
        a.id,
        a.self_review_rubric_id,
        a.class_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student' AND ur.disabled = false
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    JOIN submission_reviews sr ON (
        sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    )
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND a.self_review_rubric_id IS NOT NULL
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    );

    -- Daily repo analytics refresh: stagger across 2am UTC hour (one assignment per minute)
    IF extract(hour from now() at time zone 'UTC') = 2 THEN
        v_minute := extract(minute from now() at time zone 'UTC')::int;
        SELECT count(*)::int INTO v_total
        FROM public.assignments a
        JOIN public.classes c ON c.id = a.class_id
        WHERE (a.release_date IS NULL OR a.release_date <= now())
          AND (a.due_date AT TIME ZONE 'UTC')::date >= (now() AT TIME ZONE 'UTC')::date
          AND a.archived_at IS NULL
          AND nullif(trim(c.github_org), '') IS NOT NULL;
        IF v_total > 0 THEN
            FOR r IN
                SELECT a.id AS assignment_id, a.class_id, c.github_org
                FROM public.assignments a
                JOIN public.classes c ON c.id = a.class_id
                WHERE (a.release_date IS NULL OR a.release_date <= now())
                  AND (a.due_date AT TIME ZONE 'UTC')::date >= (now() AT TIME ZONE 'UTC')::date
                  AND a.archived_at IS NULL
                  AND nullif(trim(c.github_org), '') IS NOT NULL
                ORDER BY a.id
                LIMIT 1 OFFSET (v_minute % v_total)
            LOOP
                BEGIN
                    PERFORM public.enqueue_repo_analytics_fetch(r.class_id, r.assignment_id, r.github_org, null);
                EXCEPTION WHEN OTHERS THEN
                    RAISE WARNING 'enqueue_repo_analytics_fetch failed for assignment_id=% class_id=%: %', r.assignment_id, r.class_id, SQLERRM;
                END;
            END LOOP;
        END IF;
    END IF;
END;
$$;
