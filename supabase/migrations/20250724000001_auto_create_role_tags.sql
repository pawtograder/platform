/*
 * Migration: Auto-create role tags for instructors and graders
 * 
 * Purpose: This migration creates a trigger that automatically creates 
 * "instructor" or "grader" tags on a user's profile when their role 
 * changes to instructor or grader respectively.
 * 
 * Tables affected:
 * - user_roles (trigger source - monitors role changes)
 * - tags (target table - where new tags are created)
 * 
 * Behavior:
 * - Triggers on UPDATE of user_roles table when role field changes
 * - Creates appropriate tag for both private and public profiles
 * - Prevents duplicate tags by checking for existing tags first
 * - Uses system colors and makes tags visible by default
 */

-- create trigger function to auto-create role tags
create or replace function public.auto_create_role_tags()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tag_name text;
  tag_color text;
  profile_ids uuid[];
  current_profile_id uuid;
  should_create_tag boolean := false;
begin
  -- determine if we should create a tag based on operation type
  if tg_op = 'INSERT' then
    -- for new records, create tag if role is instructor or grader
    should_create_tag := new.role in ('instructor', 'grader');
  elsif tg_op = 'UPDATE' then
    -- for updates, create tag if role changed to instructor or grader
    should_create_tag := old.role is distinct from new.role and new.role in ('instructor', 'grader');
  end if;
  
  -- only proceed if we should create a tag
  if should_create_tag then
    
    -- determine tag name and color based on role
    if new.role = 'instructor' then
      tag_name := 'instructor';
      tag_color := '#3182ce'; -- blue color for instructors
    elsif new.role = 'grader' then
      tag_name := 'grader';  
      tag_color := '#38a169'; -- green color for graders
    end if;
    
    -- collect both private and public profile ids
    profile_ids := array[new.private_profile_id, new.public_profile_id];
    
    -- create tags for both profiles
    foreach current_profile_id in array profile_ids
    loop
      -- check if tag already exists for this profile to prevent duplicates
      if not exists (
        select 1 
        from public.tags 
        where profile_id = current_profile_id 
          and name = tag_name 
          and class_id = new.class_id
      ) then
        -- create the tag
        insert into public.tags (
          name,
          profile_id,
          class_id,
          creator_id,
          color,
          visible,
          created_at
        ) values (
          tag_name,
          current_profile_id,
          new.class_id,
          new.user_id,
          tag_color,
          true, -- make tag visible by default
          now()
        );
      end if;
    end loop;
    
  end if;
  
  return new;
end;
$$;

-- create trigger on user_roles table for both insert and update
create trigger auto_create_role_tags_trigger
after insert or update on public.user_roles
for each row
execute function public.auto_create_role_tags();

-- add comment to document the trigger
comment on function public.auto_create_role_tags() is 
'Automatically creates instructor or grader tags on user profiles when user role is set to instructor or grader (both for new users and role changes). Prevents duplicate tags and applies to both private and public profiles.'; 