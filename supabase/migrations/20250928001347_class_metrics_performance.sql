-- Pre-aggregate class metrics into counters maintained via triggers for O(1) reads
-- Drops the previous on-demand implementation and replaces it with table-driven totals
-- covering only simple "all-time" metrics (no time-window calculations).

DROP FUNCTION IF EXISTS public.get_all_class_metrics();
DROP FUNCTION IF EXISTS public.bump_class_metric(bigint, text, bigint);
DROP FUNCTION IF EXISTS public.class_metrics_assignments_counter();
DROP FUNCTION IF EXISTS public.class_metrics_submissions_counter();
DROP FUNCTION IF EXISTS public.class_metrics_submission_reviews_counter();
DROP FUNCTION IF EXISTS public.class_metrics_help_requests_counter();
DROP FUNCTION IF EXISTS public.class_metrics_notifications_counter();
DROP FUNCTION IF EXISTS public.class_metrics_llm_inference_counter();
DROP FUNCTION IF EXISTS public.class_metrics_hint_feedback_counter();
DROP FUNCTION IF EXISTS public.class_metrics_user_roles_counter();
DROP FUNCTION IF EXISTS public.class_metrics_assignment_due_date_exceptions_counter();
DROP FUNCTION IF EXISTS public.class_metrics_classes_insert();
DROP FUNCTION IF EXISTS public.refresh_class_user_role_counts(bigint);

DROP TABLE IF EXISTS public.class_metrics_totals;

