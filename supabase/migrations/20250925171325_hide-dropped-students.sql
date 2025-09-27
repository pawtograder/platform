-- Ignore disabled students

CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER  
SET search_path TO ''
AS $$
    -- Ultra-optimized version using arrays for maximum performance with massive datasets
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'private_profile_id', student_id::text,
            'entries', entries_array
        ) ORDER BY student_id
    ), '[]'::jsonb)
    FROM (
        SELECT 
            gcs.student_id,
                         jsonb_agg(
                 ARRAY[
                     gcs.id::text,
                     gcs.gradebook_column_id::text, 
                     gcs.is_private::text,
                     COALESCE(gcs.score::text, ''),
                     COALESCE(gcs.score_override::text, ''),
                     gcs.is_missing::text,
                     gcs.is_excused::text,
                     gcs.is_droppable::text,
                     gcs.released::text,
                     COALESCE(gcs.score_override_note, ''),
                     gcs.is_recalculating::text,
                     COALESCE(gcs.incomplete_values::text, '')
                 ] ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
             ) as entries_array
        FROM public.gradebook_column_students gcs
        INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
        INNER JOIN public.user_privileges up on up.private_profile_id = gcs.student_id
        WHERE gcs.class_id = get_gradebook_records_for_all_students_array.class_id
        and EXISTS (
          SELECT 1 FROM public.user_privileges up
          WHERE up.user_id = auth.uid()
            AND up.class_id = get_gradebook_records_for_all_students_array.class_id
            AND up.role IN ('instructor','grader')
        )
        GROUP BY gcs.student_id
    ) array_data;
$$;


-- 2) Update create_all_repos_for_assignment to pass assignment details to enqueue function
create or replace function public.create_all_repos_for_assignment(course_id bigint, assignment_id bigint, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_course_id bigint := course_id;
  v_assignment_id bigint := assignment_id;
  v_slug text;
  v_org text;
  v_template_repo text;
  v_group_config text;
  v_assignment_slug text;
  v_latest_template_sha text;
  r_user_id uuid;
  r_username text;
  r_profile_id uuid;
  r_group_id bigint;
  r_group_name text;
  r_members text[];
begin
  raise notice 'Enqueue create_all_repos_for_assignment course_id=%, assignment_id=%, force=%', v_course_id, v_assignment_id, p_force;
  if v_course_id is null or v_assignment_id is null then
    raise warning 'create_all_repos_for_assignment called with NULL parameters, skipping';
    return;
  end if;

  -- Only instructors (manual) or service role may enable force
  if auth.uid() is not null and not public.authorizeforclassinstructor(v_course_id::bigint) then
    raise exception 'Access denied: Only instructors can force-create repos for class %', v_course_id;
  end if;

  select c.slug, c.github_org, a.template_repo, a.group_config, a.slug, a.latest_template_sha
  into v_slug, v_org, v_template_repo, v_group_config, v_assignment_slug, v_latest_template_sha
  from public.assignments a
  join public.classes c on c.id = a.class_id
  where a.id = v_assignment_id and a.class_id = v_course_id;

  if v_slug is null or v_org is null or v_template_repo is null or v_template_repo = '' then
    raise exception 'Invalid class/assignment or missing template repo (class_id %, assignment_id %)', course_id, assignment_id;
  end if;

  raise notice 'Resolved org=%, slug=%, template=%', v_org, v_slug, v_template_repo;

  -- Enqueue individual repos for students not in groups; if p_force, enqueue even if repo exists
  for r_user_id, r_username, r_profile_id in
    select ur.user_id, u.github_username, ur.private_profile_id
    from public.user_roles ur
    join public.users u on u.user_id = ur.user_id
    where ur.class_id = v_course_id
      and ur.role = 'student'
      and ur.disabled = false
      and u.github_username is not null
      and not exists (
        select 1 from public.assignment_groups_members agm
        join public.assignment_groups ag on ag.id = agm.assignment_group_id
        where ag.assignment_id = v_assignment_id and agm.profile_id = ur.private_profile_id
      )
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.assignment_id = v_assignment_id and r.profile_id = ur.private_profile_id
        )
      )
  loop
    raise notice 'Enqueue individual repo: %/%', v_org, v_slug || '-' || v_assignment_slug || '-' || r_username;
    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-' || r_username,
      v_template_repo,
      v_slug,
      array[r_username],
      false,
      null,
      v_assignment_id,  -- Pass assignment_id
      r_profile_id,     -- Pass profile_id
      null,             -- assignment_group_id is null for individual repos
      v_latest_template_sha
    );
  end loop;

  -- Enqueue group repos; if p_force, enqueue even if repo exists (worker will sync permissions)
  for r_group_id, r_group_name, r_members in
    select ag.id as group_id,
           ag.name as group_name,
           array_remove(array_agg(u.github_username), null) as members
    from public.assignment_groups ag
    left join public.assignment_groups_members agm on agm.assignment_group_id = ag.id
    left join public.user_roles ur on ur.private_profile_id = agm.profile_id
    left join public.users u on u.user_id = ur.user_id
    where ag.assignment_id = v_assignment_id
      and ur.disabled = false
      and (
        p_force
        or not exists (
          select 1 from public.repositories r where r.assignment_group_id = ag.id
        )
      )
    group by ag.id, ag.name
  loop
    raise notice 'Enqueue group repo: %/%', v_org, v_slug || '-' || v_assignment_slug || '-group-' || r_group_name;
    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-group-' || r_group_name,
      v_template_repo,
      v_slug,
      r_members,
      false,
      null,
      v_assignment_id,  -- Pass assignment_id
      null,             -- profile_id is null for group repos
      r_group_id,       -- Pass assignment_group_id
      v_latest_template_sha
    );
  end loop;
