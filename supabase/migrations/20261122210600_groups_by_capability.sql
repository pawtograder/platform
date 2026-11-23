-- #1010: changing a group's mentor or name, and copying groups from another assignment, follow the
-- manage_groups capability. Also fixes who can read group memberships.
--
-- Why: these group changes needed an instructor (authorizeforclassinstructor), so no TA role could
-- be given them. In the user study an instructor wanted a Head TA who can manage groups. Now one
-- capability decides, in the database and on the Manage Groups page.
--
-- What:
--   1. New capability manage_groups, on the default instructor role of every class. It isn't on the
--      default grader role or on custom roles: graders couldn't make any group change before, so no
--      one loses access, and a Head TA gets it only when an instructor turns it on.
--   2. Updating assignment_groups (setting the mentor, renaming) needs manage_groups in the group's
--      class, and the group's assignment must stay in that class. Reading groups is unchanged
--      ("enrolled in class views all").
--   3. copy_groups_from_assignment checks manage_groups instead of authorizeforclassinstructor, and
--      finds the caller's profile among the class's instructors and graders. It used to raise "Could
--      not find instructor profile for caller" for anyone but an instructor.
--   4. sync_repos_after_assignment_group_change honors the suppress_repo_sync flag (which only copy sets,
--      so it syncs repos once at the end instead of once per row) for a caller with manage_groups,
--      instead of only for an instructor. Without this a Head TA's copy would sync per row and could
--      hit the statement timeout. Only that one check changes.
--   5. Privacy fix: the assignment_groups_members SELECT policies compared ur.class_id to itself,
--      which is always true, so anyone enrolled in any class could read every class's group
--      memberships. "anyone in class can see all" now compares the member row's class, and the
--      duplicate "Instructors can view group members" (same bug, and the fixed policy covers
--      instructors) is dropped.
--
-- Not changed: staging group changes and Publish stay on publish_groups, and
-- publish_assignment_group_changes keeps its own check (#1297 changes it). The INSERT policies, the
-- group edge functions, and the SELECT on assignment_groups.
--
-- Safe to run again: policies are dropped before they're created, the inserts skip rows that exist,
-- and the functions are CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. The capability, on every default instructor role
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES ('manage_groups', 'Set group mentors, rename groups and copy groups from another assignment')
ON CONFLICT (name) DO NOTHING;

-- New classes get it from seed_default_class_roles(), which gives the instructor role every
-- capability. Existing classes need it added here.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'manage_groups'
FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Updating a group (mentor, name) needs manage_groups
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors can update groups" ON public.assignment_groups;
DROP POLICY IF EXISTS "Group managers can update groups" ON public.assignment_groups;

-- The group's assignment must be in the group's class. Without that check someone holding
-- manage_groups could move a group onto another class's assignment, and that class's repo creation
-- (create_all_repos_for_assignment_internal) would give the group's students a repo in its org.
CREATE POLICY "Group managers can update groups" ON public.assignment_groups
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_groups')))
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('manage_groups'))
    AND EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = assignment_groups.assignment_id
        AND a.class_id = assignment_groups.class_id
    )
  );

-- ---------------------------------------------------------------------------
-- 3. sync_repos_after_assignment_group_change(): latest body from
--    20261118140200_forgejo_group_repos.sql. Only the suppress_repo_sync check changes, from
--    authorizeforclassinstructor to manage_groups. This trigger is shared with the Forgejo work.
-- ---------------------------------------------------------------------------

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
  v_provider text;
