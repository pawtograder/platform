-- Create avatars bucket
INSERT INTO storage.buckets (id, name, public, avif_autodetection)
VALUES ('avatars', 'avatars', true, false);
-- Set bucket to public for this example
-- For production, consider setting this to false and using policies for access control

-- Create policy to allow authenticated users to upload files
CREATE POLICY "Allow authenticated users to upload avatars"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

-- Create policy to allow users to view their own avatars
CREATE POLICY "Allow users to view their own avatars"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

-- Create policy to allow users to update their own avatars
CREATE POLICY "Allow users to update their own avatars"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

-- Create policy to allow users to delete their own avatars
CREATE POLICY "Allow users to delete their own avatars"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

-- For public read access
CREATE POLICY "Allow public read access to avatars"
ON storage.objects
FOR SELECT
TO anon
USING (
  bucket_id = 'avatars'
);



