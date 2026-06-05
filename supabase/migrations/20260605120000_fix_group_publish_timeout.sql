-- Fix: publish_assignment_group_changes hits "canceling statement due to
-- statement timeout" when an instructor removes a student / moves members.
--
-- Two root causes:
--
--   1. The RPC never raised its statement_timeout, so it ran under the default
--      `authenticated` budget (~8s). Every other heavy RPC in this codebase sets
--      `statement_timeout to '3min'`; this one was missed. Worst-case calls
--      measured ~13s in production (pg_stat_statements), so they were cancelled.
--
--   2. The RPC mutates assignment_groups / assignment_groups_members row-at-a-time
--      in PL/pgSQL loops. Each single-row write fires the FOR EACH ROW trigger
--      `sync_repos_after_assignment_group_change`, which calls the assignment-wide
--      `create_all_repos_for_assignment_internal` (full scan of all students +
--      aggregate of all groups). So one publish ran that ~1s reconciliation 1+N
--      times (once per row touched) — the source of the 13s worst case.
--
-- Fix: raise the timeout to match the other RPCs, AND suppress the per-row
-- reconciliation for the duration of the batch via a transaction-local GUC, then
-- run the reconciliation exactly ONCE before the RPC returns. External callers
-- (ad-hoc membership writes outside this RPC) are unaffected — the trigger still
-- reconciles normally for them. 1+N full scans collapse to one (~13s -> ~1s).

-- ── 1. Trigger fn: honor the batch-suppression flag ──────────────────────────
CREATE OR REPLACE FUNCTION public.sync_repos_after_assignment_group_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_assignment_id bigint;
  v_class_id bigint;
  v_group_config public.assignment_group_mode;
  v_release timestamptz;
  v_template text;
BEGIN
  -- Batch callers (publish_assignment_group_changes) suppress the per-row
  -- reconciliation and run it once at the end instead. Skip entirely here.
  IF current_setting('pawtograder.suppress_repo_sync', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'assignment_groups' THEN
    IF TG_OP = 'DELETE' THEN
      v_assignment_id := OLD.assignment_id;
      v_class_id := OLD.class_id;
    ELSE
      v_assignment_id := NEW.assignment_id;
      v_class_id := NEW.class_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'assignment_groups_members' THEN
    IF TG_OP = 'DELETE' THEN
      v_assignment_id := OLD.assignment_id;
      v_class_id := OLD.class_id;
    ELSE
      v_assignment_id := NEW.assignment_id;
      v_class_id := NEW.class_id;
    END IF;
  ELSE
    RAISE WARNING 'sync_repos_after_assignment_group_change: unexpected table %', TG_TABLE_NAME;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT a.group_config, a.release_date, a.template_repo
  INTO v_group_config, v_release, v_template
  FROM public.assignments a
  WHERE a.id = v_assignment_id AND a.class_id = v_class_id;

  IF v_group_config IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_group_config NOT IN ('groups', 'both') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_template IS NULL OR v_template = '' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_release IS NULL OR v_release > now() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE NOTICE 'sync_repos_after_assignment_group_change: enqueue repos for assignment_id=%, class_id=% (source=% %)',
    v_assignment_id, v_class_id, TG_TABLE_NAME, TG_OP;

  PERFORM public.create_all_repos_for_assignment_internal(v_class_id, v_assignment_id, false);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 2. RPC: raise timeout, suppress per-row trigger, reconcile once at the end ─
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
    v_group_config      text;
    v_release_date      timestamptz;

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
    -- empty groups we intentionally keep (they have submissions); excluded from
    -- the permission sync so their preserved repo's GitHub access is left as-is
    v_preserved_groups  bigint[] := '{}';

    v_groups_created    integer := 0;
    v_members_added     integer := 0;
    v_members_moved     integer := 0;
    v_groups_dissolved  integer := 0;
    v_syncs_enqueued    integer := 0;
    v_errors            jsonb[] := '{}';
BEGIN
    -- Heavy batch operation: match the timeout other heavy RPCs use.
    -- Transaction-local so it resets when this RPC's transaction ends rather
    -- than leaking onto the pooled connection for subsequent requests.
    set local statement_timeout to '3min';

    -- Suppress the per-row repo-sync trigger for the duration of this batch.
    -- The RPC mutates membership row-at-a-time, so leaving the trigger active
    -- would run the assignment-wide reconciliation once per row. We instead run
    -- it exactly once at the end (see Phase 4 below). Transaction-local: it
    -- resets automatically when this RPC's transaction ends.
    set local pawtograder.suppress_repo_sync = 'on';

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
    SELECT c.slug, c.github_org, a.slug, a.template_repo, a.latest_template_sha,
           a.group_config, a.release_date
    INTO   v_course_slug, v_github_org, v_assignment_slug, v_template_repo, v_latest_sha,
           v_group_config, v_release_date
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
        -- Preserve groups that have submissions. Their repo holds graded/active
        -- work and is referenced by submissions (repository_id and
        -- repository_check_run_id), so deleting it would violate those FKs and
        -- destroy history. Keep the group, repo, check runs, and submissions
        -- intact; only fully dissolve groups whose repos have no submissions.
        IF EXISTS (
            SELECT 1 FROM public.submissions s
            WHERE s.assignment_group_id = v_empty_gid
        ) OR EXISTS (
            SELECT 1
            FROM public.submissions s
            JOIN public.repositories r ON r.id = s.repository_id
            WHERE r.assignment_group_id = v_empty_gid
        ) THEN
            v_preserved_groups := array_append(v_preserved_groups, v_empty_gid);
            CONTINUE;
        END IF;

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
    -- Deduplicate and exclude dissolved + preserved groups
    FOR v_repo_record IN
        SELECT DISTINCT r.id           AS repo_id,
               r.repository,
               r.assignment_group_id,
               r.is_github_ready
        FROM   unnest(v_affected_groups) AS gid(g)
        JOIN   public.repositories r ON r.assignment_group_id = gid.g
        WHERE  NOT (gid.g = ANY(v_deleted_groups))
          AND  NOT (gid.g = ANY(v_preserved_groups))
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

    -- ══════════════════════════════════════════════════════════════════════
    -- Phase 4: reconcile repos ONCE for the whole batch
    -- ══════════════════════════════════════════════════════════════════════
    -- The per-row sync trigger was suppressed above; run its assignment-wide
    -- reconciliation a single time here. Mirror the trigger's guard conditions
    -- so we don't call the internal reconciler for assignments it would have
    -- skipped — notably it RAISES when the template repo is missing.
    IF v_group_config IN ('groups', 'both')
       AND v_template_repo IS NOT NULL AND v_template_repo != ''
       AND v_release_date IS NOT NULL AND v_release_date <= now()
    THEN
        BEGIN
            PERFORM public.create_all_repos_for_assignment_internal(p_class_id, p_assignment_id, false);
        EXCEPTION WHEN OTHERS THEN
            v_errors := array_append(v_errors, jsonb_build_object(
                'phase', 'reconcile',
                'error', SQLERRM
            ));
        END;
    END IF;

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
per affected repo.  Suppresses the per-row sync_repos trigger for the duration of
the batch and runs repo reconciliation exactly once at the end (avoids 1+N
assignment-wide scans that caused statement timeouts).  Empty groups whose
repositories still have submissions are preserved (repo + check runs +
submissions kept intact) rather than deleted, to avoid FK violations and history loss.';
