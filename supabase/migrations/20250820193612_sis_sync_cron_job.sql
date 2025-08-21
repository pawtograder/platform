-- SIS Sync Cron Job Setup
-- Creates automated hourly sync of SIS-linked classes to keep enrollments up to date

-- 1. Create function to trigger SIS sync via edge function
CREATE OR REPLACE FUNCTION trigger_sis_sync(p_class_id bigint DEFAULT NULL)
RETURNS json AS $$
DECLARE
    sync_result json;
BEGIN
    -- Call the edge function to sync SIS data
    SELECT content INTO sync_result
    FROM call_edge_function_internal(
        'course-import-sis',
        'POST',
        '{"x-edge-function-secret": "' || current_setting('app.edge_function_secret', true) || '"}',
        CASE 
            WHEN p_class_id IS NOT NULL THEN 
                json_build_object('classId', p_class_id::text)
            ELSE 
                '{}'::json
        END
    );
    
    RETURN sync_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Create admin function to manually trigger SIS sync
CREATE OR REPLACE FUNCTION admin_trigger_sis_sync(p_class_id bigint DEFAULT NULL)
RETURNS json AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    RETURN trigger_sis_sync(p_class_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Set up pg_cron job to run SIS sync hourly
-- Note: This requires the pg_cron extension and appropriate permissions
-- The job will sync all SIS-linked classes every hour

DO $$
BEGIN
    -- Check if pg_cron extension is available
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        -- Schedule hourly SIS sync at 15 minutes past each hour
        -- This avoids potential conflicts with other top-of-hour jobs
        PERFORM cron.schedule(
            'sis-enrollment-sync',
            '15 * * * *',  -- Every hour at :15
            'SELECT trigger_sis_sync();'
        );
        
        RAISE NOTICE 'SIS sync cron job scheduled to run hourly at :15';
    ELSE
        RAISE NOTICE 'pg_cron extension not available - SIS sync job not scheduled';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Insufficient privileges to schedule cron job - must be run by superuser';
    WHEN OTHERS THEN
        RAISE NOTICE 'Failed to schedule SIS sync cron job: %', SQLERRM;
END $$;

-- 4. Create function to check SIS sync status and last run times
CREATE OR REPLACE FUNCTION admin_get_sis_sync_status()
RETURNS TABLE (
    class_id bigint,
    class_name text,
    term text,
    year integer,
    sis_sections_count bigint,
    last_sync_attempt timestamptz,
    sync_enabled boolean,
    total_invitations bigint,
    pending_invitations bigint,
    expired_invitations bigint
) AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    RETURN QUERY
    SELECT 
        c.id as class_id,
        c.name as class_name,
        c.term,
        c.year,
        (
            (SELECT COUNT(*) FROM public.class_sections cs WHERE cs.class_id = c.id AND cs.sis_crn IS NOT NULL) +
            (SELECT COUNT(*) FROM public.lab_sections ls WHERE ls.class_id = c.id AND ls.sis_crn IS NOT NULL)
        ) as sis_sections_count,
        c.updated_at as last_sync_attempt,
        NOT COALESCE(c.archived, false) as sync_enabled,
        COALESCE(invite_stats.total_invitations, 0) as total_invitations,
        COALESCE(invite_stats.pending_invitations, 0) as pending_invitations,
        COALESCE(invite_stats.expired_invitations, 0) as expired_invitations
    FROM public.classes c
    LEFT JOIN (
        SELECT 
            class_id,
            COUNT(*) as total_invitations,
            COUNT(*) FILTER (WHERE status = 'pending') as pending_invitations,
            COUNT(*) FILTER (WHERE status = 'expired') as expired_invitations
        FROM public.invitations
        GROUP BY class_id
    ) invite_stats ON c.id = invite_stats.class_id
    WHERE EXISTS (
        SELECT 1 FROM public.class_sections cs 
        WHERE cs.class_id = c.id AND cs.sis_crn IS NOT NULL
    )
    OR EXISTS (
        SELECT 1 FROM public.lab_sections ls 
        WHERE ls.class_id = c.id AND ls.sis_crn IS NOT NULL
    )
    ORDER BY c.term DESC, c.year DESC, c.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Create function to enable/disable SIS sync for a class (by archiving/unarchiving)
CREATE OR REPLACE FUNCTION admin_set_sis_sync_enabled(
    p_class_id bigint,
    p_enabled boolean,
    p_admin_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_admin_user_id) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Enable/disable by archiving/unarchiving the class
    UPDATE public.classes SET
        archived = NOT p_enabled,
        updated_at = now()
    WHERE id = p_class_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Comments for documentation
COMMENT ON FUNCTION trigger_sis_sync IS 'Triggers SIS enrollment sync via edge function. Can sync all classes or specific class.';
COMMENT ON FUNCTION admin_trigger_sis_sync IS 'Admin-only function to manually trigger SIS sync';
COMMENT ON FUNCTION admin_get_sis_sync_status IS 'Gets status of all SIS-linked classes for admin monitoring';
COMMENT ON FUNCTION admin_set_sis_sync_enabled IS 'Enables/disables SIS sync for a class by archiving/unarchiving';

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION trigger_sis_sync TO postgres;
GRANT EXECUTE ON FUNCTION admin_trigger_sis_sync TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_sis_sync_status TO authenticated;
GRANT EXECUTE ON FUNCTION admin_set_sis_sync_enabled TO authenticated;
