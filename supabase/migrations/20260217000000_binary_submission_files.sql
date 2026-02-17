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

-- Helper function: check if the current user can access a submission storage path.
-- Path format: classes/{class_id}/profiles/{profile_id_or_group_id}/submissions/{submission_id}/files/{filename}
-- Reuses authorize_for_submission (owners, group members) and authorizeforclassgrader (staff).
CREATE OR REPLACE FUNCTION public.can_access_submission_storage_path(path text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  path_parts text[];
  class_id_bigint bigint;
  submission_id_bigint bigint;
BEGIN
  -- Validate path format (min 6 segments for class_id, submission_id)
  path_parts := string_to_array(path, '/');
  IF array_length(path_parts, 1) < 6 THEN
    RETURN false;
  END IF;
  IF path_parts[1] != 'classes' OR path_parts[3] != 'profiles' OR path_parts[5] != 'submissions' THEN
    RETURN false;
  END IF;
  BEGIN
    class_id_bigint := path_parts[2]::bigint;
    submission_id_bigint := path_parts[6]::bigint;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;

  RETURN public.authorize_for_submission(submission_id_bigint)
    OR public.authorizeforclassgrader(class_id_bigint);
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_access_submission_storage_path(text) TO authenticated;

-- RLS policy for submission-files bucket: path-based access control
-- Only allows read when user has access to the submission (owner, group member, or staff)
CREATE POLICY "Authenticated users can read submission files"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'submission-files'
  AND public.can_access_submission_storage_path(name)
);

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
