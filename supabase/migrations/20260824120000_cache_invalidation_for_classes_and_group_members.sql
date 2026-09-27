-- Cache invalidation for two tables that feed a cached SSR read but had no trigger (issue #937).
--
-- The Next.js fetch cache in lib/ssrUtils.ts keys on exact tag strings and defaults to a 1-hour
-- TTL, so a tag that is read but never emitted means the TTL is the only thing that ever
-- refreshes that data. Two such gaps:
--
--   1. `classes`. `getCourse()` caches `select *` under `course:<class_id>` and every page in a
--      course reads it for the course title and time zone. The only triggers on `classes` emit
--      the constant 'admin:dashboard-stats' — nothing has ever emitted `course:<id>`, so a
--      renamed course or a corrected time zone took up to an hour to appear.
--
--   2. `assignment_groups_members`. Its rows are embedded in two cached queries — the group
--      bundle tagged `assignment_groups:<class_id>:<role>` and the staff roster tagged
--      `user_roles:<class_id>:<role>` — but the table itself had only audit/notification
--      triggers. Adding or removing a student from a group left both bundles stale, so students
--      saw the wrong groupmates.

-- 1. classes -> course:<id>
--
-- Kept separate from invalidate_class_scoped_cache(): that function derives the class from a
-- `class_id` column, and on `classes` the class is the primary key.
CREATE OR REPLACE FUNCTION public.invalidate_course_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  class_ids bigint[];
  class_id_value bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT id ORDER BY id) INTO class_ids FROM old_table WHERE id IS NOT NULL;
  ELSE
    SELECT ARRAY_AGG(DISTINCT id ORDER BY id) INTO class_ids FROM new_table WHERE id IS NOT NULL;
  END IF;

  IF class_ids IS NULL OR array_length(class_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOREACH class_id_value IN ARRAY class_ids
  LOOP
    PERFORM public.call_cache_invalidate(ARRAY['course:' || class_id_value]);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_course_cache FROM PUBLIC;

DROP TRIGGER IF EXISTS invalidate_classes_course_cache_insert ON public.classes;
DROP TRIGGER IF EXISTS invalidate_classes_course_cache_update ON public.classes;
DROP TRIGGER IF EXISTS invalidate_classes_course_cache_delete ON public.classes;

CREATE TRIGGER invalidate_classes_course_cache_insert
  AFTER INSERT ON public.classes
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_course_cache();

CREATE TRIGGER invalidate_classes_course_cache_update
  AFTER UPDATE ON public.classes
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_course_cache();

CREATE TRIGGER invalidate_classes_course_cache_delete
  AFTER DELETE ON public.classes
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_course_cache();

-- 2. assignment_groups_members -> assignment_groups:<class_id|assignment_id>:<role>
--                                and user_roles:<class_id>:<role>
--
-- Mirrors invalidate_assignment_groups_cache()'s class+assignment tag pair, plus the roster
-- bundle, which embeds these rows but is tagged on user_roles.
--
-- Emits ONE pg_net request per distinct tag set per transaction, not per statement.
--
-- `publish_assignment_group_changes` fulfils a manifest by deleting and inserting memberships
-- one row at a time inside a PL/pgSQL loop, so a statement-level trigger fires up to twice per
-- moved student. Every one of those firings would otherwise queue the same tags for the same
-- class and assignment — moving 200 students meant ~800 identical `net.http_post` calls. The
-- transaction-local GUC below collapses that to one, keyed on the tag set so a transaction that
-- genuinely touches a second class or assignment still invalidates both. Tag invalidation is
-- idempotent and pg_net only dispatches after commit, so emitting once per transaction loses
-- nothing.
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
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT class_id ORDER BY class_id), ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO class_ids, assignment_ids
    FROM old_table;
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

  -- md5 keeps the GUC name inside the identifier length limit regardless of how many ids the
  -- statement touched. `set_config(..., true)` scopes the marker to this transaction.
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

DROP TRIGGER IF EXISTS invalidate_assignment_groups_members_cache_insert ON public.assignment_groups_members;
DROP TRIGGER IF EXISTS invalidate_assignment_groups_members_cache_update ON public.assignment_groups_members;
DROP TRIGGER IF EXISTS invalidate_assignment_groups_members_cache_delete ON public.assignment_groups_members;

CREATE TRIGGER invalidate_assignment_groups_members_cache_insert
  AFTER INSERT ON public.assignment_groups_members
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_group_members_cache();

CREATE TRIGGER invalidate_assignment_groups_members_cache_update
  AFTER UPDATE ON public.assignment_groups_members
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_group_members_cache();

CREATE TRIGGER invalidate_assignment_groups_members_cache_delete
  AFTER DELETE ON public.assignment_groups_members
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_group_members_cache();
