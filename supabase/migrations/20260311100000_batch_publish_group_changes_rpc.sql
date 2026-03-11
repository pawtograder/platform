-- Single RPC that publishes all staged group changes (creates + moves) in one
-- database round-trip.  Replaces N edge-function calls with one transactional
-- PL/pgSQL function that validates everything, mutates, then enqueues the
-- minimal set of GitHub operations at the end.

CREATE OR REPLACE FUNCTION public.publish_assignment_group_changes(
    p_class_id       bigint,
    p_assignment_id  bigint,
    -- groups_to_create: array of {name, member_ids}
    p_groups_to_create jsonb DEFAULT '[]'::jsonb,
    -- moves_to_fulfill: array of {profile_id, old_group_id, new_group_id}
    p_moves_to_fulfill jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_profile_id uuid;
    v_course_slug       text;
    v_github_org        text;
    v_template_repo     text;
    v_latest_sha        text;
    v_assignment_slug   text;

    v_group             jsonb;
    v_move              jsonb;
    v_group_name        text;
    v_new_group_id      bigint;
    v_member_id         uuid;
    v_member_ids        jsonb;

    v_old_gid           bigint;
    v_new_gid           bigint;
    v_profile_id        uuid;
    v_empty_gid         bigint;

    v_membership_id     bigint;
    v_repo_record       record;

    -- collect affected group IDs so we can do one permission sync per repo
    v_affected_groups   bigint[] := '{}';
    v_deleted_groups    bigint[] := '{}';

    v_groups_created    integer := 0;
    v_members_added     integer := 0;
    v_members_moved     integer := 0;
    v_groups_dissolved  integer := 0;
    v_syncs_enqueued    integer := 0;
    v_errors            jsonb[] := '{}';
BEGIN
    -- ── auth ──────────────────────────────────────────────────────────────
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT public.authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Only instructors can publish group changes';
    END IF;

    -- look up caller's profile for added_by
    SELECT private_profile_id INTO v_caller_profile_id
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND class_id = p_class_id
      AND role = 'instructor'
    LIMIT 1;

    -- ── class + assignment metadata (one query) ──────────────────────────
    SELECT c.slug, c.github_org, a.slug, a.template_repo, a.latest_template_sha
    INTO   v_course_slug, v_github_org, v_assignment_slug, v_template_repo, v_latest_sha
    FROM   public.assignments a
    JOIN   public.classes c ON c.id = a.class_id
    WHERE  a.id = p_assignment_id AND a.class_id = p_class_id;

    IF v_course_slug IS NULL THEN
        RAISE EXCEPTION 'Assignment % not found in class %', p_assignment_id, p_class_id;
    END IF;

    -- ══════════════════════════════════════════════════════════════════════
    -- Phase 1: process moves on existing groups
    -- ══════════════════════════════════════════════════════════════════════
    FOR v_move IN SELECT * FROM jsonb_array_elements(p_moves_to_fulfill)
    LOOP
        v_profile_id := (v_move->>'profile_id')::uuid;
        v_old_gid    := (v_move->>'old_group_id')::bigint;   -- nullable
        v_new_gid    := (v_move->>'new_group_id')::bigint;   -- nullable

        BEGIN
            -- validate group IDs belong to assignment before any mutations
            IF v_old_gid IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.assignment_groups
                WHERE id = v_old_gid
                  AND assignment_id = p_assignment_id
                  AND class_id = p_class_id
            ) THEN
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_old_gid, p_assignment_id)
                ));
                CONTINUE;
            END IF;
            IF v_new_gid IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.assignment_groups
                WHERE id = v_new_gid
                  AND assignment_id = p_assignment_id
                  AND class_id = p_class_id
            ) THEN
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_new_gid, p_assignment_id)
                ));
                CONTINUE;
            END IF;

            -- remove from old group
            IF v_old_gid IS NOT NULL THEN
                SELECT id INTO v_membership_id
                FROM public.assignment_groups_members
                WHERE assignment_group_id = v_old_gid
                  AND profile_id = v_profile_id
                  AND class_id = p_class_id;

                IF v_membership_id IS NULL THEN
                    v_errors := array_append(v_errors, jsonb_build_object(
                        'profile_id', v_profile_id,
                        'error', format('Student not in group %s', v_old_gid)
                    ));
                    CONTINUE;
                END IF;

                DELETE FROM public.assignment_groups_members WHERE id = v_membership_id;
                v_affected_groups := array_append(v_affected_groups, v_old_gid);
            END IF;

            -- add to new group
            IF v_new_gid IS NOT NULL THEN
                IF v_old_gid IS NULL THEN
                    -- moving from no-group into a group: deactivate individual submissions
                    UPDATE public.submissions
                    SET is_active = false
                    WHERE assignment_id = p_assignment_id
                      AND profile_id = v_profile_id;
                END IF;

                INSERT INTO public.assignment_groups_members
                    (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                VALUES
                    (v_new_gid, v_profile_id, p_assignment_id, p_class_id, v_caller_profile_id);

                v_affected_groups := array_append(v_affected_groups, v_new_gid);
            END IF;

            v_members_moved := v_members_moved + 1;

        EXCEPTION WHEN OTHERS THEN
            v_errors := array_append(v_errors, jsonb_build_object(
                'profile_id', v_profile_id,
                'error', SQLERRM
            ));
        END;
    END LOOP;

    -- ══════════════════════════════════════════════════════════════════════
    -- Phase 2: create new groups and add their initial members
    -- ══════════════════════════════════════════════════════════════════════
    FOR v_group IN SELECT * FROM jsonb_array_elements(p_groups_to_create)
    LOOP
        v_group_name := trim(v_group->>'name');
        v_member_ids := v_group->'member_ids';

        BEGIN
            -- validate name
            IF v_group_name = '' OR v_group_name IS NULL THEN
                RAISE EXCEPTION 'Group name cannot be empty';
            END IF;
            IF length(v_group_name) > 36 THEN
                RAISE EXCEPTION 'Group name too long (max 36 chars)';
            END IF;
            IF v_group_name !~ '^[a-zA-Z0-9_-]+$' THEN
                RAISE EXCEPTION 'Group name must be alphanumeric, hyphens, or underscores';
            END IF;

            -- uniqueness
            IF EXISTS (
                SELECT 1 FROM public.assignment_groups
                WHERE assignment_id = p_assignment_id AND lower(name) = lower(v_group_name)
            ) THEN
                RAISE EXCEPTION 'Group "%" already exists', v_group_name;
            END IF;

            -- create the group
            INSERT INTO public.assignment_groups (name, assignment_id, class_id)
            VALUES (v_group_name, p_assignment_id, p_class_id)
            RETURNING id INTO v_new_group_id;

            v_groups_created := v_groups_created + 1;

            -- enqueue repo creation (with empty usernames; permission sync below)
            IF v_template_repo IS NOT NULL AND v_template_repo != '' AND v_github_org IS NOT NULL THEN
                PERFORM public.enqueue_github_create_repo(
                    p_class_id,
                    v_github_org,
                    v_course_slug || '-' || v_assignment_slug || '-group-' || v_group_name,
                    v_template_repo,
                    v_course_slug,
                    '{}'::text[],
                    false,
                    'batch-group-create-' || v_new_group_id::text,
                    p_assignment_id,
                    null::uuid,
                    v_new_group_id,
                    v_latest_sha
                );
            END IF;

            -- add members
            IF v_member_ids IS NOT NULL AND jsonb_array_length(v_member_ids) > 0 THEN
                FOR v_member_id IN
                    SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(v_member_ids) AS value
                LOOP
                    -- deactivate individual submissions when first entering a group
                    UPDATE public.submissions
                    SET is_active = false
                    WHERE assignment_id = p_assignment_id
                      AND profile_id = v_member_id;

                    INSERT INTO public.assignment_groups_members
                        (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                    VALUES
                        (v_new_group_id, v_member_id, p_assignment_id, p_class_id, v_caller_profile_id);

                    v_members_added := v_members_added + 1;
                END LOOP;
            END IF;

            v_affected_groups := array_append(v_affected_groups, v_new_group_id);

        EXCEPTION WHEN OTHERS THEN
            v_errors := array_append(v_errors, jsonb_build_object(
                'group_name', v_group_name,
                'error', SQLERRM
            ));
        END;
    END LOOP;

    -- ══════════════════════════════════════════════════════════════════════
    -- Phase 2b: dissolve empty groups (batch-final state after moves + creates)
    -- ══════════════════════════════════════════════════════════════════════
    FOR v_empty_gid IN
        SELECT ag.id
        FROM public.assignment_groups ag
        WHERE ag.assignment_id = p_assignment_id
          AND ag.class_id = p_class_id
          AND NOT EXISTS (
              SELECT 1 FROM public.assignment_groups_members agm
              WHERE agm.assignment_group_id = ag.id
          )
    LOOP
        DELETE FROM public.assignment_group_invitations
        WHERE assignment_group_id = v_empty_gid;
        DELETE FROM public.assignment_group_join_request
        WHERE assignment_group_id = v_empty_gid;

        FOR v_repo_record IN
            SELECT r.id, r.repository
            FROM public.repositories r
            WHERE r.assignment_group_id = v_empty_gid
              AND r.repository IS NOT NULL
              AND position('/' in r.repository) > 0
        LOOP
            IF v_github_org IS NOT NULL THEN
                PERFORM public.enqueue_github_archive_repo(
                    p_class_id,
                    v_github_org,
                    split_part(v_repo_record.repository, '/', 2),
                    'batch-dissolve-' || v_empty_gid::text
                );
            END IF;
            DELETE FROM public.repository_check_runs WHERE repository_id = v_repo_record.id;
            DELETE FROM public.repositories WHERE id = v_repo_record.id;
        END LOOP;

        DELETE FROM public.assignment_groups WHERE id = v_empty_gid;
        v_deleted_groups := array_append(v_deleted_groups, v_empty_gid);
        v_groups_dissolved := v_groups_dissolved + 1;
    END LOOP;

    -- ══════════════════════════════════════════════════════════════════════
    -- Phase 3: enqueue ONE permission sync per affected repo
    -- ══════════════════════════════════════════════════════════════════════
    -- Deduplicate and exclude dissolved groups
    FOR v_repo_record IN
        SELECT DISTINCT r.id           AS repo_id,
               r.repository,
               r.assignment_group_id,
               r.is_github_ready
        FROM   unnest(v_affected_groups) AS gid(g)
        JOIN   public.repositories r ON r.assignment_group_id = gid.g
        WHERE  NOT (gid.g = ANY(v_deleted_groups))
    LOOP
        BEGIN
            IF NOT v_repo_record.is_github_ready THEN
                CONTINUE;  -- will be synced when create_repo finishes
            END IF;

            DECLARE
                v_usernames text[];
            BEGIN
                SELECT coalesce(array_remove(array_agg(u.github_username), NULL), '{}')
                INTO v_usernames
                FROM public.assignment_groups_members agm
                JOIN public.user_roles ur ON ur.private_profile_id = agm.profile_id
                JOIN public.users u ON u.user_id = ur.user_id
                WHERE agm.assignment_group_id = v_repo_record.assignment_group_id
                  AND ur.class_id = p_class_id
                  AND ur.role = 'student'
                  AND ur.github_org_confirmed = true
                  AND u.github_username IS NOT NULL
                  AND u.github_username != '';

                IF v_repo_record.repository IS NOT NULL AND position('/' in v_repo_record.repository) > 0 THEN
                    PERFORM public.enqueue_github_sync_repo_permissions(
                        p_class_id,
                        v_github_org,
                        split_part(v_repo_record.repository, '/', 2),
                        v_course_slug,
                        coalesce(v_usernames, '{}'),
                        'batch-publish-' || p_assignment_id::text || '-g' || v_repo_record.assignment_group_id::text
                    );
                    v_syncs_enqueued := v_syncs_enqueued + 1;
                END IF;
            END;
        EXCEPTION WHEN OTHERS THEN
            v_errors := array_append(v_errors, jsonb_build_object(
                'repository_id', v_repo_record.repo_id,
                'error', SQLERRM
            ));
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'groups_created',   v_groups_created,
        'members_added',    v_members_added,
        'members_moved',    v_members_moved,
        'groups_dissolved', v_groups_dissolved,
        'syncs_enqueued',   v_syncs_enqueued,
        'errors',           to_jsonb(v_errors)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.publish_assignment_group_changes IS
'Atomically publish all staged group changes (new groups + member moves) for an
assignment in a single database call.  Validates inputs, creates groups, moves
members, dissolves empty groups, enqueues repo creation and ONE permission sync
per affected repo.  Replaces N sequential edge-function round-trips.';
