-- Add authorization and 10-minute rate limiting to enqueue_repo_analytics_fetch
create or replace function public.enqueue_repo_analytics_fetch(
    p_class_id bigint,
    p_assignment_id bigint,
    p_org text
) returns bigint
language plpgsql
security definer
as $$
declare
    message_id bigint;
    last_req timestamptz;
begin
    -- Auth: caller must be instructor or grader for this class
    if not (public.authorizeforclassgrader(p_class_id) or public.authorizeforclassinstructor(p_class_id)) then
        raise exception 'Access denied';
    end if;

    -- Rate limit: 10 minutes between requests
    select last_requested_at into last_req
    from public.repository_analytics_fetch_status
    where assignment_id = p_assignment_id;

    if last_req is not null and last_req > now() - interval '10 minutes' then
        raise exception 'Rate limited: try again after %', last_req + interval '10 minutes';
    end if;

    select pgmq_public.send(
        'async_calls',
        jsonb_build_object(
            'method', 'fetch_repo_analytics',
            'class_id', p_class_id,
            'args', jsonb_build_object(
                'assignment_id', p_assignment_id,
                'org', p_org
            )
        )
    ) into message_id;

    insert into public.repository_analytics_fetch_status (assignment_id, class_id, last_requested_at, status)
    values (p_assignment_id, p_class_id, now(), 'fetching')
    on conflict (assignment_id)
    do update set last_requested_at = now(), status = 'fetching';

    return message_id;
end;
$$;
