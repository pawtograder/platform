-- Cache Invalidation System for Vercel Data Cache
-- This system provides low-overhead cache invalidation with built-in debouncing
-- using 5-second time buckets to prevent invalidation stampedes

-- ============================================================================
-- 1. Cache Invalidation Queue Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cache_invalidation_queue (
  tag text NOT NULL,
  time_bucket timestamp with time zone NOT NULL,
  invalidation_count int DEFAULT 1 NOT NULL,
  last_invalidated_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (tag, time_bucket)
);

ALTER TABLE public.cache_invalidation_queue OWNER TO postgres;

COMMENT ON TABLE public.cache_invalidation_queue IS 'Queue for Vercel cache tag invalidations with 5-second debouncing buckets';
COMMENT ON COLUMN public.cache_invalidation_queue.tag IS 'Cache tag to invalidate (e.g., course_controller:123:staff)';
COMMENT ON COLUMN public.cache_invalidation_queue.time_bucket IS '5-second time bucket for debouncing (e.g., 10:15:05, 10:15:10)';
COMMENT ON COLUMN public.cache_invalidation_queue.invalidation_count IS 'Number of updates that triggered this invalidation';
COMMENT ON COLUMN public.cache_invalidation_queue.last_invalidated_at IS 'When the invalidation was actually processed (NULL if pending)';

-- Index for worker polling (finds pending invalidations efficiently)
CREATE INDEX idx_cache_invalidation_pending 
ON public.cache_invalidation_queue(time_bucket, last_invalidated_at) 
WHERE last_invalidated_at IS NULL OR last_invalidated_at < time_bucket;

-- Index for cleanup (old processed rows)
CREATE INDEX idx_cache_invalidation_cleanup
ON public.cache_invalidation_queue(created_at)
WHERE last_invalidated_at IS NOT NULL;

-- ============================================================================
-- 2. Helper View for Latest Invalidation Per Tag
-- ============================================================================

CREATE OR REPLACE VIEW public.cache_invalidation_latest AS
SELECT 
  tag,
  MAX(COALESCE(last_invalidated_at, time_bucket)) as last_invalidated_at,
  SUM(invalidation_count) as total_invalidations,
  MAX(created_at) as latest_created_at
FROM public.cache_invalidation_queue
GROUP BY tag;

ALTER VIEW public.cache_invalidation_latest OWNER TO postgres;

COMMENT ON VIEW public.cache_invalidation_latest IS 'Latest invalidation timestamp per cache tag for client watermarking';

-- ============================================================================
-- 3. Statement-Level Trigger Function
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enqueue_cache_invalidation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket timestamp with time zone;
  v_class_id bigint;
  v_assignment_id bigint;
BEGIN
  -- Calculate 5-second bucket for debouncing
  -- Examples: 10:15:07 → 10:15:05, 10:15:12 → 10:15:10, 10:15:18 → 10:15:15
  v_bucket := date_trunc('minute', now()) 
              + (floor(extract(second from now()) / 5) * 5) * interval '1 second';
  
  -- Extract class_id and assignment_id from the affected row(s)
  IF TG_OP = 'DELETE' THEN
    v_class_id := OLD.class_id;
    IF TG_TABLE_NAME IN ('assignments', 'assignment_groups', 'assignment_due_date_exceptions', 
                          'submissions', 'review_assignments', 'submission_regrade_requests') THEN
      v_assignment_id := OLD.assignment_id;
    END IF;
  ELSE
    v_class_id := NEW.class_id;
    IF TG_TABLE_NAME IN ('assignments', 'assignment_groups', 'assignment_due_date_exceptions',
                          'submissions', 'review_assignments', 'submission_regrade_requests') THEN
      v_assignment_id := NEW.assignment_id;
    END IF;
  END IF;
  
  -- Enqueue invalidations based on table
  CASE TG_TABLE_NAME
    -- Course-level tables (invalidate course_controller cache)
    WHEN 'user_roles', 'profiles', 'tags', 'lab_sections', 'lab_section_meetings', 
         'class_sections', 'discussion_topics', 'discussion_threads',
         'gradebook_columns', 'repositories' THEN
      -- Invalidate both staff and student variants
      INSERT INTO public.cache_invalidation_queue (tag, time_bucket, invalidation_count)
      VALUES 
        ('course_controller:' || v_class_id || ':staff', v_bucket, 1),
        ('course_controller:' || v_class_id || ':student', v_bucket, 1)
      ON CONFLICT (tag, time_bucket) 
      DO UPDATE SET 
        invalidation_count = cache_invalidation_queue.invalidation_count + 1;
      
    -- Assignments table (invalidate course + assignment caches)
    WHEN 'assignments' THEN
      INSERT INTO public.cache_invalidation_queue (tag, time_bucket, invalidation_count)
      VALUES 
        ('course_controller:' || v_class_id || ':staff', v_bucket, 1),
        ('course_controller:' || v_class_id || ':student', v_bucket, 1),
        ('assignment_controller:' || COALESCE(v_assignment_id, NEW.id) || ':staff', v_bucket, 1),
        ('assignment_controller:' || COALESCE(v_assignment_id, NEW.id) || ':student', v_bucket, 1)
      ON CONFLICT (tag, time_bucket)
      DO UPDATE SET 
        invalidation_count = cache_invalidation_queue.invalidation_count + 1;
    
    -- Due date exceptions (invalidate course + specific assignment)
    WHEN 'assignment_due_date_exceptions', 'student_deadline_extensions' THEN
      -- Invalidate course controller
      INSERT INTO public.cache_invalidation_queue (tag, time_bucket, invalidation_count)
      VALUES 
        ('course_controller:' || v_class_id || ':staff', v_bucket, 1),
        ('course_controller:' || v_class_id || ':student', v_bucket, 1)
      ON CONFLICT (tag, time_bucket)
      DO UPDATE SET 
        invalidation_count = cache_invalidation_queue.invalidation_count + 1;
      
      -- Also invalidate affected assignment if we have assignment_id
      IF v_assignment_id IS NOT NULL THEN
        INSERT INTO public.cache_invalidation_queue (tag, time_bucket, invalidation_count)
        VALUES 
          ('assignment_controller:' || v_assignment_id || ':staff', v_bucket, 1),
          ('assignment_controller:' || v_assignment_id || ':student', v_bucket, 1)
        ON CONFLICT (tag, time_bucket)
        DO UPDATE SET 
          invalidation_count = cache_invalidation_queue.invalidation_count + 1;
      END IF;
    
    -- Assignment-specific tables
    WHEN 'assignment_groups', 'submissions', 'review_assignments', 
         'submission_regrade_requests', 'rubrics', 'rubric_parts', 
         'rubric_criteria', 'rubric_checks' THEN
      IF v_assignment_id IS NOT NULL THEN
        INSERT INTO public.cache_invalidation_queue (tag, time_bucket, invalidation_count)
        VALUES 
          ('assignment_controller:' || v_assignment_id || ':staff', v_bucket, 1),
          ('assignment_controller:' || v_assignment_id || ':student', v_bucket, 1)
        ON CONFLICT (tag, time_bucket)
        DO UPDATE SET 
          invalidation_count = cache_invalidation_queue.invalidation_count + 1;
      END IF;
      
  END CASE;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;

