CREATE POLICY "Authenticated users can READ" 
    ON storage.objects 
    FOR SELECT TO authenticated 
    USING (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
        );

CREATE POLICY "Authenticated users can CREATE" 
    ON storage.objects 
    FOR INSERT TO authenticated 
    WITH CHECK (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
    );

CREATE POLICY "Authenticated users can UPDATE" 
    ON storage.objects 
    FOR UPDATE TO authenticated 
    USING (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
    );

CREATE POLICY "Authenticated users can DELETE" 
    ON storage.objects 
    FOR DELETE TO authenticated 
    USING (
        (bucket_id = 'uploads'::text) AND (auth.uid() = owner)
    );