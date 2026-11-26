-- Skip non-GitHub assignments and repositories in enqueue_repo_analytics_fetch.
-- Based on the latest definition in 20260322000001_add_enable_repo_analytics_to_assignments.sql;
-- preserves the privileges set in 20261015120000_lock_down_security_definer_functions.sql.
CREATE OR REPLACE FUNCTION public.enqueue_repo_analytics_fetch(
    p_class_id bigint,
    p_assignment_id bigint,
    p_org text,
    p_repository_id bigint default null
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    message_id bigint;
    last_req timestamptz;
    v_org text;
    v_msgs jsonb[];
    v_assignment_provider text;
    v_repo_provider text;
BEGIN
    IF auth.role() = 'anon' THEN
        RAISE EXCEPTION 'Access denied: authentication required';
    ELSIF auth.uid() IS NOT NULL
        AND NOT (public.authorizeforclassgrader(p_class_id) OR public.authorizeforclassinstructor(p_class_id))
    THEN
        RAISE EXCEPTION 'Access denied: insufficient permissions for class %', p_class_id;
    END IF;

    SELECT a.git_provider
    INTO v_assignment_provider
    FROM public.assignments a
    WHERE a.id = p_assignment_id AND a.class_id = p_class_id AND a.enable_repo_analytics = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Repo analytics not enabled for assignment %', p_assignment_id;
    END IF;

    IF v_assignment_provider IS DISTINCT FROM 'github' THEN
        IF p_repository_id IS NOT NULL THEN
            RAISE EXCEPTION 'Repository analytics are only collected from GitHub (assignment % uses %)', p_assignment_id, v_assignment_provider;
        END IF;
        RETURN 0;
    END IF;

    -- After the provider check: a Forgejo assignment in a course without a GitHub org returns 0, not an error.
    v_org := nullif(trim(p_org), '');
    IF v_org IS NULL THEN
        SELECT c.github_org INTO v_org FROM public.classes c WHERE c.id = p_class_id;
        v_org := nullif(trim(v_org), '');
    END IF;
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Class % has no GitHub org configured; cannot enqueue repo analytics fetch', p_class_id;
    END IF;

    IF p_repository_id IS NOT NULL THEN
        SELECT r.git_provider
        INTO v_repo_provider
        FROM public.repositories r
        WHERE r.id = p_repository_id AND r.assignment_id = p_assignment_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Repository % does not belong to assignment %', p_repository_id, p_assignment_id;
        END IF;

        IF v_repo_provider IS DISTINCT FROM 'github' THEN
            RAISE EXCEPTION 'Repository analytics are only collected from GitHub (repository % uses %)', p_repository_id, v_repo_provider;
        END IF;

        INSERT INTO public.repository_analytics_fetch_status (
            assignment_id, class_id, repository_id, last_requested_at, status
        )
        SELECT p_assignment_id, p_class_id, p_repository_id, now(), 'fetching'
        FROM public.repositories r
        WHERE r.id = p_repository_id AND r.assignment_id = p_assignment_id
        ON CONFLICT (assignment_id, repository_id)
        DO UPDATE SET last_requested_at = now(), status = 'fetching'
        WHERE repository_analytics_fetch_status.last_requested_at < now() - interval '10 minutes'
           OR repository_analytics_fetch_status.last_requested_at IS NULL
        RETURNING last_requested_at INTO last_req;

        IF NOT FOUND THEN
            SELECT last_requested_at INTO last_req
            FROM public.repository_analytics_fetch_status
            WHERE assignment_id = p_assignment_id AND repository_id = p_repository_id;
            RAISE EXCEPTION 'Rate limited: try again after %', last_req + interval '10 minutes';
        END IF;

        SELECT pgmq_public.send(
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
        ) INTO message_id;

        RETURN message_id;
    END IF;

    -- Bulk: chunk GitHub-ready GitHub repositories into batches of 20; one PGMQ message per batch (repository_ids in args)
    WITH repo_ids AS (
        SELECT r.id
        FROM public.repositories r
        WHERE r.assignment_id = p_assignment_id
          AND r.is_github_ready = true
          AND r.git_provider = 'github'
    ),
    numbered AS (
        SELECT
            id,
            ((row_number() OVER (ORDER BY id)) - 1) / 20 AS batch_no
        FROM repo_ids
    ),
    batches AS (
        SELECT batch_no, array_agg(id ORDER BY id) AS ids
        FROM numbered
        GROUP BY batch_no
    )
    SELECT COALESCE(
        array_agg(
            jsonb_build_object(
                'method', 'fetch_repo_analytics',
                'class_id', p_class_id,
                'args', jsonb_build_object(
                    'assignment_id', p_assignment_id,
                    'org', v_org,
                    'repository_ids', to_jsonb(ids)
                )
            )
            ORDER BY batch_no
        ),
        ARRAY[]::jsonb[]
    )
    INTO v_msgs
    FROM batches;

    IF v_msgs IS NULL OR cardinality(v_msgs) = 0 THEN
        RETURN 0;
    END IF;

    PERFORM pgmq_public.send_batch(
        queue_name := 'async_calls_low_priority',
        messages := v_msgs,
        sleep_seconds := 0
    );

    RETURN cardinality(v_msgs)::bigint;
END;
$$;
