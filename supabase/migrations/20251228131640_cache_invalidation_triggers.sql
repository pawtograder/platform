-- Migration: Cache Invalidation Triggers
-- Implements automatic Vercel cache invalidation via PostgreSQL statement-level triggers
-- When data changes in cached tables, triggers call Next.js API to invalidate relevant cache tags

-- ============================================================================
-- VAULT SECRETS
-- ============================================================================

-- Add vault secrets for cache invalidation
-- Note: These need to be set manually via Supabase dashboard or CLI:
--   vault.create_secret('https://your-app.vercel.app', 'vercel_host');
--   vault.create_secret('your-secret-value', 'cache_invalidation_secret');

-- ============================================================================
-- HELPER FUNCTION: Call Cache Invalidation API
-- ============================================================================

-- Helper function to call Next.js cache invalidation endpoint via pg_net
CREATE OR REPLACE FUNCTION public.call_cache_invalidate(tags text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  request_id bigint;
  payload jsonb;
  vercel_host text;
  cache_invalidation_secret text;
  full_url text;
  headers jsonb;
BEGIN
  -- Validate tags array
  IF tags IS NULL OR array_length(tags, 1) IS NULL OR array_length(tags, 1) = 0 THEN
    RETURN;
  END IF;

  -- Retrieve secrets from vault
  SELECT decrypted_secret INTO vercel_host
  FROM vault.decrypted_secrets
  WHERE name = 'vercel_host';

  IF vercel_host IS NULL OR vercel_host = 'null' THEN
    RAISE WARNING 'vercel_host secret is missing or invalid, skipping cache invalidation';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO cache_invalidation_secret
  FROM vault.decrypted_secrets
  WHERE name = 'cache_invalidation_secret';

  IF cache_invalidation_secret IS NULL OR cache_invalidation_secret = 'null' THEN
    RAISE WARNING 'cache_invalidation_secret is missing or invalid, skipping cache invalidation';
    RETURN;
  END IF;

  -- Build full URL
  full_url := vercel_host || '/api/cache/invalidate';

  -- Build headers with secret
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cache-invalidation-secret', cache_invalidation_secret
  );

  -- Build payload with tags array
  payload := jsonb_build_object('tags', tags);

  -- Make async HTTP POST request (non-blocking)
  SELECT http_post INTO request_id FROM net.http_post(
    full_url,
    payload,
    '{}'::jsonb,
    headers,
    5000  -- 5 second timeout
  );

  -- Note: request_id is returned but we don't wait for the response
  -- The HTTP request happens asynchronously and won't block the transaction
END;
$$;

REVOKE ALL ON FUNCTION public.call_cache_invalidate FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.call_cache_invalidate TO service_role;

-- ============================================================================
-- GENERIC CACHE INVALIDATION TRIGGER FUNCTIONS
-- ============================================================================