BEGIN
  -- Determine the affected assignment + class up front: needed both for the
  -- suppression authorization check below and the reconciliation logic.
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

  -- Batch callers (copy_groups_from_assignment) suppress the
  -- per-row reconciliation and run it once at the end instead. Only honor the flag for callers
  -- with manage_groups in the class (#1010; every instructor holds it): students can mutate
  -- assignment_groups_members via RLS, so without this check a student could set the GUC to
  -- disable repo reconciliation / permission sync (e.g. retaining GitHub access after leaving a
  -- group). Other callers fall through to normal reconciliation. The capability check is
  -- short-circuited so it only runs when the flag is set.
  IF current_setting('pawtograder.suppress_repo_sync', true) = 'on'
     AND v_class_id IN (SELECT public.user_class_ids_with_capability('manage_groups')) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT a.group_config, a.release_date, a.template_repo, a.git_provider
  INTO v_group_config, v_release, v_template, v_provider
  FROM public.assignments a
  WHERE a.id = v_assignment_id AND a.class_id = v_class_id;

  IF v_group_config IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Forgejo groups are forgejo-reconciler's (forgejo_group_member_added above). The GitHub path
  -- raised "Invalid class/assignment" for a class with no github_org, failing the group change.
  IF v_group_config NOT IN ('groups', 'both') OR v_provider = 'forgejo' THEN
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

-- ---------------------------------------------------------------------------
-- 4. copy_groups_from_assignment(): latest body from 20261118140200_forgejo_group_repos.sql. Only
--    the permission check and the caller's profile lookup change.
-- ---------------------------------------------------------------------------

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
  v_git_provider text;
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

  IF p_class_id IS NULL OR p_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_groups')) THEN
    RAISE EXCEPTION 'Permission denied'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The caller's profile is recorded as added_by on the copied memberships. A Head TA holding
  -- manage_groups is a grader, so look among instructors and graders.
  SELECT private_profile_id INTO v_caller_profile_id
  FROM user_roles
  WHERE user_id = auth.uid()
    AND class_id = p_class_id
    AND role IN ('instructor', 'grader')
    AND disabled = false
  LIMIT 1;

  IF v_caller_profile_id IS NULL THEN
    RAISE EXCEPTION 'Could not find a staff profile for caller'
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

  SELECT c.slug, c.github_org, a.template_repo, a.group_config, a.release_date, a.git_provider
  INTO v_course_slug, v_github_org, v_template_repo, v_group_config, v_release_date, v_git_provider
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
      SELECT r.id, r.repository, r.git_provider
      FROM repositories r
      WHERE r.assignment_group_id = v_empty_gid
        AND r.repository IS NOT NULL
        AND position('/' in r.repository) > 0
    LOOP
      IF v_github_org IS NOT NULL AND v_repo_record.git_provider = 'github' THEN
        PERFORM enqueue_github_archive_repo(
          p_class_id,
          v_github_org,
          -- everything after the FIRST slash: the repo name can itself contain one
          substring(v_repo_record.repository from position('/' in v_repo_record.repository) + 1),
          'copy-groups-dissolve-' || v_empty_gid::text
        );
      END IF;
      PERFORM public.delete_repository_rows(ARRAY[v_repo_record.id]);
    END LOOP;

    DELETE FROM assignment_groups WHERE id = v_empty_gid;
    v_groups_deleted := v_groups_deleted + 1;
  END LOOP;

  -- A Forgejo target's repos come from forgejo-reconciler, which the member inserts above kick. The
  -- GitHub path raises for a class with no github_org.
  IF v_git_provider = 'github'
     AND v_group_config IN ('groups', 'both')
     AND v_template_repo IS NOT NULL AND v_template_repo != ''
     AND v_release_date IS NOT NULL AND v_release_date <= now()
  THEN
    PERFORM create_all_repos_for_assignment_internal(p_class_id, p_target_assignment_id, false);
  END IF;

  -- Sync collaborator permissions for every target group that already has a repo.
  -- create_all_repos_for_assignment_internal only CREATES missing repos; it never
  -- re-syncs members on repos that already exist, so members copied into a
  -- pre-existing group repo would otherwise never be granted write access. The
  -- async worker requeues sync_repo_permissions until the repo is GitHub-ready.
  FOR v_repo_record IN
    SELECT r.repository, r.assignment_group_id
    FROM repositories r
    JOIN assignment_groups ag ON ag.id = r.assignment_group_id
    WHERE ag.assignment_id = p_target_assignment_id
      AND ag.class_id = p_class_id
      AND r.repository IS NOT NULL
      AND position('/' in r.repository) > 0
      AND r.git_provider = 'github'
  LOOP
    DECLARE
      v_usernames text[];
    BEGIN
      SELECT coalesce(array_remove(array_agg(u.github_username), null), '{}')
        INTO v_usernames
      FROM assignment_groups_members agm
      JOIN user_roles ur ON ur.private_profile_id = agm.profile_id
      JOIN users u ON u.user_id = ur.user_id
      WHERE agm.assignment_group_id = v_repo_record.assignment_group_id
        AND ur.class_id = p_class_id
        AND ur.role = 'student'
        AND ur.github_org_confirmed = true
        AND u.github_username IS NOT NULL
        AND u.github_username <> '';

      -- Enqueue even when v_usernames is empty so the worker reconciles (revokes) stale access on
      -- repos whose membership changed; v_usernames is coalesced to '{}' above, never null.
      IF v_github_org IS NOT NULL THEN
        PERFORM enqueue_github_sync_repo_permissions(
          p_class_id,
          v_github_org,
          substring(v_repo_record.repository from position('/' in v_repo_record.repository) + 1),
          v_course_slug,
          v_usernames,
          'copy-groups-sync-' || v_repo_record.assignment_group_id::text
        );
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'groups_processed', v_groups_processed,
    'members_copied', v_members_copied,
    'memberships_removed', v_memberships_removed,
    'groups_deleted', v_groups_deleted,
    'groups_preserved', v_groups_preserved
  );
END;
$$;

REVOKE ALL ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Privacy fix: group memberships are visible only inside their own class
-- ---------------------------------------------------------------------------

-- Both SELECT policies compared ur.class_id = ur.class_id (always true), so anyone enrolled in any
-- class could read every class's group memberships. Instructors are enrolled in their class, so the
-- fixed policy covers them and the instructor-only one is dropped.
ALTER POLICY "anyone in class can see all" ON public.assignment_groups_members
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_privileges ur
      WHERE ur.user_id = auth.uid()
        AND ur.class_id = assignment_groups_members.class_id
    )
  );

DROP POLICY IF EXISTS "Instructors can view group members" ON public.assignment_groups_members;
