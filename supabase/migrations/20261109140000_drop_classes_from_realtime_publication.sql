-- Class updates reach students and staff through the classes_update broadcast (see
-- 20261103120000_classes_update_broadcast.sql), so nothing subscribes to classes through
-- postgres_changes. Leaving the table in supabase_realtime keeps the CDC poller running for it.
-- Guarded so a re-run, or an environment that never had the table in the publication, is a no-op.
-- Deploy order: apply only after every client runs a build that includes #1148. Clients on older
-- builds still read classes through postgres_changes and stop receiving updates here until they reload.
--
-- DROP TABLE cannot remove one table from a publication that includes it implicitly, through
-- FOR ALL TABLES or a schema. In that case this fails with a clear message instead of a
-- generic error, and the publication has to be changed by hand.

DO $$
DECLARE
  implicit_member boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables
  ) OR EXISTS (
    SELECT 1
    FROM pg_publication_namespace pn
    JOIN pg_publication p ON p.oid = pn.pnpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pn.pnnspid = 'public'::regnamespace
  )
  INTO implicit_member;

  IF implicit_member AND EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'classes'
  ) THEN
    RAISE EXCEPTION 'supabase_realtime includes public.classes through FOR ALL TABLES or a schema; change the publication by hand before applying this migration';
  END IF;

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
