-- Migration: Course controller realtime broadcasts  
-- This migration adds realtime broadcast functionality for tables that haven't been migrated yet:
-- profiles, user_roles, discussion_threads, discussion_thread_read_status, tags, lab_sections, lab_section_meetings
-- Following the unified broadcast channel pattern established in 20250707020000_unified-broadcast-channels.sql

-- Create unified broadcast function for class-wide data (profiles, user_roles, discussion_threads, lab_sections, lab_section_meetings)
create or replace function broadcast_class_data_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    class_id_value bigint;
    staff_payload jsonb;
    user_payload jsonb;
    all_user_ids uuid[];
    user_id uuid;
begin
    -- Get the class_id from the record
    if tg_op = 'insert' then
        class_id_value := new.class_id;
    elsif tg_op = 'update' then
        class_id_value := coalesce(new.class_id, old.class_id);
    elsif tg_op = 'delete' then
        class_id_value := old.class_id;
    end if;

    if class_id_value is not null then
        -- Create payload with class-wide information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'data', case 
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'class_id', class_id_value,
            'timestamp', now()
        );

        -- Broadcast to staff channel
        perform realtime.send(
            staff_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );

        -- Get all user profile IDs for this class to broadcast to individual user channels
        select array(
            select distinct ur.private_profile_id
            from public.user_roles ur
            where ur.class_id = class_id_value
        ) into all_user_ids;

        -- Create user payload (same as staff payload but marked for users)
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to all user channels in the class
        foreach user_id in array all_user_ids
        loop
            perform realtime.send(
                user_payload,
                'broadcast',
                'class:' || class_id_value || ':user:' || user_id,
                true
            );
        end loop;
    end if;

    -- Return the appropriate record
    if tg_op = 'delete' then
        return old;
    else
        return new;
    end if;
end;
$$;

-- Create broadcast function for user-specific data (discussion_thread_read_status)
create or replace function broadcast_user_specific_data_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    class_id_value bigint;
    profile_id_value uuid;
    staff_payload jsonb;
    user_payload jsonb;
begin
    -- Get user_id and derive class_id and profile_id
    if tg_op = 'insert' then
        -- Get class_id from the discussion thread and profile_id from user mapping
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = new.discussion_thread_id;
        
        select ur.private_profile_id into profile_id_value
        from public.user_roles ur
        where ur.user_id = new.user_id
        and ur.class_id = class_id_value
        limit 1;
        
    elsif tg_op = 'update' then
        -- Get class_id from the discussion thread and profile_id from user mapping
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = coalesce(new.discussion_thread_id, old.discussion_thread_id);
        
        select ur.private_profile_id into profile_id_value
        from public.user_roles ur
        where ur.user_id = coalesce(new.user_id, old.user_id)
        and ur.class_id = class_id_value
        limit 1;
        
    elsif tg_op = 'delete' then
        -- Get class_id from the discussion thread and profile_id from user mapping
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = old.discussion_thread_id;
        
        select ur.private_profile_id into profile_id_value
        from public.user_roles ur
        where ur.user_id = old.user_id
        and ur.class_id = class_id_value
        limit 1;
    end if;

    if class_id_value is not null and profile_id_value is not null then
        -- Create payload with user-specific information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'data', case 
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'class_id', class_id_value,
            'profile_id', profile_id_value,
            'timestamp', now()
        );

        -- Broadcast to staff channel
        perform realtime.send(
            staff_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );

        -- Broadcast to specific user channel
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
        perform realtime.send(
            user_payload,
            'broadcast',
            'class:' || class_id_value || ':user:' || profile_id_value,
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

-- Create broadcast function for profile-scoped data (tags)
create or replace function broadcast_profile_scoped_data_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    class_id_value bigint;
    profile_id_value uuid;
    creator_profile_id uuid;
    staff_payload jsonb;
    user_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
begin
    -- Get the class_id and profile_id from the record
    if tg_op = 'insert' then
        class_id_value := new.class_id;
        profile_id_value := new.profile_id::uuid;
        -- Get creator's profile_id from user_id
        select ur.private_profile_id into creator_profile_id
        from public.user_roles ur
        where ur.user_id = new.creator_id
        and ur.class_id = new.class_id
        limit 1;
    elsif tg_op = 'update' then
        class_id_value := coalesce(new.class_id, old.class_id);
        profile_id_value := coalesce(new.profile_id::uuid, old.profile_id::uuid);
        -- Get creator's profile_id from user_id
        select ur.private_profile_id into creator_profile_id
        from public.user_roles ur
        where ur.user_id = coalesce(new.creator_id, old.creator_id)
        and ur.class_id = class_id_value
        limit 1;
    elsif tg_op = 'delete' then
        class_id_value := old.class_id;
        profile_id_value := old.profile_id::uuid;
        -- Get creator's profile_id from user_id
        select ur.private_profile_id into creator_profile_id
        from public.user_roles ur
        where ur.user_id = old.creator_id
        and ur.class_id = old.class_id
        limit 1;
    end if;

    if class_id_value is not null then
        -- Create payload with profile-scoped information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'data', case 
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'class_id', class_id_value,
            'profile_id', profile_id_value,
            'timestamp', now()
        );

        -- Broadcast to staff channel (they see all tags)
        perform realtime.send(
            staff_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );

        -- Determine affected profile IDs: tagged profile + creator (if visible) or all users (if visible globally)
        if tg_op = 'insert' and new.visible = true then
            -- If tag is visible, broadcast to all users in class
            select array(
                select distinct ur.private_profile_id
                from public.user_roles ur
                where ur.class_id = class_id_value
            ) into affected_profile_ids;
        elsif tg_op = 'update' and (new.visible = true or old.visible = true) then
            -- If tag visibility changed or is visible, broadcast to all users in class
            select array(
                select distinct ur.private_profile_id
                from public.user_roles ur
                where ur.class_id = class_id_value
            ) into affected_profile_ids;
        else
            -- If tag is not visible, only broadcast to tagged profile and creator
            affected_profile_ids := array[profile_id_value];
            if creator_profile_id is not null and creator_profile_id != profile_id_value then
                affected_profile_ids := affected_profile_ids || creator_profile_id;
            end if;
        end if;

        -- Create user payload
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to affected user channels
        if affected_profile_ids is not null then
            foreach profile_id in array affected_profile_ids
            loop
                perform realtime.send(
                    user_payload,
                    'broadcast',
                    'class:' || class_id_value || ':user:' || profile_id,
                    true
                );
            end loop;
        end if;
    end if;

    -- Return the appropriate record
    if tg_op = 'delete' then
        return old;
    else
        return new;
    end if;
