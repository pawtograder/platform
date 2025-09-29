-- Optimize realtime resource utilization:
-- 1) Ensure all broadcasted tables have an updated_at column
-- 2) Add a lightweight BEFORE UPDATE trigger to stamp updated_at

-- Create a unified trigger function (idempotent)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- List of tables that participate in realtime broadcasts
-- Sourced from existing broadcast_* triggers in schema
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'assignment_due_date_exceptions',
    'discussion_thread_read_status',
    'discussion_thread_watchers',
    'discussion_threads',
    'gradebook_column_students',
    'gradebook_columns',
    'gradebook_row_recalc_state',
    'help_queue_assignments',
    'help_queues',
    'help_request_feedback',
    'help_request_file_references',
    'help_request_message_read_receipts',
    'help_request_messages',
    'help_request_moderation',
    'help_request_students',
    'help_request_templates',
    'help_requests',
    'lab_section_meetings',
    'lab_sections',
    'submission_regrade_request_comments',
    'submission_regrade_requests',
    'review_assignment_rubric_parts',
    'review_assignments',
    'student_help_activity',
    'student_karma_notes',
    'submission_artifact_comments',
    'submission_comments',
    'submission_file_comments',
    'submission_reviews',
    'tags',
    'user_roles'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Add updated_at column if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = t
        AND column_name = 'updated_at'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()', t);
    END IF;

    -- (Re)create the BEFORE UPDATE trigger to stamp updated_at
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at_on_%I ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at_on_%1$s BEFORE UPDATE ON public.%1$s FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;


