-- Replace assignment-group-copy-groups-from-assignment Edge Function with Postgres RPC
-- Efficiently copies groups and members from source to target assignment using bulk SQL

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
  v_groups_processed int;
  v_members_copied int;
BEGIN
  -- 1. Auth check: only instructors can copy groups
  IF NOT authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Permission denied'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Get caller's profile for added_by (instructor performing the copy)
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

  -- 3. Both assignments must belong to this class
  IF NOT EXISTS (
    SELECT 1 FROM assignments
    WHERE id = p_source_assignment_id
      AND class_id = p_class_id
  ) THEN
    RAISE EXCEPTION 'Source assignment not found in this class'
      USING ERRCODE = 'data_exception';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM assignments
    WHERE id = p_target_assignment_id
      AND class_id = p_class_id
  ) THEN
    RAISE EXCEPTION 'Target assignment not found in this class'
      USING ERRCODE = 'data_exception';
  END IF;

  -- 4. Validate source has groups
  IF NOT EXISTS (
    SELECT 1 FROM assignment_groups
    WHERE assignment_id = p_source_assignment_id
      AND class_id = p_class_id
  ) THEN
    RAISE EXCEPTION 'Source assignment has no groups'
      USING ERRCODE = 'data_exception';
  END IF;

  -- 5. Bulk upsert groups (preserving mentor_profile_id)
  WITH inserted_groups AS (
    INSERT INTO assignment_groups (assignment_id, class_id, name, mentor_profile_id)
    SELECT p_target_assignment_id, class_id, name, mentor_profile_id
    FROM assignment_groups
    WHERE assignment_id = p_source_assignment_id
      AND class_id = p_class_id
    ON CONFLICT (assignment_id, name)
    DO UPDATE SET mentor_profile_id = EXCLUDED.mentor_profile_id
    RETURNING id
  )
  SELECT COUNT(*) INTO v_groups_processed FROM inserted_groups;

  -- 6. Bulk upsert members (mapping source groups to target groups via name)
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
    DO UPDATE SET assignment_group_id = EXCLUDED.assignment_group_id
    RETURNING id
  )
  SELECT COUNT(*) INTO v_members_copied FROM inserted_members;

  RETURN jsonb_build_object(
    'groups_processed', v_groups_processed,
    'members_copied', v_members_copied
  );
END;
$$;

REVOKE ALL ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.copy_groups_from_assignment IS
  'Copies assignment groups and members from a source assignment to a target assignment. '
  'Only instructors can call. Uses auth.uid() for authorization and added_by.';