CREATE TABLE public.class_metrics_totals (
    class_id bigint PRIMARY KEY REFERENCES public.classes(id) ON DELETE CASCADE,
    assignments_total bigint DEFAULT 0,
    active_students_total bigint DEFAULT 0,
    active_instructors_total bigint DEFAULT 0,
    active_graders_total bigint DEFAULT 0,
    submissions_total bigint DEFAULT 0,
    submission_reviews_total bigint DEFAULT 0,
    submission_comments_total bigint DEFAULT 0,
    regrade_requests_total bigint DEFAULT 0,
    discussion_threads_total bigint DEFAULT 0,
    help_requests_total bigint DEFAULT 0,
    help_requests_open bigint DEFAULT 0,
    help_request_messages_total bigint DEFAULT 0,
    notifications_unread bigint DEFAULT 0,
    gradebook_columns_total bigint DEFAULT 0,
    late_token_usage_total bigint DEFAULT 0,
    video_meeting_sessions_total bigint DEFAULT 0,
    video_meeting_participants_total bigint DEFAULT 0,
    llm_inference_total bigint DEFAULT 0,
    llm_input_tokens_total bigint DEFAULT 0,
    llm_output_tokens_total bigint DEFAULT 0,
    hint_feedback_total bigint DEFAULT 0,
    hint_feedback_useful_total bigint DEFAULT 0,
    hint_feedback_with_comments bigint DEFAULT 0,
    workflow_runs_total bigint DEFAULT 0,
    workflow_runs_completed bigint DEFAULT 0,
    workflow_runs_failed bigint DEFAULT 0,
    workflow_runs_in_progress bigint DEFAULT 0,
    workflow_errors_total bigint DEFAULT 0,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

INSERT INTO public.class_metrics_totals (class_id)
SELECT id FROM public.classes
ON CONFLICT (class_id) DO NOTHING;

WITH totals AS (
  SELECT
    c.id AS class_id,
    COALESCE((SELECT COUNT(*) FROM public.assignments a WHERE a.class_id = c.id AND a.archived_at IS NULL), 0) AS assignments_total,
    COALESCE((SELECT COUNT(*) FROM public.user_roles ur WHERE ur.class_id = c.id::integer AND ur.role = 'student' AND ur.disabled = false), 0) AS active_students_total,
    COALESCE((SELECT COUNT(*) FROM public.user_roles ur WHERE ur.class_id = c.id::integer AND ur.role = 'instructor' AND ur.disabled = false), 0) AS active_instructors_total,
    COALESCE((SELECT COUNT(*) FROM public.user_roles ur WHERE ur.class_id = c.id::integer AND ur.role = 'grader' AND ur.disabled = false), 0) AS active_graders_total,
    COALESCE((SELECT COUNT(*) FROM public.submissions s WHERE s.class_id = c.id), 0) AS submissions_total,
    COALESCE((SELECT COUNT(*) FROM public.submission_reviews sr WHERE sr.class_id = c.id AND sr.completed_at IS NOT NULL), 0) AS submission_reviews_total,
    COALESCE((SELECT COUNT(*) FROM public.submission_comments sc WHERE sc.class_id = c.id), 0)
      + COALESCE((SELECT COUNT(*) FROM public.submission_artifact_comments sac WHERE sac.class_id = c.id), 0)
      + COALESCE((SELECT COUNT(*) FROM public.submission_file_comments sfc WHERE sfc.class_id = c.id), 0)
      + COALESCE((SELECT COUNT(*) FROM public.submission_regrade_request_comments srcc WHERE srcc.class_id = c.id), 0) AS submission_comments_total,
    COALESCE((SELECT COUNT(*) FROM public.submission_regrade_requests srr WHERE srr.class_id = c.id), 0) AS regrade_requests_total,
    COALESCE((SELECT COUNT(*) FROM public.discussion_threads dt WHERE dt.class_id = c.id), 0) AS discussion_threads_total,
    COALESCE((SELECT COUNT(*) FROM public.help_requests hr WHERE hr.class_id = c.id), 0) AS help_requests_total,
    COALESCE((SELECT COUNT(*) FROM public.help_requests hr WHERE hr.class_id = c.id AND hr.status = 'open'), 0) AS help_requests_open,
    COALESCE((SELECT COUNT(*) FROM public.help_request_messages hrm WHERE hrm.class_id = c.id), 0) AS help_request_messages_total,
    COALESCE((SELECT COUNT(*) FROM public.notifications n WHERE n.class_id = c.id AND n.viewed_at IS NULL), 0) AS notifications_unread,
    COALESCE((SELECT COUNT(*) FROM public.gradebook_columns gbc WHERE gbc.class_id = c.id), 0) AS gradebook_columns_total,
    COALESCE((SELECT SUM(adde.tokens_consumed) FROM public.assignment_due_date_exceptions adde WHERE adde.class_id = c.id), 0) AS late_token_usage_total,
    COALESCE((SELECT COUNT(*) FROM public.video_meeting_sessions vms WHERE vms.class_id = c.id), 0) AS video_meeting_sessions_total,
    COALESCE((SELECT COUNT(*) FROM public.video_meeting_session_users vmsu WHERE vmsu.class_id = c.id), 0) AS video_meeting_participants_total,
    COALESCE((SELECT COUNT(*) FROM public.llm_inference_usage liu WHERE liu.class_id = c.id), 0) AS llm_inference_total,
    COALESCE((SELECT SUM(liu.input_tokens) FROM public.llm_inference_usage liu WHERE liu.class_id = c.id), 0) AS llm_input_tokens_total,
    COALESCE((SELECT SUM(liu.output_tokens) FROM public.llm_inference_usage liu WHERE liu.class_id = c.id), 0) AS llm_output_tokens_total,
    COALESCE((SELECT COUNT(*) FROM public.grader_result_tests_hint_feedback gf WHERE gf.class_id = c.id), 0) AS hint_feedback_total,
    COALESCE((SELECT COUNT(*) FROM public.grader_result_tests_hint_feedback gf WHERE gf.class_id = c.id AND gf.useful = true), 0) AS hint_feedback_useful_total,
    COALESCE((SELECT COUNT(*) FROM public.grader_result_tests_hint_feedback gf WHERE gf.class_id = c.id AND gf.comment IS NOT NULL AND btrim(gf.comment) <> ''), 0) AS hint_feedback_with_comments,
    COALESCE((SELECT COUNT(*) FROM public.workflow_events_summary wes WHERE wes.class_id = c.id), 0) AS workflow_runs_total,
    COALESCE((SELECT COUNT(*) FROM public.workflow_events_summary wes WHERE wes.class_id = c.id AND wes.completed_at IS NOT NULL), 0) AS workflow_runs_completed,
    COALESCE((SELECT COUNT(*) FROM public.workflow_events_summary wes WHERE wes.class_id = c.id AND wes.completed_at IS NULL AND wes.in_progress_at IS NOT NULL), 0) AS workflow_runs_in_progress,
    COALESCE((SELECT COUNT(*) FROM public.workflow_events_summary wes WHERE wes.class_id = c.id AND wes.completed_at IS NULL AND wes.in_progress_at IS NULL AND wes.requested_at IS NOT NULL), 0) AS workflow_runs_failed,
    COALESCE((SELECT COUNT(*) FROM public.workflow_run_error wre WHERE wre.class_id = c.id), 0) AS workflow_errors_total
  FROM public.classes c
  WHERE c.archived = false
)
UPDATE public.class_metrics_totals mt
SET assignments_total = totals.assignments_total,
    active_students_total = totals.active_students_total,
    active_instructors_total = totals.active_instructors_total,
    active_graders_total = totals.active_graders_total,
    submissions_total = totals.submissions_total,
    submission_reviews_total = totals.submission_reviews_total,
    submission_comments_total = totals.submission_comments_total,
    regrade_requests_total = totals.regrade_requests_total,
    discussion_threads_total = totals.discussion_threads_total,
    help_requests_total = totals.help_requests_total,
    help_requests_open = totals.help_requests_open,
    help_request_messages_total = totals.help_request_messages_total,
    notifications_unread = totals.notifications_unread,
    gradebook_columns_total = totals.gradebook_columns_total,
    late_token_usage_total = totals.late_token_usage_total,
    video_meeting_sessions_total = totals.video_meeting_sessions_total,
    video_meeting_participants_total = totals.video_meeting_participants_total,
    llm_inference_total = totals.llm_inference_total,
    llm_input_tokens_total = totals.llm_input_tokens_total,
    llm_output_tokens_total = totals.llm_output_tokens_total,
    hint_feedback_total = totals.hint_feedback_total,
    hint_feedback_useful_total = totals.hint_feedback_useful_total,
    hint_feedback_with_comments = totals.hint_feedback_with_comments,
    workflow_runs_total = totals.workflow_runs_total,
    workflow_runs_completed = totals.workflow_runs_completed,
    workflow_runs_failed = totals.workflow_runs_failed,
    workflow_runs_in_progress = totals.workflow_runs_in_progress,
    workflow_errors_total = totals.workflow_errors_total,
    updated_at = now()
FROM totals
WHERE mt.class_id = totals.class_id;

-- Pre-create counter rows via trigger on classes (no helper function needed)
CREATE OR REPLACE FUNCTION public.class_metrics_classes_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.class_metrics_totals (class_id)
  VALUES (NEW.id)
  ON CONFLICT (class_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_assignments_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET assignments_total = assignments_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_submissions_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET submissions_total = submissions_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_submission_reviews_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET submission_reviews_total = submission_reviews_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_help_requests_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_class bigint := COALESCE(NEW.class_id, OLD.class_id);
  old_was_open boolean := false;
  new_is_open boolean := false;
BEGIN
  -- Check if OLD row was open
  IF OLD IS NOT NULL THEN
    old_was_open := (OLD.status = 'open');
  END IF;
  
  -- Check if NEW row is open
  IF NEW IS NOT NULL THEN
    new_is_open := (NEW.status = 'open');
  END IF;

  IF TG_OP = 'INSERT' THEN
    UPDATE public.class_metrics_totals
    SET help_requests_total = help_requests_total + 1,
        help_requests_open = help_requests_open + CASE WHEN new_is_open THEN 1 ELSE 0 END,
        updated_at = now()
    WHERE class_id = target_class;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only update help_requests_open if status changed
    IF old_was_open <> new_is_open THEN
      UPDATE public.class_metrics_totals
      SET help_requests_open = help_requests_open + CASE WHEN new_is_open THEN 1 ELSE -1 END,
          updated_at = now()
      WHERE class_id = target_class;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.class_metrics_totals
    SET help_requests_total = help_requests_total - 1,
        help_requests_open = help_requests_open - CASE WHEN old_was_open THEN 1 ELSE 0 END,
        updated_at = now()
    WHERE class_id = target_class;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_notifications_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_class bigint := COALESCE(NEW.class_id, OLD.class_id);
  old_was_unread boolean := false;
  new_is_unread boolean := false;
BEGIN
  -- Check if OLD row was unread
  IF OLD IS NOT NULL THEN
    old_was_unread := (OLD.viewed_at IS NULL);
  END IF;
  
  -- Check if NEW row is unread
  IF NEW IS NOT NULL THEN
    new_is_unread := (NEW.viewed_at IS NULL);
  END IF;

  IF TG_OP = 'INSERT' THEN
    UPDATE public.class_metrics_totals
    SET notifications_unread = notifications_unread + CASE WHEN new_is_unread THEN 1 ELSE 0 END,
        updated_at = now()
    WHERE class_id = target_class;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only update notifications_unread if viewed_at status changed
    IF old_was_unread <> new_is_unread THEN
      UPDATE public.class_metrics_totals
      SET notifications_unread = notifications_unread + CASE WHEN new_is_unread THEN 1 ELSE -1 END,
          updated_at = now()
      WHERE class_id = target_class;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.class_metrics_totals
    SET notifications_unread = notifications_unread - CASE WHEN old_was_unread THEN 1 ELSE 0 END,
        updated_at = now()
    WHERE class_id = target_class;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_llm_inference_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET llm_inference_total = llm_inference_total + 1,
      llm_input_tokens_total = llm_input_tokens_total + NEW.input_tokens,
      llm_output_tokens_total = llm_output_tokens_total + NEW.output_tokens,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_hint_feedback_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET hint_feedback_total = hint_feedback_total + 1,
      hint_feedback_useful_total = hint_feedback_useful_total + CASE WHEN NEW.useful THEN 1 ELSE 0 END,
      hint_feedback_with_comments = hint_feedback_with_comments + CASE WHEN NEW.comment IS NOT NULL AND btrim(NEW.comment) <> '' THEN 1 ELSE 0 END,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_user_roles_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_class_id bigint;
  new_class_id bigint;
  old_role text;
  new_role text;
  old_disabled boolean;
  new_disabled boolean;
BEGIN
  -- Extract values for comparison
  IF OLD IS NOT NULL THEN
    old_class_id := OLD.class_id;
    old_role := OLD.role;
    old_disabled := OLD.disabled;
  END IF;
  
  IF NEW IS NOT NULL THEN
    new_class_id := NEW.class_id;
    new_role := NEW.role;
    new_disabled := NEW.disabled;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Add to appropriate counter if not disabled
    IF NOT new_disabled THEN
      IF new_role = 'student' THEN
        UPDATE public.class_metrics_totals
        SET active_students_total = active_students_total + 1, updated_at = now()
        WHERE class_id = new_class_id;
      ELSIF new_role = 'instructor' THEN
        UPDATE public.class_metrics_totals
        SET active_instructors_total = active_instructors_total + 1, updated_at = now()
        WHERE class_id = new_class_id;
      ELSIF new_role = 'grader' THEN
        UPDATE public.class_metrics_totals
        SET active_graders_total = active_graders_total + 1, updated_at = now()
        WHERE class_id = new_class_id;
      END IF;
    END IF;
    
  ELSIF TG_OP = 'UPDATE' THEN
    -- Handle class_id changes
    IF old_class_id <> new_class_id THEN
      -- Remove from old class
      IF NOT old_disabled THEN
        IF old_role = 'student' THEN
          UPDATE public.class_metrics_totals
          SET active_students_total = active_students_total - 1, updated_at = now()
          WHERE class_id = old_class_id;
        ELSIF old_role = 'instructor' THEN
          UPDATE public.class_metrics_totals
          SET active_instructors_total = active_instructors_total - 1, updated_at = now()
          WHERE class_id = old_class_id;
        ELSIF old_role = 'grader' THEN
          UPDATE public.class_metrics_totals
          SET active_graders_total = active_graders_total - 1, updated_at = now()
          WHERE class_id = old_class_id;
        END IF;
      END IF;
      
      -- Add to new class
      IF NOT new_disabled THEN
        IF new_role = 'student' THEN
          UPDATE public.class_metrics_totals
          SET active_students_total = active_students_total + 1, updated_at = now()
          WHERE class_id = new_class_id;
        ELSIF new_role = 'instructor' THEN
          UPDATE public.class_metrics_totals
          SET active_instructors_total = active_instructors_total + 1, updated_at = now()
          WHERE class_id = new_class_id;
        ELSIF new_role = 'grader' THEN
          UPDATE public.class_metrics_totals
          SET active_graders_total = active_graders_total + 1, updated_at = now()
          WHERE class_id = new_class_id;
        END IF;
      END IF;
    ELSE
      -- Same class, check for role or disabled status changes
      IF old_role <> new_role OR old_disabled <> new_disabled THEN
        -- Remove old contribution
        IF NOT old_disabled THEN
          IF old_role = 'student' THEN
            UPDATE public.class_metrics_totals
            SET active_students_total = active_students_total - 1, updated_at = now()
            WHERE class_id = old_class_id;
          ELSIF old_role = 'instructor' THEN
            UPDATE public.class_metrics_totals
            SET active_instructors_total = active_instructors_total - 1, updated_at = now()
            WHERE class_id = old_class_id;
          ELSIF old_role = 'grader' THEN
            UPDATE public.class_metrics_totals
            SET active_graders_total = active_graders_total - 1, updated_at = now()
            WHERE class_id = old_class_id;
          END IF;
        END IF;
        
        -- Add new contribution
        IF NOT new_disabled THEN
          IF new_role = 'student' THEN
            UPDATE public.class_metrics_totals
            SET active_students_total = active_students_total + 1, updated_at = now()
            WHERE class_id = new_class_id;
          ELSIF new_role = 'instructor' THEN
            UPDATE public.class_metrics_totals
            SET active_instructors_total = active_instructors_total + 1, updated_at = now()
            WHERE class_id = new_class_id;
          ELSIF new_role = 'grader' THEN
            UPDATE public.class_metrics_totals
            SET active_graders_total = active_graders_total + 1, updated_at = now()
            WHERE class_id = new_class_id;
          END IF;
        END IF;
      END IF;
    END IF;
    
  ELSIF TG_OP = 'DELETE' THEN
    -- Remove from appropriate counter if not disabled
    IF NOT old_disabled THEN
      IF old_role = 'student' THEN
        UPDATE public.class_metrics_totals
        SET active_students_total = active_students_total - 1, updated_at = now()
        WHERE class_id = old_class_id;
      ELSIF old_role = 'instructor' THEN
        UPDATE public.class_metrics_totals
        SET active_instructors_total = active_instructors_total - 1, updated_at = now()
        WHERE class_id = old_class_id;
      ELSIF old_role = 'grader' THEN
        UPDATE public.class_metrics_totals
        SET active_graders_total = active_graders_total - 1, updated_at = now()
        WHERE class_id = old_class_id;
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_assignment_due_date_exceptions_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET late_token_usage_total = late_token_usage_total + NEW.tokens_consumed,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_discussion_threads_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET discussion_threads_total = discussion_threads_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_regrade_requests_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET regrade_requests_total = regrade_requests_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_submission_comments_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET submission_comments_total = submission_comments_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_video_meeting_sessions_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET video_meeting_sessions_total = video_meeting_sessions_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_video_meeting_participants_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET video_meeting_participants_total = video_meeting_participants_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_workflow_events_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_class bigint := COALESCE(NEW.class_id, OLD.class_id);
  affected_workflow_run_id bigint;
  affected_run_attempt integer;
  old_state text;
  new_state text;
BEGIN
  -- Get the workflow_run_id and run_attempt that was affected
  affected_workflow_run_id := COALESCE(NEW.workflow_run_id, OLD.workflow_run_id);
  affected_run_attempt := COALESCE(NEW.run_attempt, OLD.run_attempt);
  
  -- Determine the old state of this workflow run (only for DELETE)
  IF TG_OP = 'DELETE' THEN
    SELECT CASE 
      WHEN MAX(CASE WHEN event_type = 'completed' AND conclusion IN ('success', 'neutral') THEN 1 ELSE 0 END) = 1 THEN 'completed'
      WHEN MAX(CASE WHEN event_type = 'completed' AND (conclusion IS NULL OR conclusion NOT IN ('success', 'neutral')) THEN 1 ELSE 0 END) = 1 THEN 'failed'
      WHEN MAX(CASE WHEN event_type = 'in_progress' THEN 1 ELSE 0 END) = 1 THEN 'in_progress'
      ELSE 'unknown'
    END INTO old_state
    FROM public.workflow_events
    WHERE class_id = target_class 
      AND workflow_run_id = affected_workflow_run_id 
      AND run_attempt = affected_run_attempt
      AND (workflow_run_id, run_attempt) <> (OLD.workflow_run_id, OLD.run_attempt);
  END IF;
  
  -- Determine the new state of this workflow run (only for INSERT)
  IF TG_OP = 'INSERT' THEN
    SELECT CASE 
      WHEN MAX(CASE WHEN event_type = 'completed' AND conclusion IN ('success', 'neutral') THEN 1 ELSE 0 END) = 1 THEN 'completed'
      WHEN MAX(CASE WHEN event_type = 'completed' AND (conclusion IS NULL OR conclusion NOT IN ('success', 'neutral')) THEN 1 ELSE 0 END) = 1 THEN 'failed'
      WHEN MAX(CASE WHEN event_type = 'in_progress' THEN 1 ELSE 0 END) = 1 THEN 'in_progress'
      ELSE 'unknown'
    END INTO new_state
    FROM public.workflow_events
    WHERE class_id = target_class 
      AND workflow_run_id = affected_workflow_run_id 
      AND run_attempt = affected_run_attempt;
  END IF;
  
  -- Handle workflow_runs_total changes
  IF TG_OP = 'INSERT' THEN
    -- Check if this is the first event for this workflow_run_id + run_attempt combination
    IF NOT EXISTS (
      SELECT 1 FROM public.workflow_events 
      WHERE class_id = target_class 
        AND workflow_run_id = affected_workflow_run_id 
        AND run_attempt = affected_run_attempt
        AND (workflow_run_id, run_attempt) <> (NEW.workflow_run_id, NEW.run_attempt)
    ) THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_total = workflow_runs_total + 1, updated_at = now()
      WHERE class_id = target_class;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    -- Check if this was the last event for this workflow_run_id + run_attempt combination
    IF NOT EXISTS (
      SELECT 1 FROM public.workflow_events 
      WHERE class_id = target_class 
        AND workflow_run_id = affected_workflow_run_id 
        AND run_attempt = affected_run_attempt
        AND (workflow_run_id, run_attempt) <> (OLD.workflow_run_id, OLD.run_attempt)
    ) THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_total = workflow_runs_total - 1, updated_at = now()
      WHERE class_id = target_class;
    END IF;
  END IF;
  
  -- Handle state-specific counter changes
  IF TG_OP = 'DELETE' AND old_state IS NOT NULL THEN
    -- Remove from old state counter
    IF old_state = 'completed' THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_completed = workflow_runs_completed - 1, updated_at = now()
      WHERE class_id = target_class;
    ELSIF old_state = 'failed' THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_failed = workflow_runs_failed - 1, updated_at = now()
      WHERE class_id = target_class;
    ELSIF old_state = 'in_progress' THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_in_progress = workflow_runs_in_progress - 1, updated_at = now()
      WHERE class_id = target_class;
    END IF;
  END IF;
  
  IF TG_OP = 'INSERT' AND new_state IS NOT NULL THEN
    -- Add to new state counter
    IF new_state = 'completed' THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_completed = workflow_runs_completed + 1, updated_at = now()
      WHERE class_id = target_class;
    ELSIF new_state = 'failed' THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_failed = workflow_runs_failed + 1, updated_at = now()
      WHERE class_id = target_class;
    ELSIF new_state = 'in_progress' THEN
      UPDATE public.class_metrics_totals
      SET workflow_runs_in_progress = workflow_runs_in_progress + 1, updated_at = now()
      WHERE class_id = target_class;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_workflow_errors_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_class bigint := COALESCE(NEW.class_id, OLD.class_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.class_metrics_totals
    SET workflow_errors_total = workflow_errors_total + 1,
        updated_at = now()
    WHERE class_id = target_class;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.class_metrics_totals
    SET workflow_errors_total = workflow_errors_total - 1,
        updated_at = now()
    WHERE class_id = target_class;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_help_request_messages_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET help_request_messages_total = help_request_messages_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.class_metrics_gradebook_columns_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET gradebook_columns_total = gradebook_columns_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS class_metrics_classes_insert_trg ON public.classes;
CREATE TRIGGER class_metrics_classes_insert_trg
AFTER INSERT ON public.classes
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_classes_insert();

CREATE TRIGGER class_metrics_assignments_trg
AFTER INSERT ON public.assignments
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_assignments_counter();

DROP TRIGGER IF EXISTS class_metrics_submissions_trg ON public.submissions;
CREATE TRIGGER class_metrics_submissions_trg
AFTER INSERT ON public.submissions
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_submissions_counter();

DROP TRIGGER IF EXISTS class_metrics_submission_reviews_trg ON public.submission_reviews;
CREATE TRIGGER class_metrics_submission_reviews_trg
AFTER INSERT ON public.submission_reviews
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_submission_reviews_counter();

DROP TRIGGER IF EXISTS class_metrics_submission_comments_trg ON public.submission_comments;
CREATE TRIGGER class_metrics_submission_comments_trg
AFTER INSERT ON public.submission_comments
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_submission_comments_counter();

DROP TRIGGER IF EXISTS class_metrics_submission_artifact_comments_trg ON public.submission_artifact_comments;
CREATE TRIGGER class_metrics_submission_artifact_comments_trg
AFTER INSERT ON public.submission_artifact_comments
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_submission_comments_counter();

DROP TRIGGER IF EXISTS class_metrics_submission_file_comments_trg ON public.submission_file_comments;
CREATE TRIGGER class_metrics_submission_file_comments_trg
AFTER INSERT ON public.submission_file_comments
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_submission_comments_counter();

DROP TRIGGER IF EXISTS class_metrics_submission_regrade_request_comments_trg ON public.submission_regrade_request_comments;
CREATE TRIGGER class_metrics_submission_regrade_request_comments_trg
AFTER INSERT ON public.submission_regrade_request_comments
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_submission_comments_counter();

DROP TRIGGER IF EXISTS class_metrics_regrade_requests_trg ON public.submission_regrade_requests;
CREATE TRIGGER class_metrics_regrade_requests_trg
AFTER INSERT ON public.submission_regrade_requests
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_regrade_requests_counter();

DROP TRIGGER IF EXISTS class_metrics_discussion_threads_trg ON public.discussion_threads;
CREATE TRIGGER class_metrics_discussion_threads_trg
AFTER INSERT ON public.discussion_threads
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_discussion_threads_counter();

DROP TRIGGER IF EXISTS class_metrics_help_requests_trg ON public.help_requests;
CREATE TRIGGER class_metrics_help_requests_trg
AFTER INSERT OR UPDATE OR DELETE ON public.help_requests
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_help_requests_counter();

DROP TRIGGER IF EXISTS class_metrics_help_request_messages_trg ON public.help_request_messages;
CREATE TRIGGER class_metrics_help_request_messages_trg
AFTER INSERT ON public.help_request_messages
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_help_request_messages_counter();

DROP TRIGGER IF EXISTS class_metrics_notifications_trg ON public.notifications;
CREATE TRIGGER class_metrics_notifications_trg
AFTER INSERT OR UPDATE OR DELETE ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_notifications_counter();

DROP TRIGGER IF EXISTS class_metrics_gradebook_columns_trg ON public.gradebook_columns;
CREATE TRIGGER class_metrics_gradebook_columns_trg
AFTER INSERT ON public.gradebook_columns
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_gradebook_columns_counter();

DROP TRIGGER IF EXISTS class_metrics_assignment_due_date_exceptions_trg ON public.assignment_due_date_exceptions;
CREATE TRIGGER class_metrics_assignment_due_date_exceptions_trg
AFTER INSERT ON public.assignment_due_date_exceptions
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_assignment_due_date_exceptions_counter();

DROP TRIGGER IF EXISTS class_metrics_video_meeting_sessions_trg ON public.video_meeting_sessions;
CREATE TRIGGER class_metrics_video_meeting_sessions_trg
AFTER INSERT ON public.video_meeting_sessions
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_video_meeting_sessions_counter();

DROP TRIGGER IF EXISTS class_metrics_video_meeting_session_users_trg ON public.video_meeting_session_users;
CREATE TRIGGER class_metrics_video_meeting_session_users_trg
AFTER INSERT ON public.video_meeting_session_users
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_video_meeting_participants_counter();

DROP TRIGGER IF EXISTS class_metrics_llm_inference_trg ON public.llm_inference_usage;
CREATE TRIGGER class_metrics_llm_inference_trg
AFTER INSERT ON public.llm_inference_usage
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_llm_inference_counter();

DROP TRIGGER IF EXISTS class_metrics_hint_feedback_trg ON public.grader_result_tests_hint_feedback;
CREATE TRIGGER class_metrics_hint_feedback_trg
AFTER INSERT ON public.grader_result_tests_hint_feedback
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_hint_feedback_counter();

DROP TRIGGER IF EXISTS class_metrics_user_roles_trg ON public.user_roles;
CREATE TRIGGER class_metrics_user_roles_trg
AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_user_roles_counter();

DROP TRIGGER IF EXISTS class_metrics_workflow_events_trg ON public.workflow_events;
CREATE TRIGGER class_metrics_workflow_events_trg
AFTER INSERT OR DELETE ON public.workflow_events
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_workflow_events_counter();

DROP TRIGGER IF EXISTS class_metrics_workflow_errors_trg ON public.workflow_run_error;
CREATE TRIGGER class_metrics_workflow_errors_trg
AFTER INSERT OR UPDATE OR DELETE ON public.workflow_run_error
FOR EACH ROW EXECUTE FUNCTION public.class_metrics_workflow_errors_counter();

CREATE OR REPLACE FUNCTION public.get_all_class_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
  result jsonb;
BEGIN
  SET LOCAL search_path = public, pg_temp;

  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied: function only available to service_role';
  END IF;

  SELECT jsonb_agg(
           jsonb_build_object(
             'class_id', c.id,
             'class_name', c.name,
             'class_slug', c.slug,
             'late_tokens_per_student_limit', COALESCE(c.late_tokens_per_student, 0),
             'metrics_updated_at', mt.updated_at,
             'assignments_total', COALESCE(mt.assignments_total, 0),
             'active_students_total', COALESCE(mt.active_students_total, 0),
             'active_instructors_total', COALESCE(mt.active_instructors_total, 0),
             'active_graders_total', COALESCE(mt.active_graders_total, 0),
             'submissions_total', COALESCE(mt.submissions_total, 0),
             'submission_reviews_total', COALESCE(mt.submission_reviews_total, 0),
             'submission_comments_total', COALESCE(mt.submission_comments_total, 0),
             'regrade_requests_total', COALESCE(mt.regrade_requests_total, 0),
             'discussion_threads_total', COALESCE(mt.discussion_threads_total, 0),
             'help_requests_total', COALESCE(mt.help_requests_total, 0),
             'help_requests_open', COALESCE(mt.help_requests_open, 0),
             'help_request_messages_total', COALESCE(mt.help_request_messages_total, 0),
             'notifications_unread', COALESCE(mt.notifications_unread, 0),
             'gradebook_columns_total', COALESCE(mt.gradebook_columns_total, 0),
             'late_token_usage_total', COALESCE(mt.late_token_usage_total, 0),
             'video_meeting_sessions_total', COALESCE(mt.video_meeting_sessions_total, 0),
             'video_meeting_participants_total', COALESCE(mt.video_meeting_participants_total, 0),
             'llm_inference_total', COALESCE(mt.llm_inference_total, 0),
             'llm_input_tokens_total', COALESCE(mt.llm_input_tokens_total, 0),
             'llm_output_tokens_total', COALESCE(mt.llm_output_tokens_total, 0),
             'hint_feedback_total', COALESCE(mt.hint_feedback_total, 0),
             'hint_feedback_useful_total', COALESCE(mt.hint_feedback_useful_total, 0),
             'hint_feedback_with_comments', COALESCE(mt.hint_feedback_with_comments, 0),
             'workflow_runs_total', COALESCE(mt.workflow_runs_total, 0),
             'workflow_runs_completed', COALESCE(mt.workflow_runs_completed, 0),
             'workflow_runs_failed', COALESCE(mt.workflow_runs_failed, 0),
             'workflow_runs_in_progress', COALESCE(mt.workflow_runs_in_progress, 0),
             'workflow_errors_total', COALESCE(mt.workflow_errors_total, 0)
           )
         )
  INTO result
  FROM public.classes c
  LEFT JOIN public.class_metrics_totals mt ON mt.class_id = c.id
  WHERE c.archived = false;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;