end;
$$;

-- 3) Update create_repos_for_student to pass assignment details to enqueue function
create or replace function public.create_repos_for_student(user_id uuid, class_id integer default null, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_slug text;
  v_org text;
  v_user_id uuid := user_id;
  v_class_id integer := class_id;
  r_assignment_id bigint;
  r_assignment_slug text;
  r_template_repo text;
  r_course_id bigint;
  r_course_slug text;
  r_github_org text;
  r_latest_template_sha text;
  r_profile_id uuid;
begin
  if user_id is null then
    raise warning 'create_repos_for_student called with NULL user_id, skipping';
    return;
  end if;

  select u.github_username into v_username from public.users u where u.user_id = v_user_id;
  if v_username is null or v_username = '' then
    raise exception 'User % has no GitHub username linked', user_id;
  end if;

  if p_force then
    -- If called manually (auth present), require instructor for the target class. If class_id is null, forbid for non-service callers.
    if auth.uid() is not null then
      if class_id is null then
        raise exception 'Force create for all classes requires service role';
      end if;
      if not public.authorizeforclassinstructor(class_id::bigint) then
        raise exception 'Access denied: Only instructors can force-create repos for class %', class_id;
      end if;
    end if;
  end if;

  for r_assignment_id, r_assignment_slug, r_template_repo, r_course_id, r_course_slug, r_github_org, r_latest_template_sha, r_profile_id in
    select a.id as assignment_id, a.slug as assignment_slug, a.template_repo, c.id as course_id, c.slug as course_slug, c.github_org, a.latest_template_sha, ur.private_profile_id
    from public.assignments a
    join public.classes c on c.id = a.class_id
    join public.user_roles ur on ur.class_id = c.id
    where ur.user_id = v_user_id
      and ur.disabled = false
      and (v_class_id is null or c.id = v_class_id)
      and a.template_repo is not null and a.template_repo <> ''
      and a.group_config <> 'groups'
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.assignment_id = a.id and r.profile_id = ur.private_profile_id
        )
      )
  loop
    perform public.enqueue_github_create_repo(
      r_course_id,
      r_github_org,
      r_course_slug || '-' || r_assignment_slug || '-' || v_username,
      r_template_repo,
      r_course_slug,
      array[v_username],
      false,
      null,
      r_assignment_id,  -- Pass assignment_id
      r_profile_id,     -- Pass profile_id
      null,             -- assignment_group_id is null for individual repos
      r_latest_template_sha
    );
  end loop;
end;
$$;

-- Update trigger on user_roles to re-sync student team when a student is deactivated
CREATE OR REPLACE FUNCTION "public"."sync_github_teams_on_role_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Handle INSERT: new role added
  if TG_OP = 'INSERT' then
    if NEW.role in ('instructor', 'grader') then
      perform public.sync_staff_github_team(NEW.class_id, NEW.user_id);
    elsif NEW.role = 'student' then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
      -- Also create repos for the student if github_org_confirmed is true
      if NEW.github_org_confirmed = true then
        perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
      end if;
    end if;
    return NEW;
  end if;

  -- Handle UPDATE: role changed or github_org_confirmed changed
  if TG_OP = 'UPDATE' then
    -- If role changed to/from staff role or between staff roles
    if (OLD.role not in ('instructor', 'grader') and NEW.role in ('instructor', 'grader')) or
       (OLD.role in ('instructor', 'grader') and NEW.role not in ('instructor', 'grader')) or
       (OLD.role in ('instructor', 'grader') and NEW.role in ('instructor', 'grader') and OLD.role != NEW.role) then
      perform public.sync_staff_github_team(NEW.class_id, NEW.user_id);
    end if;

    -- If role changed to/from student role
    if (OLD.role != 'student' and NEW.role = 'student') or
       (OLD.role = 'student' and NEW.role != 'student') then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
    end if;

    -- NEW: If student role is reactivated or deactivated
    if NEW.role = 'student' and 
       OLD.disabled != NEW.disabled then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
    end if;

    -- Consolidated repo creation logic: create repos if any of these conditions are true:
    -- 1. Role changed to student AND github_org_confirmed is true
    -- 2. Role is student AND github_org_confirmed changed to true
    -- 3. Student role was reactivated AND github_org_confirmed is true
    declare
      should_create_repos boolean := false;
    begin
      should_create_repos := (
        NEW.role = 'student' and NEW.github_org_confirmed = true and (
          -- Condition 1: Role changed to student
          (OLD.role != 'student' and NEW.role = 'student') or
          -- Condition 2: github_org_confirmed changed to true for existing student
          (OLD.github_org_confirmed is distinct from NEW.github_org_confirmed) or
          -- Condition 3: Student role was reactivated
          (OLD.disabled = true and NEW.disabled = false)
        )
      );

      if should_create_repos then
        perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
      end if;
    end;

    return NEW;
  end if;

  -- Handle DELETE: role removed
  if TG_OP = 'DELETE' then
    if OLD.role in ('instructor', 'grader') then
      perform public.sync_staff_github_team(OLD.class_id, OLD.user_id);
    elsif OLD.role = 'student' then
      perform public.sync_student_github_team(OLD.class_id, OLD.user_id);
    end if;
    return OLD;
  end if;

  return null;
end;
$$;
