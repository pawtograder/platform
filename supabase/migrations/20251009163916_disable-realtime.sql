-- Disable Supabase Realtime for all tables
-- This migration removes all tables from the supabase_realtime publication
-- Wrapped in error handling to gracefully skip tables not in the publication

DO $$
DECLARE
  table_names text[] := ARRAY[
    'assignment_due_date_exceptions',
    'autograder_commits',
    'autograder_regression_test',
    'discussion_thread_likes',
    'discussion_thread_read_status',
    'discussion_thread_watchers',
    'discussion_threads',
    'gradebook_column_students',
    'gradebook_columns',
    'help_queues',
    'help_request_messages',
    'help_requests',
    'lab_section_meetings',
    'lab_sections',
    'notifications',
    'poll_question_answers',
    'poll_question_results',
    'poll_questions',
    'submissions'
  ];
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY table_names
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."%I"', table_name);
      RAISE NOTICE 'Removed table % from supabase_realtime publication', table_name;
    EXCEPTION
      WHEN undefined_table THEN
        RAISE NOTICE 'Table % does not exist in supabase_realtime publication, skipping', table_name;
      WHEN OTHERS THEN
        RAISE NOTICE 'Error removing table % from publication: %', table_name, SQLERRM;
    END;
  END LOOP;
END $$;

