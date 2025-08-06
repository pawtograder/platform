-- Migration: Course controller realtime broadcasts  
-- This migration adds realtime broadcast functionality for tables that haven't been migrated yet:
-- profiles, user_roles, discussion_threads, discussion_thread_read_status, tags, lab_sections, lab_section_meetings
-- Following the broadcast pattern established in the office hours migration

-- Create broadcast function for course data tables
-- This function sends broadcasts to table-specific channels that TableController can listen to
create or replace function broadcast_course_table_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    class_id_value bigint;
    row_id bigint;
    main_payload jsonb;
begin
    -- Get the class_id and row_id from the record
    if tg_op = 'insert' then
        class_id_value := new.class_id;
        row_id := new.id;
    elsif tg_op = 'update' then
        class_id_value := coalesce(new.class_id, old.class_id);
        row_id := coalesce(new.id, old.id);
    elsif tg_op = 'delete' then
        class_id_value := old.class_id;
        row_id := old.id;
    end if;

    -- Only broadcast if we have valid class_id
    if class_id_value is not null then
        -- Create payload with table-specific information
        main_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', case 
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'timestamp', now()
        );

        -- Broadcast to table-specific channel that TableController listens to
        perform realtime.send(
            main_payload,
            'broadcast',
            tg_table_name,
            true
        );
    end if;

    -- Return the appropriate record
    if tg_op = 'delete' then
        return old;
    else
        return new;
    end if;
end;
$$;

-- Create special broadcast function for discussion_thread_read_status
-- This table doesn't have a class_id directly, so we need to get it from the discussion thread
create or replace function broadcast_discussion_thread_read_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    class_id_value bigint;
    row_id bigint;
    main_payload jsonb;
begin
    -- Get class_id from the discussion thread and row_id
    if tg_op = 'insert' then
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = new.discussion_thread_id;
        row_id := new.id;
    elsif tg_op = 'update' then
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = coalesce(new.discussion_thread_id, old.discussion_thread_id);
        row_id := coalesce(new.id, old.id);
    elsif tg_op = 'delete' then
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = old.discussion_thread_id;
        row_id := old.id;
    end if;

    -- Only broadcast if we have valid class_id
    if class_id_value is not null then
        -- Create payload with table-specific information
        main_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', case 
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'timestamp', now()
        );

        -- Broadcast to table-specific channel that TableController listens to
        perform realtime.send(
            main_payload,
            'broadcast',
            tg_table_name,
            true
        );
    end if;

    -- Return the appropriate record
    if tg_op = 'delete' then
        return old;
    else
        return new;
    end if;
end;
$$;



-- Create triggers for course data tables
create or replace trigger broadcast_profiles_realtime
    after insert or update or delete on public.profiles
    for each row
    execute function broadcast_course_table_change();

create or replace trigger broadcast_user_roles_realtime
    after insert or update or delete on public.user_roles
    for each row
    execute function broadcast_course_table_change();

create or replace trigger broadcast_discussion_threads_realtime
    after insert or update or delete on public.discussion_threads
    for each row
    execute function broadcast_course_table_change();

create or replace trigger broadcast_lab_sections_realtime
    after insert or update or delete on public.lab_sections
    for each row
    execute function broadcast_course_table_change();

create or replace trigger broadcast_lab_section_meetings_realtime
    after insert or update or delete on public.lab_section_meetings
    for each row
    execute function broadcast_course_table_change();

create or replace trigger broadcast_tags_realtime
    after insert or update or delete on public.tags
    for each row
    execute function broadcast_course_table_change();

-- Create trigger for discussion_thread_read_status (special case)
create or replace trigger broadcast_discussion_thread_read_status_realtime
    after insert or update or delete on public.discussion_thread_read_status
    for each row
    execute function broadcast_discussion_thread_read_status_change();

-- Add comments for documentation
comment on function broadcast_course_table_change() is 
'Broadcasts changes to course data tables (profiles, user_roles, discussion_threads, lab_sections, lab_section_meetings, tags). Messages are sent to table-specific channels that TableController instances listen to.';

comment on function broadcast_discussion_thread_read_status_change() is 
'Broadcasts changes to discussion_thread_read_status table. Messages are sent to table-specific channels that TableController instances listen to. Special handling for getting class_id from discussion_threads.';

-- Usage Examples:
-- 
-- 1. Message payload format for all functions:
--    {
--      "type": "table_change",
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "profiles|user_roles|discussion_threads|lab_sections|lab_section_meetings|tags|discussion_thread_read_status",
--      "row_id": 123,              // The ID of the affected row
--      "data": { ... },            // Full row data
--      "class_id": 123,            // Context information for filtering
--      "timestamp": "2025-01-07T..."
--    }
--
-- 2. Channel patterns used:
--    - Table-specific: {table_name} (e.g., "profiles", "discussion_threads")
--
-- 3. Broadcasting logic:
--    - All course data tables: broadcast to table-specific channel
--    - TableController instances filter by class_id on the client side
--
-- 4. Client-side handling:
--    - TableController subscribes to table-specific channels
--    - Filters by class_id and applies RLS policies
--    - Automatically updates internal data structures
--    - Provides hooks for React components to subscribe to changes 