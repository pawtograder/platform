INSERT INTO storage.buckets (id, name, public, avif_autodetection)
VALUES ('avatars', 'avatars', true, false);

CREATE POLICY "Allow authenticated users to upload avatars"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

CREATE POLICY "Allow users to view their own avatars"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

CREATE POLICY "Allow users to update their own avatars"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

CREATE POLICY "Allow users to delete their own avatars"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'avatars' AND 
  (auth.uid() = owner)
);

CREATE POLICY "Allow public read access to avatars"
ON storage.objects
FOR SELECT
TO anon
USING (
  bucket_id = 'avatars'
);

CREATE POLICY "Allow users to update their profiles" 
ON public.profiles
FOR UPDATE
TO authenticated 
USING (
  authorizeforprofile(id)
);