-- Generic function for class-scoped tables
-- Extracts class_id from transition table and invalidates both staff and student caches
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
BEGIN
  table_name := TG_TABLE_NAME;

  -- Extract unique class_ids from transition table
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

  -- If no class_ids found, exit early
  IF class_ids IS NULL OR array_length(class_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Invalidate cache for each affected class (both staff and student)
  FOREACH class_id_value IN ARRAY class_ids
  LOOP
    tags := ARRAY[
      table_name || ':' || class_id_value || ':staff',
      table_name || ':' || class_id_value || ':student'
    ];
    PERFORM public.call_cache_invalidate(tags);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Generic function for assignment-scoped tables
-- Extracts assignment_id from transition table and invalidates both staff and student caches
CREATE OR REPLACE FUNCTION public.invalidate_assignment_scoped_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  assignment_ids bigint[];
  assignment_id_value bigint;
  table_name text;
  tags text[];
BEGIN
  table_name := TG_TABLE_NAME;

  -- Extract unique assignment_ids from transition table
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO assignment_ids
    FROM old_table
    WHERE assignment_id IS NOT NULL;
  ELSE
    SELECT ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO assignment_ids
    FROM new_table
    WHERE assignment_id IS NOT NULL;
  END IF;

  -- If no assignment_ids found, exit early
  IF assignment_ids IS NULL OR array_length(assignment_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Invalidate cache for each affected assignment (both staff and student)
  FOREACH assignment_id_value IN ARRAY assignment_ids
  LOOP
    tags := ARRAY[
      table_name || ':' || assignment_id_value || ':staff',
      table_name || ':' || assignment_id_value || ':student'
    ];
    PERFORM public.call_cache_invalidate(tags);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Special function for assignment_groups (has both class_id and assignment_id)
CREATE OR REPLACE FUNCTION public.invalidate_assignment_groups_cache()
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
  tags text[];
BEGIN
  -- Extract unique class_ids and assignment_ids from transition table
  IF TG_OP = 'DELETE' THEN
    SELECT 
      ARRAY_AGG(DISTINCT class_id ORDER BY class_id),
      ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO class_ids, assignment_ids
    FROM old_table
    WHERE class_id IS NOT NULL OR assignment_id IS NOT NULL;
  ELSE
    SELECT 
      ARRAY_AGG(DISTINCT class_id ORDER BY class_id),
      ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO class_ids, assignment_ids
    FROM new_table
    WHERE class_id IS NOT NULL OR assignment_id IS NOT NULL;
  END IF;

  -- Invalidate class-scoped cache
  IF class_ids IS NOT NULL AND array_length(class_ids, 1) IS NOT NULL THEN
    FOREACH class_id_value IN ARRAY class_ids
    LOOP
      tags := ARRAY[
        'assignment_groups:' || class_id_value || ':staff',
        'assignment_groups:' || class_id_value || ':student'
      ];
      PERFORM public.call_cache_invalidate(tags);
    END LOOP;
  END IF;

  -- Invalidate assignment-scoped cache
  IF assignment_ids IS NOT NULL AND array_length(assignment_ids, 1) IS NOT NULL THEN
    FOREACH assignment_id_value IN ARRAY assignment_ids
    LOOP
      tags := ARRAY[
        'assignment_groups:' || assignment_id_value || ':staff',
        'assignment_groups:' || assignment_id_value || ':student'
      ];
      PERFORM public.call_cache_invalidate(tags);
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Submissions are not cached, so no cache invalidation function needed

-- Special function for review_assignments (has assignment_id)
CREATE OR REPLACE FUNCTION public.invalidate_review_assignments_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  assignment_ids bigint[];
  assignment_id_value bigint;
  tags text[];
BEGIN
  -- Extract unique assignment_ids from transition table
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO assignment_ids
    FROM old_table
    WHERE assignment_id IS NOT NULL;
  ELSE
    SELECT ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO assignment_ids
    FROM new_table
    WHERE assignment_id IS NOT NULL;
  END IF;

  -- If no assignment_ids found, exit early
  IF assignment_ids IS NULL OR array_length(assignment_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Invalidate cache for each affected assignment (both staff and student)
  FOREACH assignment_id_value IN ARRAY assignment_ids
  LOOP
    tags := ARRAY[
      'review_assignments:' || assignment_id_value || ':staff',
      'review_assignments:' || assignment_id_value || ':student'
    ];
    PERFORM public.call_cache_invalidate(tags);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Special function for submission_regrade_requests (has assignment_id)
CREATE OR REPLACE FUNCTION public.invalidate_regrade_requests_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  assignment_ids bigint[];
  assignment_id_value bigint;
  tags text[];
BEGIN
  -- Extract unique assignment_ids from transition table
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO assignment_ids
    FROM old_table
    WHERE assignment_id IS NOT NULL;
  ELSE
    SELECT ARRAY_AGG(DISTINCT assignment_id ORDER BY assignment_id)
    INTO assignment_ids
    FROM new_table
    WHERE assignment_id IS NOT NULL;
  END IF;

  -- If no assignment_ids found, exit early
  IF assignment_ids IS NULL OR array_length(assignment_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Invalidate cache for each affected assignment (both staff and student)
  -- Note: Tag uses 'regrade_requests' but table is 'submission_regrade_requests'
  FOREACH assignment_id_value IN ARRAY assignment_ids
  LOOP
    tags := ARRAY[
      'regrade_requests:' || assignment_id_value || ':staff',
      'regrade_requests:' || assignment_id_value || ':student'
    ];
    PERFORM public.call_cache_invalidate(tags);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Special function for discussion_threads (uses root_class_id)
CREATE OR REPLACE FUNCTION public.invalidate_discussion_threads_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  class_ids bigint[];
  class_id_value bigint;
  tags text[];
BEGIN
  -- Extract unique root_class_ids from transition table
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT root_class_id ORDER BY root_class_id)
    INTO class_ids
    FROM old_table
    WHERE root_class_id IS NOT NULL;
  ELSE
    SELECT ARRAY_AGG(DISTINCT root_class_id ORDER BY root_class_id)
    INTO class_ids
    FROM new_table
    WHERE root_class_id IS NOT NULL;
  END IF;

  -- If no class_ids found, exit early
  IF class_ids IS NULL OR array_length(class_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Invalidate cache for each affected class (both staff and student)
  FOREACH class_id_value IN ARRAY class_ids
  LOOP
    tags := ARRAY[
      'discussion_threads:' || class_id_value || ':staff',
      'discussion_threads:' || class_id_value || ':student'
    ];
    PERFORM public.call_cache_invalidate(tags);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ============================================================================
-- STATEMENT-LEVEL TRIGGERS FOR CLASS-SCOPED TABLES
-- ============================================================================

-- Profiles
DROP TRIGGER IF EXISTS invalidate_profiles_cache_insert ON public.profiles;
DROP TRIGGER IF EXISTS invalidate_profiles_cache_update ON public.profiles;
DROP TRIGGER IF EXISTS invalidate_profiles_cache_delete ON public.profiles;

CREATE TRIGGER invalidate_profiles_cache_insert
  AFTER INSERT ON public.profiles
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_profiles_cache_update
  AFTER UPDATE ON public.profiles
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_profiles_cache_delete
  AFTER DELETE ON public.profiles
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- User roles
DROP TRIGGER IF EXISTS invalidate_user_roles_cache_insert ON public.user_roles;
DROP TRIGGER IF EXISTS invalidate_user_roles_cache_update ON public.user_roles;
DROP TRIGGER IF EXISTS invalidate_user_roles_cache_delete ON public.user_roles;

CREATE TRIGGER invalidate_user_roles_cache_insert
  AFTER INSERT ON public.user_roles
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_user_roles_cache_update
  AFTER UPDATE ON public.user_roles
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_user_roles_cache_delete
  AFTER DELETE ON public.user_roles
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Discussion threads (uses root_class_id)
DROP TRIGGER IF EXISTS invalidate_discussion_threads_cache_insert ON public.discussion_threads;
DROP TRIGGER IF EXISTS invalidate_discussion_threads_cache_update ON public.discussion_threads;
DROP TRIGGER IF EXISTS invalidate_discussion_threads_cache_delete ON public.discussion_threads;

CREATE TRIGGER invalidate_discussion_threads_cache_insert
  AFTER INSERT ON public.discussion_threads
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_discussion_threads_cache();

CREATE TRIGGER invalidate_discussion_threads_cache_update
  AFTER UPDATE ON public.discussion_threads
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_discussion_threads_cache();

CREATE TRIGGER invalidate_discussion_threads_cache_delete
  AFTER DELETE ON public.discussion_threads
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_discussion_threads_cache();

-- Tags
DROP TRIGGER IF EXISTS invalidate_tags_cache_insert ON public.tags;
DROP TRIGGER IF EXISTS invalidate_tags_cache_update ON public.tags;
DROP TRIGGER IF EXISTS invalidate_tags_cache_delete ON public.tags;

CREATE TRIGGER invalidate_tags_cache_insert
  AFTER INSERT ON public.tags
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_tags_cache_update
  AFTER UPDATE ON public.tags
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_tags_cache_delete
  AFTER DELETE ON public.tags
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Lab sections
DROP TRIGGER IF EXISTS invalidate_lab_sections_cache_insert ON public.lab_sections;
DROP TRIGGER IF EXISTS invalidate_lab_sections_cache_update ON public.lab_sections;
DROP TRIGGER IF EXISTS invalidate_lab_sections_cache_delete ON public.lab_sections;

CREATE TRIGGER invalidate_lab_sections_cache_insert
  AFTER INSERT ON public.lab_sections
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_lab_sections_cache_update
  AFTER UPDATE ON public.lab_sections
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_lab_sections_cache_delete
  AFTER DELETE ON public.lab_sections
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Lab section meetings
DROP TRIGGER IF EXISTS invalidate_lab_section_meetings_cache_insert ON public.lab_section_meetings;
DROP TRIGGER IF EXISTS invalidate_lab_section_meetings_cache_update ON public.lab_section_meetings;
DROP TRIGGER IF EXISTS invalidate_lab_section_meetings_cache_delete ON public.lab_section_meetings;

CREATE TRIGGER invalidate_lab_section_meetings_cache_insert
  AFTER INSERT ON public.lab_section_meetings
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_lab_section_meetings_cache_update
  AFTER UPDATE ON public.lab_section_meetings
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_lab_section_meetings_cache_delete
  AFTER DELETE ON public.lab_section_meetings
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Class sections
DROP TRIGGER IF EXISTS invalidate_class_sections_cache_insert ON public.class_sections;
DROP TRIGGER IF EXISTS invalidate_class_sections_cache_update ON public.class_sections;
DROP TRIGGER IF EXISTS invalidate_class_sections_cache_delete ON public.class_sections;

CREATE TRIGGER invalidate_class_sections_cache_insert
  AFTER INSERT ON public.class_sections
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_class_sections_cache_update
  AFTER UPDATE ON public.class_sections
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_class_sections_cache_delete
  AFTER DELETE ON public.class_sections
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Student deadline extensions
DROP TRIGGER IF EXISTS invalidate_student_deadline_extensions_cache_insert ON public.student_deadline_extensions;
DROP TRIGGER IF EXISTS invalidate_student_deadline_extensions_cache_update ON public.student_deadline_extensions;
DROP TRIGGER IF EXISTS invalidate_student_deadline_extensions_cache_delete ON public.student_deadline_extensions;

CREATE TRIGGER invalidate_student_deadline_extensions_cache_insert
  AFTER INSERT ON public.student_deadline_extensions
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_student_deadline_extensions_cache_update
  AFTER UPDATE ON public.student_deadline_extensions
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_student_deadline_extensions_cache_delete
  AFTER DELETE ON public.student_deadline_extensions
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Assignment due date exceptions
DROP TRIGGER IF EXISTS invalidate_assignment_due_date_exceptions_cache_insert ON public.assignment_due_date_exceptions;
DROP TRIGGER IF EXISTS invalidate_assignment_due_date_exceptions_cache_update ON public.assignment_due_date_exceptions;
DROP TRIGGER IF EXISTS invalidate_assignment_due_date_exceptions_cache_delete ON public.assignment_due_date_exceptions;

CREATE TRIGGER invalidate_assignment_due_date_exceptions_cache_insert
  AFTER INSERT ON public.assignment_due_date_exceptions
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_assignment_due_date_exceptions_cache_update
  AFTER UPDATE ON public.assignment_due_date_exceptions
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_assignment_due_date_exceptions_cache_delete
  AFTER DELETE ON public.assignment_due_date_exceptions
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Assignments
DROP TRIGGER IF EXISTS invalidate_assignments_cache_insert ON public.assignments;
DROP TRIGGER IF EXISTS invalidate_assignments_cache_update ON public.assignments;
DROP TRIGGER IF EXISTS invalidate_assignments_cache_delete ON public.assignments;

CREATE TRIGGER invalidate_assignments_cache_insert
  AFTER INSERT ON public.assignments
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_assignments_cache_update
  AFTER UPDATE ON public.assignments
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_assignments_cache_delete
  AFTER DELETE ON public.assignments
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Assignment groups (special handling - has both class_id and assignment_id)
DROP TRIGGER IF EXISTS invalidate_assignment_groups_cache_insert ON public.assignment_groups;
DROP TRIGGER IF EXISTS invalidate_assignment_groups_cache_update ON public.assignment_groups;
DROP TRIGGER IF EXISTS invalidate_assignment_groups_cache_delete ON public.assignment_groups;

CREATE TRIGGER invalidate_assignment_groups_cache_insert
  AFTER INSERT ON public.assignment_groups
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_groups_cache();

CREATE TRIGGER invalidate_assignment_groups_cache_update
  AFTER UPDATE ON public.assignment_groups
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_groups_cache();

CREATE TRIGGER invalidate_assignment_groups_cache_delete
  AFTER DELETE ON public.assignment_groups
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_groups_cache();

-- Discussion topics
DROP TRIGGER IF EXISTS invalidate_discussion_topics_cache_insert ON public.discussion_topics;
DROP TRIGGER IF EXISTS invalidate_discussion_topics_cache_update ON public.discussion_topics;
DROP TRIGGER IF EXISTS invalidate_discussion_topics_cache_delete ON public.discussion_topics;

CREATE TRIGGER invalidate_discussion_topics_cache_insert
  AFTER INSERT ON public.discussion_topics
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_discussion_topics_cache_update
  AFTER UPDATE ON public.discussion_topics
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_discussion_topics_cache_delete
  AFTER DELETE ON public.discussion_topics
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Repositories
DROP TRIGGER IF EXISTS invalidate_repositories_cache_insert ON public.repositories;
DROP TRIGGER IF EXISTS invalidate_repositories_cache_update ON public.repositories;
DROP TRIGGER IF EXISTS invalidate_repositories_cache_delete ON public.repositories;

CREATE TRIGGER invalidate_repositories_cache_insert
  AFTER INSERT ON public.repositories
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_repositories_cache_update
  AFTER UPDATE ON public.repositories
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_repositories_cache_delete
  AFTER DELETE ON public.repositories
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Gradebook columns
DROP TRIGGER IF EXISTS invalidate_gradebook_columns_cache_insert ON public.gradebook_columns;
DROP TRIGGER IF EXISTS invalidate_gradebook_columns_cache_update ON public.gradebook_columns;
DROP TRIGGER IF EXISTS invalidate_gradebook_columns_cache_delete ON public.gradebook_columns;

CREATE TRIGGER invalidate_gradebook_columns_cache_insert
  AFTER INSERT ON public.gradebook_columns
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_gradebook_columns_cache_update
  AFTER UPDATE ON public.gradebook_columns
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_gradebook_columns_cache_delete
  AFTER DELETE ON public.gradebook_columns
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Discord channels
DROP TRIGGER IF EXISTS invalidate_discord_channels_cache_insert ON public.discord_channels;
DROP TRIGGER IF EXISTS invalidate_discord_channels_cache_update ON public.discord_channels;
DROP TRIGGER IF EXISTS invalidate_discord_channels_cache_delete ON public.discord_channels;

CREATE TRIGGER invalidate_discord_channels_cache_insert
  AFTER INSERT ON public.discord_channels
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_discord_channels_cache_update
  AFTER UPDATE ON public.discord_channels
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_discord_channels_cache_delete
  AFTER DELETE ON public.discord_channels
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Discord messages
DROP TRIGGER IF EXISTS invalidate_discord_messages_cache_insert ON public.discord_messages;
DROP TRIGGER IF EXISTS invalidate_discord_messages_cache_update ON public.discord_messages;
DROP TRIGGER IF EXISTS invalidate_discord_messages_cache_delete ON public.discord_messages;

CREATE TRIGGER invalidate_discord_messages_cache_insert
  AFTER INSERT ON public.discord_messages
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_discord_messages_cache_update
  AFTER UPDATE ON public.discord_messages
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_discord_messages_cache_delete
  AFTER DELETE ON public.discord_messages
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Surveys
DROP TRIGGER IF EXISTS invalidate_surveys_cache_insert ON public.surveys;
DROP TRIGGER IF EXISTS invalidate_surveys_cache_update ON public.surveys;
DROP TRIGGER IF EXISTS invalidate_surveys_cache_delete ON public.surveys;

CREATE TRIGGER invalidate_surveys_cache_insert
  AFTER INSERT ON public.surveys
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_surveys_cache_update
  AFTER UPDATE ON public.surveys
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_surveys_cache_delete
  AFTER DELETE ON public.surveys
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- Lab section leaders
DROP TRIGGER IF EXISTS invalidate_lab_section_leaders_cache_insert ON public.lab_section_leaders;
DROP TRIGGER IF EXISTS invalidate_lab_section_leaders_cache_update ON public.lab_section_leaders;
DROP TRIGGER IF EXISTS invalidate_lab_section_leaders_cache_delete ON public.lab_section_leaders;

CREATE TRIGGER invalidate_lab_section_leaders_cache_insert
  AFTER INSERT ON public.lab_section_leaders
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_lab_section_leaders_cache_update
  AFTER UPDATE ON public.lab_section_leaders
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

CREATE TRIGGER invalidate_lab_section_leaders_cache_delete
  AFTER DELETE ON public.lab_section_leaders
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_class_scoped_cache();

-- ============================================================================
-- STATEMENT-LEVEL TRIGGERS FOR ASSIGNMENT-SCOPED TABLES
-- ============================================================================

-- Submissions are not cached, so no cache invalidation triggers needed

-- Rubrics
DROP TRIGGER IF EXISTS invalidate_rubrics_cache_insert ON public.rubrics;
DROP TRIGGER IF EXISTS invalidate_rubrics_cache_update ON public.rubrics;
DROP TRIGGER IF EXISTS invalidate_rubrics_cache_delete ON public.rubrics;

CREATE TRIGGER invalidate_rubrics_cache_insert
  AFTER INSERT ON public.rubrics
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubrics_cache_update
  AFTER UPDATE ON public.rubrics
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubrics_cache_delete
  AFTER DELETE ON public.rubrics
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

-- Rubric parts
DROP TRIGGER IF EXISTS invalidate_rubric_parts_cache_insert ON public.rubric_parts;
DROP TRIGGER IF EXISTS invalidate_rubric_parts_cache_update ON public.rubric_parts;
DROP TRIGGER IF EXISTS invalidate_rubric_parts_cache_delete ON public.rubric_parts;

CREATE TRIGGER invalidate_rubric_parts_cache_insert
  AFTER INSERT ON public.rubric_parts
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_parts_cache_update
  AFTER UPDATE ON public.rubric_parts
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_parts_cache_delete
  AFTER DELETE ON public.rubric_parts
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

-- Rubric criteria
DROP TRIGGER IF EXISTS invalidate_rubric_criteria_cache_insert ON public.rubric_criteria;
DROP TRIGGER IF EXISTS invalidate_rubric_criteria_cache_update ON public.rubric_criteria;
DROP TRIGGER IF EXISTS invalidate_rubric_criteria_cache_delete ON public.rubric_criteria;

CREATE TRIGGER invalidate_rubric_criteria_cache_insert
  AFTER INSERT ON public.rubric_criteria
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_criteria_cache_update
  AFTER UPDATE ON public.rubric_criteria
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_criteria_cache_delete
  AFTER DELETE ON public.rubric_criteria
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

-- Rubric checks
DROP TRIGGER IF EXISTS invalidate_rubric_checks_cache_insert ON public.rubric_checks;
DROP TRIGGER IF EXISTS invalidate_rubric_checks_cache_update ON public.rubric_checks;
DROP TRIGGER IF EXISTS invalidate_rubric_checks_cache_delete ON public.rubric_checks;

CREATE TRIGGER invalidate_rubric_checks_cache_insert
  AFTER INSERT ON public.rubric_checks
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_checks_cache_update
  AFTER UPDATE ON public.rubric_checks
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_checks_cache_delete
  AFTER DELETE ON public.rubric_checks
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

-- Rubric check references
DROP TRIGGER IF EXISTS invalidate_rubric_check_references_cache_insert ON public.rubric_check_references;
DROP TRIGGER IF EXISTS invalidate_rubric_check_references_cache_update ON public.rubric_check_references;
DROP TRIGGER IF EXISTS invalidate_rubric_check_references_cache_delete ON public.rubric_check_references;

CREATE TRIGGER invalidate_rubric_check_references_cache_insert
  AFTER INSERT ON public.rubric_check_references
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_check_references_cache_update
  AFTER UPDATE ON public.rubric_check_references
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

CREATE TRIGGER invalidate_rubric_check_references_cache_delete
  AFTER DELETE ON public.rubric_check_references
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_assignment_scoped_cache();

-- Review assignments
DROP TRIGGER IF EXISTS invalidate_review_assignments_cache_insert ON public.review_assignments;
DROP TRIGGER IF EXISTS invalidate_review_assignments_cache_update ON public.review_assignments;
DROP TRIGGER IF EXISTS invalidate_review_assignments_cache_delete ON public.review_assignments;

CREATE TRIGGER invalidate_review_assignments_cache_insert
  AFTER INSERT ON public.review_assignments
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_review_assignments_cache();

CREATE TRIGGER invalidate_review_assignments_cache_update
  AFTER UPDATE ON public.review_assignments
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_review_assignments_cache();

CREATE TRIGGER invalidate_review_assignments_cache_delete
  AFTER DELETE ON public.review_assignments
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_review_assignments_cache();

-- Submission regrade requests
DROP TRIGGER IF EXISTS invalidate_submission_regrade_requests_cache_insert ON public.submission_regrade_requests;
DROP TRIGGER IF EXISTS invalidate_submission_regrade_requests_cache_update ON public.submission_regrade_requests;
DROP TRIGGER IF EXISTS invalidate_submission_regrade_requests_cache_delete ON public.submission_regrade_requests;

CREATE TRIGGER invalidate_submission_regrade_requests_cache_insert
  AFTER INSERT ON public.submission_regrade_requests
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_regrade_requests_cache();

CREATE TRIGGER invalidate_submission_regrade_requests_cache_update
  AFTER UPDATE ON public.submission_regrade_requests
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_regrade_requests_cache();

CREATE TRIGGER invalidate_submission_regrade_requests_cache_delete
  AFTER DELETE ON public.submission_regrade_requests
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.invalidate_regrade_requests_cache();