ALTER FUNCTION public.enqueue_cache_invalidation() OWNER TO postgres;

COMMENT ON FUNCTION public.enqueue_cache_invalidation() IS 'Statement-level trigger to enqueue cache invalidations with 5-second debouncing';

-- ============================================================================
-- 4. Attach Triggers to Tables
-- ============================================================================

-- Course-level tables
CREATE TRIGGER trigger_cache_invalidation_user_roles
  AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_profiles
  AFTER INSERT OR UPDATE OR DELETE ON public.profiles
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_tags
  AFTER INSERT OR UPDATE OR DELETE ON public.tags
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_lab_sections
  AFTER INSERT OR UPDATE OR DELETE ON public.lab_sections
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_lab_section_meetings
  AFTER INSERT OR UPDATE OR DELETE ON public.lab_section_meetings
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_class_sections
  AFTER INSERT OR UPDATE OR DELETE ON public.class_sections
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_discussion_topics
  AFTER INSERT OR UPDATE OR DELETE ON public.discussion_topics
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_discussion_threads
  AFTER INSERT OR UPDATE OR DELETE ON public.discussion_threads
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_gradebook_columns
  AFTER INSERT OR UPDATE OR DELETE ON public.gradebook_columns
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_repositories
  AFTER INSERT OR UPDATE OR DELETE ON public.repositories
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

-- Assignment and due date tables
CREATE TRIGGER trigger_cache_invalidation_assignments
  AFTER INSERT OR UPDATE OR DELETE ON public.assignments
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_assignment_due_date_exceptions
  AFTER INSERT OR UPDATE OR DELETE ON public.assignment_due_date_exceptions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_student_deadline_extensions
  AFTER INSERT OR UPDATE OR DELETE ON public.student_deadline_extensions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

-- Assignment-specific tables
CREATE TRIGGER trigger_cache_invalidation_assignment_groups
  AFTER INSERT OR UPDATE OR DELETE ON public.assignment_groups
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_submissions
  AFTER INSERT OR UPDATE OR DELETE ON public.submissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_review_assignments
  AFTER INSERT OR UPDATE OR DELETE ON public.review_assignments
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_submission_regrade_requests
  AFTER INSERT OR UPDATE OR DELETE ON public.submission_regrade_requests
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_rubrics
  AFTER INSERT OR UPDATE OR DELETE ON public.rubrics
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_rubric_parts
  AFTER INSERT OR UPDATE OR DELETE ON public.rubric_parts
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_rubric_criteria
  AFTER INSERT OR UPDATE OR DELETE ON public.rubric_criteria
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

CREATE TRIGGER trigger_cache_invalidation_rubric_checks
  AFTER INSERT OR UPDATE OR DELETE ON public.rubric_checks
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enqueue_cache_invalidation();

-- ============================================================================
-- 5. Cleanup Function (Called by Worker Periodically)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_old_cache_invalidations()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete processed invalidations older than 1 hour
  DELETE FROM public.cache_invalidation_queue
  WHERE created_at < now() - interval '1 hour'
    AND last_invalidated_at IS NOT NULL;
END;
$$;

ALTER FUNCTION public.cleanup_old_cache_invalidations() OWNER TO postgres;

COMMENT ON FUNCTION public.cleanup_old_cache_invalidations() IS 'Cleanup old processed cache invalidations to prevent table bloat';

-- ============================================================================
-- 6. RLS Policies (Service Role Only)
-- ============================================================================

ALTER TABLE public.cache_invalidation_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY cache_invalidation_queue_service_role_all
  ON public.cache_invalidation_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow authenticated users to read the latest view (for watermarking)
CREATE POLICY cache_invalidation_latest_authenticated_read
  ON public.cache_invalidation_queue
  FOR SELECT
  TO authenticated
  USING (true);

