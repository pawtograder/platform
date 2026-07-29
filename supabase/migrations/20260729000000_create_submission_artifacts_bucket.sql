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