end;
$$;

-- Create triggers for class-wide data tables
create or replace trigger broadcast_profiles_realtime
    after insert or update or delete on public.profiles
    for each row
    execute function broadcast_class_data_change();

create or replace trigger broadcast_user_roles_realtime
    after insert or update or delete on public.user_roles
    for each row
    execute function broadcast_class_data_change();

create or replace trigger broadcast_discussion_threads_realtime
    after insert or update or delete on public.discussion_threads
    for each row
    execute function broadcast_class_data_change();

create or replace trigger broadcast_lab_sections_realtime
    after insert or update or delete on public.lab_sections
    for each row
    execute function broadcast_class_data_change();

create or replace trigger broadcast_lab_section_meetings_realtime
    after insert or update or delete on public.lab_section_meetings
    for each row
    execute function broadcast_class_data_change();

-- Create trigger for user-specific data
create or replace trigger broadcast_discussion_thread_read_status_realtime
    after insert or update or delete on public.discussion_thread_read_status
    for each row
    execute function broadcast_user_specific_data_change();

-- Create trigger for profile-scoped data
create or replace trigger broadcast_tags_realtime
    after insert or update or delete on public.tags
    for each row
    execute function broadcast_profile_scoped_data_change();

-- Add comments for documentation
comment on function broadcast_class_data_change() is 
'Broadcasts changes to class-wide data tables (profiles, user_roles, discussion_threads, lab_sections, lab_section_meetings). Messages are sent to both staff channel and all user channels in the class.';

comment on function broadcast_user_specific_data_change() is 
'Broadcasts changes to user-specific data tables (discussion_thread_read_status). Messages are sent to staff channel and the specific user channel.';

comment on function broadcast_profile_scoped_data_change() is 
'Broadcasts changes to profile-scoped data tables (tags). Messages are sent to staff channel and relevant user channels based on tag visibility and ownership.';

-- Usage Examples:
-- 
-- 1. Message payload format for all functions:
--    {
--      "type": "table_change",
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "profiles|user_roles|discussion_threads|lab_sections|lab_section_meetings|discussion_thread_read_status|tags",
--      "data": { ... },            // Full row data
--      "class_id": 123,            // Context information
--      "profile_id": "uuid-here",  // Present for user-specific and profile-scoped data
--      "target_audience": "user",  // Only present in user channels
--      "timestamp": "2025-01-07T..."
--    }
--
-- 2. Channel patterns used:
--    - Staff: class:$class_id:staff
--    - User: class:$class_id:user:$profile_id
--
-- 3. Broadcasting logic:
--    - Class-wide data: broadcast to staff + all users in class
--    - User-specific data: broadcast to staff + specific user
--    - Profile-scoped data: broadcast to staff + affected users (based on visibility/ownership)
--
-- 4. Client-side handling:
--    - Subscribe to appropriate channels based on user role and profile
--    - Filter messages by table name if needed
--    - Use the data field for the full record information
--    - RLS policies automatically apply when fetching additional related data 