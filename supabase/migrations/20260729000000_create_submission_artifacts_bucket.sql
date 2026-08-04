-- Private storage bucket for grader-produced submission artifacts (mutation and
-- coverage reports, etc.). The `submission_artifacts` TABLE has existed for a
-- long time, but the BUCKET its bytes live in was only ever created by hand in
-- the managed Supabase project's dashboard — no migration created it. A
-- deployment whose schema is built from migrations alone therefore has the table
-- and no bucket, and every artifact upload fails at
-- `createSignedUploadUrl` with a foreign-key violation on `bucket_id`, surfaced
-- by storage-api as `400 The related resource does not exist`:
--
--   Error: Internal error: Failed to create signed URL for artifact: <name>
--     autograder-submit-feedback/index.ts (the artifactUploadLinks Promise.all)
--
-- Written and read exclusively by the service-role client — uploads via
-- `createSignedUploadUrl` in supabase/functions/autograder-submit-feedback, reads
-- via `.download()` in supabase/functions/submission-serve-artifact (students
-- reach artifacts only through that function, which authorizes them itself).
-- Service role bypasses RLS, so no storage.objects policies are required — keep
-- the bucket private so artifacts are never publicly listable or fetchable
-- without a signed URL. Same arrangement as the `graders` bucket
-- (20260603000000_create_graders_bucket.sql).
--
-- Idempotent: the managed deployment already has this bucket created
-- out-of-band; ON CONFLICT keeps the migration a no-op there.
INSERT INTO storage.buckets (id, name, public)
VALUES ('submission-artifacts', 'submission-artifacts', false)
ON CONFLICT (id) DO NOTHING;

-- The bucket alone is not enough: reads are NOT all service-role. The submission
-- files page hits this bucket with the BROWSER client, so RLS on storage.objects
-- applies —
--   files/page.tsx: createSignedUrl for PNG previews and for the download link,
--   and .download() for plaintext/markdown artifacts.
-- Only HTML-site ZIPs go through submission-serve-artifact (service role, which
-- bypasses RLS). With a private bucket and no SELECT policy, a
-- migrations-only deployment creates the bucket, uploads succeed, and then every
-- preview and download fails for the very users the artifacts are for. Managed
-- works today only because the policy was made by hand in the dashboard.
--
-- public.can_access_submission_storage_path (20260217000000) already fits this
-- path shape without change. Artifact keys are
--   classes/{class_id}/profiles/{profile_or_group_id}/submissions/{submission_id}/{artifact_id}
-- which is exactly the 6 segments it validates ('classes'/id/'profiles'/id/
-- 'submissions'/id), and it authorizes via authorize_for_submission (owner, group
-- member) OR authorizeforclassgrader (staff). Submission files use the same
-- prefix with /files/{filename} appended.
--
-- Best-effort, and deliberately so. 20260217000000 ships its equivalent policies
-- COMMENTED OUT because CREATE POLICY on storage.objects raises
-- "must be owner of table objects" wherever storage.objects is owned by a role
-- the migration runner is not. Letting that abort the transaction would take the
-- whole migrations Job down — far worse than the read failure it fixes. So it
-- degrades to a WARNING telling the operator to apply it by hand, which is
-- exactly where those deployments already are today.
--
-- No INSERT/DELETE policy: writes are service-role only (createSignedUploadUrl in
-- autograder-submit-feedback, cleanup in the CLI), and service role bypasses RLS.
DO $$
BEGIN
  CREATE POLICY "Authenticated users can read submission artifacts"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
      bucket_id = 'submission-artifacts'
      AND public.can_access_submission_storage_path(name)
    );
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'submission-artifacts SELECT policy already present, leaving it alone';
  WHEN insufficient_privilege THEN
    RAISE WARNING 'cannot CREATE POLICY on storage.objects (not its owner). Artifact previews/downloads will fail until this is applied by hand: SELECT on storage.objects TO authenticated USING (bucket_id = ''submission-artifacts'' AND public.can_access_submission_storage_path(name))';
END $$;
