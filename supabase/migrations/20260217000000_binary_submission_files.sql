-- Add binary file support to submission_files
-- Binary files store their contents in Supabase Storage instead of inline text

-- Allow contents to be null (binary files don't store inline contents)
ALTER TABLE public.submission_files ALTER COLUMN contents DROP NOT NULL;

-- Add columns for binary file metadata
ALTER TABLE public.submission_files ADD COLUMN is_binary boolean NOT NULL DEFAULT false;
ALTER TABLE public.submission_files ADD COLUMN file_size bigint;
ALTER TABLE public.submission_files ADD COLUMN mime_type text;
ALTER TABLE public.submission_files ADD COLUMN storage_key text;

-- Create the submission-files storage bucket for binary file storage
INSERT INTO storage.buckets (id, name, public) VALUES ('submission-files', 'submission-files', false)
ON CONFLICT (id) DO NOTHING;

-- RLS policy for submission-files bucket: authenticated users can read
-- (further access control happens via the submission_files table RLS)
CREATE POLICY "Authenticated users can read submission files"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'submission-files');

-- Service role (used by edge functions) can insert
CREATE POLICY "Service role can insert submission files"
ON storage.objects FOR INSERT
TO service_role
WITH CHECK (bucket_id = 'submission-files');

-- Service role can delete submission files
CREATE POLICY "Service role can delete submission files"
ON storage.objects FOR DELETE
TO service_role
USING (bucket_id = 'submission-files');
