-- Make the instructor copy-groups task a true overwrite of target memberships.
-- The UI now presents this as a one-shot group-management action rather than an
-- assignment setting.

CREATE OR REPLACE FUNCTION public.copy_groups_from_assignment(
  p_class_id bigint,
  p_source_assignment_id bigint,
  p_target_assignment_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_profile_id uuid;
  v_course_slug text;
  v_github_org text;
  v_template_repo text;
  v_group_config text;
  v_release_date timestamptz;
  v_groups_processed int := 0;
  v_members_copied int := 0;
  v_memberships_removed int := 0;
  v_submissions_deactivated int := 0;
  v_groups_deleted int := 0;
  v_groups_preserved int := 0;
  v_empty_gid bigint;
  v_repo_record record;
BEGIN
  set local statement_timeout to '3min';
  set local pawtograder.suppress_repo_sync = 'on';

  IF NOT authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Permission denied'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT private_profile_id INTO v_caller_profile_id
  FROM user_roles
  WHERE user_id = auth.uid()
    AND class_id = p_class_id
    AND role = 'instructor'
    AND disabled = false
  LIMIT 1;

  IF v_caller_profile_id IS NULL THEN
    RAISE EXCEPTION 'Could not find instructor profile for caller'
      USING ERRCODE = 'data_exception';
  END IF;

  IF p_source_assignment_id = p_target_assignment_id THEN
    RAISE EXCEPTION 'Source and target assignments must be different'
      USING ERRCODE = 'data_exception';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM assignments
    WHERE id = p_source_assignment_id
      AND class_id = p_class_id
      AND group_config IN ('groups', 'both')
  ) THEN
    RAISE EXCEPTION 'Source assignment not found in this class or is not a group assignment'
      USING ERRCODE = 'data_exception';
  END IF;

  SELECT c.slug, c.github_org, a.template_repo, a.group_config, a.release_date
  INTO v_course_slug, v_github_org, v_template_repo, v_group_config, v_release_date
  FROM assignments a
  JOIN classes c ON c.id = a.class_id
  WHERE a.id = p_target_assignment_id
    AND a.class_id = p_class_id
    AND a.group_config IN ('groups', 'both');

  IF v_group_config IS NULL THEN
    RAISE EXCEPTION 'Target assignment not found in this class or is not a group assignment'
      USING ERRCODE = 'data_exception';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(format('copy_groups:%s:%s', p_class_id, p_target_assignment_id), 0));

  SELECT COUNT(*) INTO v_groups_processed
  FROM assignment_groups
  WHERE assignment_id = p_source_assignment_id
    AND class_id = p_class_id;

  IF v_groups_processed = 0 THEN
    RAISE EXCEPTION 'Source assignment has no groups'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Copy the source group names and mentors onto the target. Existing target
  -- groups with the same name are reused so repository/history links survive.
  INSERT INTO assignment_groups (assignment_id, class_id, name, mentor_profile_id)
  SELECT p_target_assignment_id, class_id, name, mentor_profile_id
  FROM assignment_groups
  WHERE assignment_id = p_source_assignment_id
    AND class_id = p_class_id
  ON CONFLICT (assignment_id, name)
  DO UPDATE SET mentor_profile_id = EXCLUDED.mentor_profile_id;

  WITH deleted_memberships AS (
    DELETE FROM assignment_groups_members
    WHERE assignment_id = p_target_assignment_id
      AND class_id = p_class_id
    RETURNING id, profile_id
  ),
  deactivated_submissions AS (
    UPDATE submissions
    SET is_active = false
    WHERE assignment_id = p_target_assignment_id
      AND profile_id IN (SELECT profile_id FROM deleted_memberships)
    RETURNING id
  )
  SELECT
    (SELECT COUNT(*) FROM deleted_memberships),
    (SELECT COUNT(*) FROM deactivated_submissions)
  INTO v_memberships_removed, v_submissions_deactivated;

  WITH inserted_members AS (
    INSERT INTO assignment_groups_members (
      assignment_id,
      class_id,
      profile_id,
      assignment_group_id,
      added_by
    )
    SELECT
      p_target_assignment_id,
      p_class_id,
      sm.profile_id,
      tg.id,
      v_caller_profile_id
    FROM assignment_groups_members sm
    JOIN assignment_groups sg ON sg.id = sm.assignment_group_id
    JOIN assignment_groups tg ON tg.name = sg.name
      AND tg.assignment_id = p_target_assignment_id
      AND tg.class_id = p_class_id
    WHERE sm.assignment_id = p_source_assignment_id
      AND sm.class_id = p_class_id
    ON CONFLICT (assignment_id, profile_id)
    DO UPDATE SET
      assignment_group_id = EXCLUDED.assignment_group_id,
      added_by = EXCLUDED.added_by
    RETURNING id
  )
  SELECT COUNT(*) INTO v_members_copied FROM inserted_members;

  FOR v_empty_gid IN
    SELECT ag.id
    FROM assignment_groups ag
    WHERE ag.assignment_id = p_target_assignment_id
      AND ag.class_id = p_class_id
      AND NOT EXISTS (
        SELECT 1
        FROM assignment_groups_members agm
        WHERE agm.assignment_group_id = ag.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM assignment_groups source_group
        WHERE source_group.assignment_id = p_source_assignment_id
          AND source_group.class_id = p_class_id
          AND source_group.name = ag.name
      )
  LOOP
    IF EXISTS (
      SELECT 1 FROM submissions s
      WHERE s.assignment_group_id = v_empty_gid
    ) OR EXISTS (
      SELECT 1
      FROM submissions s
      JOIN repositories r ON r.id = s.repository_id
      WHERE r.assignment_group_id = v_empty_gid
    ) THEN
      v_groups_preserved := v_groups_preserved + 1;
      CONTINUE;
    END IF;

    DELETE FROM assignment_group_invitations
    WHERE assignment_group_id = v_empty_gid;
    DELETE FROM assignment_group_join_request
    WHERE assignment_group_id = v_empty_gid;

    FOR v_repo_record IN
      SELECT r.id, r.repository
      FROM repositories r
      WHERE r.assignment_group_id = v_empty_gid
        AND r.repository IS NOT NULL
        AND position('/' in r.repository) > 0
    LOOP
      IF v_github_org IS NOT NULL THEN
        PERFORM enqueue_github_archive_repo(
          p_class_id,
          v_github_org,
          split_part(v_repo_record.repository, '/', 2),
          'copy-groups-dissolve-' || v_empty_gid::text
        );
      END IF;
      DELETE FROM repository_check_runs WHERE repository_id = v_repo_record.id;
      DELETE FROM repositories WHERE id = v_repo_record.id;
    END LOOP;

    DELETE FROM assignment_groups WHERE id = v_empty_gid;
    v_groups_deleted := v_groups_deleted + 1;
  END LOOP;

  IF v_group_config IN ('groups', 'both')
     AND v_template_repo IS NOT NULL AND v_template_repo != ''
     AND v_release_date IS NOT NULL AND v_release_date <= now()
  THEN
    PERFORM create_all_repos_for_assignment_internal(p_class_id, p_target_assignment_id, false);
  END IF;

  RETURN jsonb_build_object(
    'groups_processed', v_groups_processed,
    'members_copied', v_members_copied,
    'memberships_removed', v_memberships_removed,
    'groups_deleted', v_groups_deleted,
    'groups_preserved', v_groups_preserved
  );
END;
$$;

REVOKE ALL ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.copy_groups_from_assignment IS
  'Overwrites a target assignment group membership set with groups and members from a source assignment. '
  'Only instructors can call. Uses auth.uid() for authorization and added_by.';
