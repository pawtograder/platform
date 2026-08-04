-- Public storage bucket for user-uploaded attachments (discussion-thread
-- attachments, markdown-editor image/file uploads).
--
-- Referenced by the frontend via supabase.storage.from('uploads') in
-- components/ui/message-input.tsx and components/ui/md-editor.tsx, and gated by
-- the owner-scoped RLS policies in 20250729000001_uploads-rls.sql (which assume
-- this bucket exists).
--
-- The bucket was previously declared only in supabase/config.toml, which the
-- Supabase CLI materializes on `supabase start` for LOCAL dev only. Production
-- (Helm/prod-charts) applies migrations, not config.toml, so the bucket was
-- never created there -> storage-api returns 404 "Bucket not found" on upload.
-- This mirrors the graders bucket (20260603000000), which was migrated for the
-- same reason.
--
-- Idempotent: ON CONFLICT keeps this a no-op on local/dev DBs where the CLI
-- already created the bucket out-of-band.
INSERT INTO storage.buckets (id, name, public)
VALUES ('uploads', 'uploads', true)
ON CONFLICT (id) DO NOTHING;

-- Re-assert the owner-scoped RLS policies from 20250729000001_uploads-rls.sql.
-- Those policies are on storage.objects and match bucket_id = 'uploads' as a
-- string literal, so they do not depend on the bucket row and were applied when
-- 20250729000001 ran. We DROP IF EXISTS + CREATE here so this migration is a
-- self-contained, idempotent guarantee that the bucket AND its policies exist
-- together (safe whether or not the policies are already present).
DROP POLICY IF EXISTS "Authenticated users can READ" ON storage.objects;
CREATE POLICY "Authenticated users can READ"
    ON storage.objects
    FOR SELECT TO authenticated
    USING (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
    );

DROP POLICY IF EXISTS "Authenticated users can CREATE" ON storage.objects;
CREATE POLICY "Authenticated users can CREATE"
    ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
    );

DROP POLICY IF EXISTS "Authenticated users can UPDATE" ON storage.objects;
CREATE POLICY "Authenticated users can UPDATE"
    ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
    );

DROP POLICY IF EXISTS "Authenticated users can DELETE" ON storage.objects;
CREATE POLICY "Authenticated users can DELETE"
    ON storage.objects
    FOR DELETE TO authenticated
    USING (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
    );
