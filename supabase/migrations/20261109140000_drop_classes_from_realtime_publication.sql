-- Class updates reach students and staff through the classes_update broadcast (see
-- 20261103120000_classes_update_broadcast.sql), so nothing subscribes to classes through
-- postgres_changes. Leaving the table in supabase_realtime keeps the CDC poller running for it.
-- Guarded so a re-run, or an environment that never had the table in the publication, is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'classes'
  ) THEN
    ALTER PUBLICATION "supabase_realtime" DROP TABLE ONLY "public"."classes";
  END IF;
END $$;
