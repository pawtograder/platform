-- Extend cache invalidation to include Next.js unstable_cache tags (course dashboards, manage lists).
-- Existing triggers already fire on assignments INSERT/UPDATE/DELETE via invalidate_class_scoped_cache.

CREATE OR REPLACE FUNCTION public.invalidate_class_scoped_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  class_ids bigint[];
  class_id_value bigint;
  table_name text;
  tags text[];
  user_ids uuid[];
  uid uuid;
BEGIN
  table_name := TG_TABLE_NAME;

  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT class_id ORDER BY class_id)
    INTO class_ids
    FROM old_table
    WHERE class_id IS NOT NULL;
  ELSE
    SELECT ARRAY_AGG(DISTINCT class_id ORDER BY class_id)
    INTO class_ids
    FROM new_table
    WHERE class_id IS NOT NULL;
  END IF;

  IF class_ids IS NULL OR array_length(class_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOREACH class_id_value IN ARRAY class_ids
  LOOP
    tags := ARRAY[
      table_name || ':' || class_id_value || ':staff',
      table_name || ':' || class_id_value || ':student'
    ];
    PERFORM public.call_cache_invalidate(tags);

    -- Next.js unstable_cache tags (lib/next-cache-tags.ts, lib/course-dashboard-cache.ts)
    tags := ARRAY[
      'course:' || class_id_value || ':assignments-overview',
      'course:' || class_id_value || ':instructor-dashboard',
      'course:' || class_id_value || ':student-dashboard',
      'course:' || class_id_value || ':flashcard-decks'
    ];
    PERFORM public.call_cache_invalidate(tags);
  END LOOP;

  -- Course picker cache (lib/server-route-cache getCachedUserCoursesWithClasses)
  IF table_name = 'user_roles' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT ARRAY_AGG(DISTINCT user_id ORDER BY user_id)
      INTO user_ids
      FROM old_table
      WHERE user_id IS NOT NULL;
    ELSE
      SELECT ARRAY_AGG(DISTINCT user_id ORDER BY user_id)
      INTO user_ids
      FROM new_table
      WHERE user_id IS NOT NULL;
    END IF;

    IF user_ids IS NOT NULL AND array_length(user_ids, 1) IS NOT NULL THEN
      FOREACH uid IN ARRAY user_ids
      LOOP
        PERFORM public.call_cache_invalidate(ARRAY['user:' || uid::text || ':courses']);
      END LOOP;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.invalidate_admin_platform_stats_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.call_cache_invalidate(ARRAY['admin:dashboard-stats']);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS invalidate_classes_admin_stats_insert ON public.classes;
DROP TRIGGER IF EXISTS invalidate_classes_admin_stats_update ON public.classes;
DROP TRIGGER IF EXISTS invalidate_classes_admin_stats_delete ON public.classes;

CREATE TRIGGER invalidate_classes_admin_stats_insert
  AFTER INSERT ON public.classes
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_admin_platform_stats_cache();

CREATE TRIGGER invalidate_classes_admin_stats_update
  AFTER UPDATE ON public.classes
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_admin_platform_stats_cache();

CREATE TRIGGER invalidate_classes_admin_stats_delete
  AFTER DELETE ON public.classes
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_admin_platform_stats_cache();

DROP TRIGGER IF EXISTS invalidate_users_admin_stats_insert ON public.users;
DROP TRIGGER IF EXISTS invalidate_users_admin_stats_update ON public.users;
DROP TRIGGER IF EXISTS invalidate_users_admin_stats_delete ON public.users;

CREATE TRIGGER invalidate_users_admin_stats_insert
  AFTER INSERT ON public.users
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_admin_platform_stats_cache();

CREATE TRIGGER invalidate_users_admin_stats_update
  AFTER UPDATE ON public.users
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_admin_platform_stats_cache();

CREATE TRIGGER invalidate_users_admin_stats_delete
  AFTER DELETE ON public.users
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_admin_platform_stats_cache();

-- flashcard_decks: invalidate class-scoped Next.js caches (deck list uses unstable_cache)
DROP TRIGGER IF EXISTS invalidate_flashcard_decks_cache_insert ON public.flashcard_decks;
DROP TRIGGER IF EXISTS invalidate_flashcard_decks_cache_update ON public.flashcard_decks;
DROP TRIGGER IF EXISTS invalidate_flashcard_decks_cache_delete ON public.flashcard_decks;

CREATE TRIGGER invalidate_flashcard_decks_cache_insert
  AFTER INSERT ON public.flashcard_decks
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_flashcard_decks_cache_update
  AFTER UPDATE ON public.flashcard_decks
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_flashcard_decks_cache_delete
  AFTER DELETE ON public.flashcard_decks
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();
