CREATE OR REPLACE FUNCTION "public"."submissions_insert_hook_optimized"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    assigned_ordinal integer;
BEGIN
    CASE TG_OP
    WHEN 'INSERT' THEN
        IF NEW.assignment_group_id IS NOT NULL THEN
            -- Handle group submissions: use actual group ID + special UUID
            INSERT INTO "public"."submission_ordinal_counters" 
                (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
            VALUES 
                (NEW.assignment_id::bigint, 
                 NEW.assignment_group_id::bigint, 
                 '00000000-0000-0000-0000-000000000000'::uuid, 
                 2::integer,
                 now())
            ON CONFLICT (assignment_id, assignment_group_id, profile_id)
            DO UPDATE SET 
                next_ordinal = submission_ordinal_counters.next_ordinal + 1,
                updated_at = now()
            RETURNING (submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;
            
            NEW.ordinal = assigned_ordinal;
            
            -- Only set is_active = true if this is NOT a NOT-GRADED submission
            IF NOT NEW.is_not_graded THEN
                NEW.is_active = true;
                UPDATE submissions SET is_active = false 
                WHERE assignment_id = NEW.assignment_id 
                AND assignment_group_id = NEW.assignment_group_id
                AND is_active = true;
            END IF;
        ELSE
            -- Handle individual submissions: use 0 for group ID + actual profile ID
            INSERT INTO "public"."submission_ordinal_counters" 
                (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
            VALUES 
                (NEW.assignment_id::bigint, 
                 0::bigint, 
                 NEW.profile_id::uuid, 
                 2::integer,
                 now())
            ON CONFLICT (assignment_id, assignment_group_id, profile_id)
            DO UPDATE SET 
                next_ordinal = submission_ordinal_counters.next_ordinal + 1,
                updated_at = now()
            RETURNING (submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;
            
            NEW.ordinal = assigned_ordinal;
            
            -- Only set is_active = true if this is NOT a NOT-GRADED submission
            IF NOT NEW.is_not_graded THEN
                NEW.is_active = true;
                UPDATE submissions SET is_active = false 
                WHERE assignment_id = NEW.assignment_id 
                AND profile_id = NEW.profile_id
                AND is_active = true;
            END IF;
        END IF;
        
        RETURN NEW;
    ELSE
        RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
    END CASE;
END
$$;


ALTER FUNCTION "public"."submissions_insert_hook_optimized"() OWNER TO "postgres";

drop index idx_submissions_rls_ultra_hot;



-- Archive for workflow_events (>48 hours old)
CREATE TABLE IF NOT EXISTS public.workflow_events_archive (LIKE public.workflow_events INCLUDING ALL);
ALTER TABLE public.workflow_events_archive ENABLE ROW LEVEL SECURITY;

-- Archive for audit (>48 hours old)
CREATE TABLE IF NOT EXISTS public.audit_archive (LIKE public.audit INCLUDING ALL);
ALTER TABLE public.audit_archive ENABLE ROW LEVEL SECURITY;

-- Add comments
COMMENT ON TABLE public.workflow_events_archive IS 'Archive of workflow_events older than 48 hours. Query here for historical data.';
COMMENT ON TABLE public.audit_archive IS 'Archive of audit records older than 48 hours. Query here for historical data.';

-- 2. Grant permissions
-- ===================================================================
GRANT SELECT ON public.workflow_events_archive TO authenticated, service_role;
GRANT SELECT ON public.audit_archive TO authenticated, service_role;

-- 3. Function to archive old workflow_events in batches
-- ===================================================================
CREATE OR REPLACE FUNCTION archive_old_workflow_events(
    p_cutoff_hours integer DEFAULT 48,
    p_batch_size integer DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_cutoff_date timestamptz;
    v_total_moved bigint := 0;
    v_batch_moved integer;
    v_start_time timestamptz;
    v_old_size bigint;
    v_new_size bigint;
BEGIN
    v_start_time := clock_timestamp();
    v_cutoff_date := now() - (p_cutoff_hours || ' hours')::interval;
    
    -- Get current size
    SELECT pg_total_relation_size('public.workflow_events') INTO v_old_size;
    
    RAISE NOTICE 'Starting archive of workflow_events older than % (cutoff: %)', 
        p_cutoff_hours || ' hours', v_cutoff_date;
    
    LOOP
        -- Move batch to archive
        WITH moved AS (
            INSERT INTO public.workflow_events_archive
            SELECT * FROM public.workflow_events
            WHERE created_at < v_cutoff_date
            ORDER BY created_at
            LIMIT p_batch_size
            RETURNING id
        )
        DELETE FROM public.workflow_events
        WHERE id IN (SELECT id FROM moved);
        
        GET DIAGNOSTICS v_batch_moved = ROW_COUNT;
        
        EXIT WHEN v_batch_moved = 0;
        
        v_total_moved := v_total_moved + v_batch_moved;
        
        -- Progress update every batch
        RAISE NOTICE 'Moved % rows (total: %)', v_batch_moved, v_total_moved;
        
        -- Small pause to avoid overload (10ms)
        PERFORM pg_sleep(0.01);
    END LOOP;
    
    -- Get new size
    SELECT pg_total_relation_size('public.workflow_events') INTO v_new_size;
    
    -- Vacuum to reclaim space
    EXECUTE 'VACUUM ANALYZE public.workflow_events';
    
    RETURN jsonb_build_object(
        'table', 'workflow_events',
        'rows_archived', v_total_moved,
        'cutoff_date', v_cutoff_date,
        'old_size_mb', round(v_old_size / 1024.0 / 1024.0, 2),
        'new_size_mb', round(v_new_size / 1024.0 / 1024.0, 2),
        'space_freed_mb', round((v_old_size - v_new_size) / 1024.0 / 1024.0, 2),
        'duration_seconds', extract(epoch from (clock_timestamp() - v_start_time))
    );
END;
$$;

-- 4. Function to archive old audit records in batches
-- ===================================================================
CREATE OR REPLACE FUNCTION archive_old_audit_records(
    p_cutoff_hours integer DEFAULT 48,
    p_batch_size integer DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_cutoff_date timestamptz;
    v_total_moved bigint := 0;
    v_batch_moved integer;
    v_start_time timestamptz;
    v_old_size bigint;
    v_new_size bigint;
BEGIN
    v_start_time := clock_timestamp();
    v_cutoff_date := now() - (p_cutoff_hours || ' hours')::interval;
    
    -- Get current size
    SELECT pg_total_relation_size('public.audit') INTO v_old_size;
    
    RAISE NOTICE 'Starting archive of audit older than % (cutoff: %)', 
        p_cutoff_hours || ' hours', v_cutoff_date;
    
    LOOP
        -- Move batch to archive
        WITH moved AS (
            INSERT into public.audit_new
            SELECT * FROM public.audit
            WHERE created_at < v_cutoff_date
            ORDER BY created_at
            LIMIT p_batch_size
            RETURNING id
        )
        DELETE FROM public.audit
        WHERE id IN (SELECT id FROM moved);
        
        GET DIAGNOSTICS v_batch_moved = ROW_COUNT;
        
        EXIT WHEN v_batch_moved = 0;
        
        v_total_moved := v_total_moved + v_batch_moved;
        
        -- Progress update every batch
        RAISE NOTICE 'Moved % rows (total: %)', v_batch_moved, v_total_moved;
        
        -- Small pause to avoid overload (10ms)
        PERFORM pg_sleep(0.01);
    END LOOP;
    
    -- Get new size
    SELECT pg_total_relation_size('public.audit') INTO v_new_size;
    
    -- Vacuum to reclaim space
    EXECUTE 'VACUUM ANALYZE public.audit';
    
    RETURN jsonb_build_object(
        'table', 'audit',
        'rows_archived', v_total_moved,
        'cutoff_date', v_cutoff_date,
        'old_size_mb', round(v_old_size / 1024.0 / 1024.0, 2),
        'new_size_mb', round(v_new_size / 1024.0 / 1024.0, 2),
        'space_freed_mb', round((v_old_size - v_new_size) / 1024.0 / 1024.0, 2),
        'duration_seconds', extract(epoch from (clock_timestamp() - v_start_time))
    );
END;
$$;

-- 5. Create unified view for easy querying
-- ===================================================================
-- These views combine hot + archive data transparently
-- Use these for queries that might span both tables

-- The below was mistakingly committed, future work should do more cleanup here.

-- CREATE OR REPLACE VIEW public.workflow_events_all AS
-- SELECT * FROM public.workflow_events
-- UNION ALL
-- SELECT * FROM public.workflow_events_archive;

-- CREATE OR REPLACE VIEW public.audit_all AS
-- SELECT * FROM public.audit
-- UNION ALL
-- SELECT * FROM public.audit_archive;

-- GRANT SELECT ON public.workflow_events_all TO authenticated, service_role;
-- GRANT SELECT ON public.audit_all TO authenticated, service_role;

-- COMMENT ON VIEW public.workflow_events_all IS 
-- 'Union view of hot + archive workflow_events. Use workflow_events for recent data (faster), this view for historical queries.';

-- COMMENT ON VIEW public.audit_all IS 
-- 'Union view of hot + archive audit. Use audit for recent data (faster), this view for historical queries.';


-- CREATE OR REPLACE FUNCTION "public"."audit_discussion_threads_statement"() RETURNS "trigger"
--     LANGUAGE "plpgsql" SECURITY DEFINER
--     AS $$
-- DECLARE
--     remote_ip text;
--     current_user_id uuid;
-- BEGIN
--     -- Set fixed search_path to prevent search_path attacks
--     PERFORM set_config('search_path', 'pg_catalog, public', true);
    
--     -- Get common values (matches original audit_insert_and_update logic)
--     current_user_id := auth.uid();
--     SELECT split_part(
--         current_setting('request.headers', true)::json->>'x-forwarded-for',
--         ',', 1) INTO remote_ip;
        
--     CASE TG_OP
--     WHEN 'INSERT' THEN
--         -- Batch insert audit records for all new rows (matches original format)
--         INSERT into public.audit_new (class_id, user_id, "table", old, new, ip_addr)
--         SELECT n.class_id, current_user_id, TG_TABLE_NAME, NULL, row_to_json(n), remote_ip
--         FROM NEW_TABLE n;
        
--     WHEN 'UPDATE' THEN
--         -- Batch insert audit records for all updated rows (matches original format)
--         INSERT into public.audit_new (class_id, user_id, "table", old, new, ip_addr)
--         SELECT COALESCE(n.class_id, o.class_id), current_user_id, TG_TABLE_NAME, 
--                row_to_json(o), row_to_json(n), remote_ip
--         FROM NEW_TABLE n
--         JOIN OLD_TABLE o ON n.id = o.id;
        
--     ELSE
--         RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
--     END CASE;
    
--     RETURN NULL;
-- END
-- $$;


-- ALTER FUNCTION "public"."audit_discussion_threads_statement"() OWNER TO "postgres";


-- COMMENT ON FUNCTION "public"."audit_discussion_threads_statement"() IS 'STATEMENT-level audit trigger that logs all changes in batch operations. Provides complete audit trail while being highly efficient for bulk operations.';



-- CREATE OR REPLACE FUNCTION "public"."audit_insert_and_update"() RETURNS "trigger"
--     LANGUAGE "plpgsql" SECURITY DEFINER
--     AS $$
--     declare
--       remote_ip text;
-- BEGIN
-- SELECT split_part(
--   current_setting('request.headers', true)::json->>'x-forwarded-for',
--   ',', 1) into remote_ip;
--    CASE TG_OP
--    WHEN 'UPDATE' THEN
--       INSERT into public.audit_new (class_id,user_id,"table",old,new, ip_addr) values
--       (NEW.class_id,
--       auth.uid(),
--       TG_TABLE_NAME,
--       row_to_json(OLD.*),
--       row_to_json(NEW.*),
--       remote_ip
--       );
--       RETURN NULL;
--    WHEN 'INSERT' THEN
--       INSERT into public.audit_new (class_id,user_id,"table",old,new, ip_addr) values
--       (NEW.class_id,
--       auth.uid(),
--       TG_TABLE_NAME,
--       NULL,
--       row_to_json(NEW.*),
--       remote_ip
--       );
--       RETURN NULL;
--    ELSE
--       RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
--    END CASE;
   
-- END;
-- $$;


-- ALTER FUNCTION "public"."audit_insert_and_update"() OWNER TO "postgres";


-- CREATE OR REPLACE FUNCTION "public"."audit_insert_and_update_and_delete"() RETURNS "trigger"
--     LANGUAGE "plpgsql" SECURITY DEFINER
--     AS $$
--     declare
--       remote_ip text;
-- BEGIN
-- SELECT split_part(
--   current_setting('request.headers', true)::json->>'x-forwarded-for',
--   ',', 1) into remote_ip;
--    CASE TG_OP
--    WHEN 'UPDATE' THEN
--       INSERT into public.audit_new (class_id,user_id,"table",old,new, ip_addr) values
--       (NEW.class_id,
--       auth.uid(),
--       TG_TABLE_NAME,
--       row_to_json(OLD.*),
--       row_to_json(NEW.*),
--       remote_ip
--       );
--       RETURN NULL;
--    WHEN 'INSERT' THEN
--       INSERT into public.audit_new (class_id,user_id,"table",old,new, ip_addr) values
--       (NEW.class_id,
--       auth.uid(),
--       TG_TABLE_NAME,
--       NULL,
--       row_to_json(NEW.*),
--       remote_ip
--       );
--       RETURN NULL;
--    WHEN 'DELETE' THEN
--       INSERT into public.audit_new (class_id,user_id,"table",old,new, ip_addr) values
--       (OLD.class_id,
--       auth.uid(),
--       TG_TABLE_NAME,
--       row_to_json(OLD.*),
--       NULL,
--       remote_ip
--       );
--       RETURN NULL;
--    ELSE
--       RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
--    END CASE;
   
-- END;
-- $$;


ALTER FUNCTION "public"."audit_insert_and_update_and_delete"() OWNER TO "postgres";

-- Clean up pg_cron job run details older than 2 days
SELECT cron.schedule(
  'cleanup-cron-history',
  '0 4 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < NOW() - INTERVAL '2 days'$$
);