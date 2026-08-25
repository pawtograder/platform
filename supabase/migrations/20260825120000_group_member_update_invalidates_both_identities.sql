-- Follow-up to #939 (CodeRabbit review): on UPDATE, invalidate the membership row's PREVIOUS
-- identity as well as its new one.
--
-- `invalidate_assignment_group_members_cache` read `old_table` for DELETE and `new_table`
-- otherwise. For INSERT and DELETE that is complete, but an UPDATE that moves a row to a
-- different `class_id` or `assignment_id` invalidated only the destination — the source class's
-- `assignment_groups:<class>:<role>` / `user_roles:<class>:<role>` bundles and the source
-- assignment's `assignment_groups:<assignment>:<role>` bundle kept serving a roster that still
-- listed the student, for the full 1-hour TTL.
--
-- Narrow in practice: the known bulk path (`publish_assignment_group_changes`) moves students
-- with a delete plus an insert, which was always covered. But `authenticated` and `service_role`
-- both hold UPDATE on the table, so the gap is reachable, and a stale group roster is exactly
-- the failure #939 set out to fix.
--
-- Note this is the same DELETE/else shape used by the older `invalidate_class_scoped_cache`,
-- `invalidate_assignment_scoped_cache` and `invalidate_assignment_groups_cache` in
-- 20251228131640, which have the same gap. Deliberately not changed here: those cover many more
-- tables and deserve their own change rather than riding along with this one.
CREATE OR REPLACE FUNCTION public.invalidate_assignment_group_members_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  class_ids bigint[];
  assignment_ids bigint[];
  class_id_value bigint;
  assignment_id_value bigint;
  tags text[] := ARRAY[]::text[];
  dedupe_key text;
BEGIN
  -- UPDATE unions both transition tables so a moved row invalidates the identity it left as
  -- well as the one it arrived at. INSERT has no old_table and DELETE has no new_table, so each
  -- branch reads only what exists for that operation.
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT class_id ORDER BY class_id), ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO class_ids, assignment_ids
    FROM old_table;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT ARRAY_AGG(DISTINCT class_id ORDER BY class_id), ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO class_ids, assignment_ids
    FROM (
      SELECT class_id, assignment_id FROM old_table
      UNION
      SELECT class_id, assignment_id FROM new_table
    ) AS both_identities;
  ELSE
    SELECT ARRAY_AGG(DISTINCT class_id ORDER BY class_id), ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO class_ids, assignment_ids
    FROM new_table;
  END IF;

  IF class_ids IS NOT NULL AND array_length(class_ids, 1) IS NOT NULL THEN
    FOREACH class_id_value IN ARRAY class_ids
    LOOP
      tags := tags || ARRAY[
        'assignment_groups:' || class_id_value || ':staff',
        'assignment_groups:' || class_id_value || ':student',
        'user_roles:' || class_id_value || ':staff',
        'user_roles:' || class_id_value || ':student'
      ];
    END LOOP;
  END IF;

  IF assignment_ids IS NOT NULL AND array_length(assignment_ids, 1) IS NOT NULL THEN
    FOREACH assignment_id_value IN ARRAY assignment_ids
    LOOP
      tags := tags || ARRAY[
        'assignment_groups:' || assignment_id_value || ':staff',
        'assignment_groups:' || assignment_id_value || ':student'
      ];
    END LOOP;
  END IF;

  IF array_length(tags, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Unchanged from #939: one pg_net request per distinct tag set per transaction, so the
  -- per-row loop in publish_assignment_group_changes cannot queue a storm of duplicates.
  dedupe_key := 'pawtograder.ci_' || md5(array_to_string(tags, ','));
  IF COALESCE(current_setting(dedupe_key, true), '') = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  PERFORM set_config(dedupe_key, '1', true);

  PERFORM public.call_cache_invalidate(tags);

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_assignment_group_members_cache FROM PUBLIC;
