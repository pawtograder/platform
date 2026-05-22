-- RPCs that produce submission rows for the two no-repo modes:
--
--   * create_no_repo_submission — repo_mode='none'. The student calls this
--     themselves after uploading files to the submission-files storage bucket.
--   * create_manual_submission  — repo_mode='no_submission'. An instructor
--     calls this to create a stub submission (no files, no repo) so the
--     grading flow has a row to attach reviews to (e.g. presentations).
--
-- For create_no_repo_submission, files are expected to have already been
-- uploaded to the submission-files storage bucket at
-- `classes/{class_id}/profiles/{profile_or_group_id}/submissions/{submission_id}/files/{name}`
-- by the browser before this RPC is called.

create or replace function public.create_no_repo_submission(
  p_assignment_id bigint,
  p_files jsonb  -- array of { name, storage_key, file_size, mime_type }
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_class_id bigint;
  v_repo_mode public.assignment_repo_mode;
  v_release timestamptz;
  v_profile_id uuid;
  v_assignment_group_id bigint;
  v_submission_id bigint;
  v_run_number int;
  v_ordinal int;
  v_file jsonb;
begin
  if v_user_id is null then
    raise exception 'Must be authenticated' using errcode = '42501';
  end if;

  select a.class_id, a.repo_mode, a.release_date
    into v_class_id, v_repo_mode, v_release
    from public.assignments a
   where a.id = p_assignment_id;

  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;
  if v_repo_mode <> 'none' then
    -- 'no_submission' deliberately falls through to this branch: students
    -- cannot upload anything for that mode, instructors call
    -- create_manual_submission instead.
    raise exception 'Assignment % does not accept student uploads (repo_mode=%)', p_assignment_id, v_repo_mode;
  end if;

  -- Must be an active student in this class.
  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_user_id
      and ur.class_id = v_class_id
      and ur.role = 'student'
      and ur.disabled = false
  ) then
    raise exception 'User is not an active student in class %', v_class_id;
  end if;

  if v_release is null or v_release > now() then
    raise exception 'Assignment % is not yet released', p_assignment_id;
  end if;

  -- Resolve profile / group. Mode-4 doesn't have any group-config restrictions:
  -- if the student is in a group for this assignment we use it, otherwise we
  -- attach the submission to their private profile.
  select ur.private_profile_id into v_profile_id
    from public.user_roles ur
   where ur.user_id = v_user_id and ur.class_id = v_class_id and ur.role = 'student' and ur.disabled = false
   limit 1;

  select agm.assignment_group_id into v_assignment_group_id
    from public.assignment_groups_members agm
    join public.assignment_groups ag on ag.id = agm.assignment_group_id
   where ag.assignment_id = p_assignment_id and agm.profile_id = v_profile_id
   limit 1;

  -- Deactivate any prior active submission for this profile/group on this assignment.
  update public.submissions
     set is_active = false
   where assignment_id = p_assignment_id
     and is_active = true
     and (
       (v_assignment_group_id is not null and assignment_group_id = v_assignment_group_id)
       or (v_assignment_group_id is null and profile_id = v_profile_id)
     );

  -- Next ordinal / run_number for this profile/group on this assignment.
  select coalesce(max(ordinal), 0) + 1 into v_ordinal
    from public.submissions
   where assignment_id = p_assignment_id
     and (
       (v_assignment_group_id is not null and assignment_group_id = v_assignment_group_id)
       or (v_assignment_group_id is null and profile_id = v_profile_id)
     );
  v_run_number := v_ordinal;  -- uploads have no GitHub workflow run, so reuse ordinal.

  insert into public.submissions(
    assignment_id, class_id, profile_id, assignment_group_id,
    repository, sha, run_attempt, run_number, ordinal, is_active, submitted_via
  ) values (
    p_assignment_id, v_class_id, v_profile_id, v_assignment_group_id,
    null, null, 1, v_run_number, v_ordinal, true, 'upload'
  )
  returning id into v_submission_id;

  if p_files is not null and jsonb_array_length(p_files) > 0 then
    for v_file in select * from jsonb_array_elements(p_files) loop
      insert into public.submission_files(
        class_id, submission_id, profile_id, assignment_group_id,
        name, contents, is_binary, file_size, mime_type, storage_key
      ) values (
        v_class_id,
        v_submission_id,
        v_profile_id,
        v_assignment_group_id,
        v_file->>'name',
        null,
        true,
        coalesce((v_file->>'file_size')::bigint, 0),
        v_file->>'mime_type',
        v_file->>'storage_key'
      );
    end loop;
  end if;

  return v_submission_id;
end;
$$;

grant execute on function public.create_no_repo_submission(bigint, jsonb) to authenticated;

-- Instructor-only RPC for repo_mode='no_submission'. Creates a stub submission
-- row (no files, no repo, no sha) for the target profile or group so the
-- grading flow has a row to attach reviews to. Idempotent in the sense that
-- it returns the existing active submission id if one already exists.
create or replace function public.create_manual_submission(
  p_assignment_id bigint,
  p_profile_id uuid default null,
  p_assignment_group_id bigint default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_class_id bigint;
  v_repo_mode public.assignment_repo_mode;
  v_existing bigint;
  v_submission_id bigint;
  v_ordinal int;
  v_group_assignment_id bigint;
begin
  if v_user_id is null then
    raise exception 'Must be authenticated' using errcode = '42501';
  end if;

  if (p_profile_id is null) = (p_assignment_group_id is null) then
    raise exception 'Exactly one of p_profile_id or p_assignment_group_id must be provided';
  end if;

  select a.class_id, a.repo_mode
    into v_class_id, v_repo_mode
    from public.assignments a
   where a.id = p_assignment_id;

  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;
  if v_repo_mode <> 'no_submission' then
    raise exception 'Assignment % is not in no_submission mode (repo_mode=%)', p_assignment_id, v_repo_mode;
  end if;

  if not public.authorizeforclassinstructor(v_class_id::bigint) then
    raise exception 'Access denied: only instructors can create manual submissions for class %', v_class_id
      using errcode = '42501';
  end if;

  -- If a group id was passed, verify it belongs to this assignment.
  if p_assignment_group_id is not null then
    select ag.assignment_id into v_group_assignment_id
      from public.assignment_groups ag
     where ag.id = p_assignment_group_id;
    if v_group_assignment_id is null then
      raise exception 'Assignment group % not found', p_assignment_group_id;
    end if;
    if v_group_assignment_id <> p_assignment_id then
      raise exception 'Assignment group % belongs to assignment %, not %',
        p_assignment_group_id, v_group_assignment_id, p_assignment_id;
    end if;
  end if;

  -- Reuse the existing active submission if one is already in place — keeps
  -- the call idempotent so instructors can re-trigger setup without making
  -- duplicate rows.
  select id into v_existing
    from public.submissions
   where assignment_id = p_assignment_id
     and is_active = true
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     )
   limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  -- Otherwise create one as the new active submission for the target.
  select coalesce(max(ordinal), 0) + 1 into v_ordinal
    from public.submissions
   where assignment_id = p_assignment_id
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     );

  insert into public.submissions(
    assignment_id, class_id, profile_id, assignment_group_id,
    repository, sha, run_attempt, run_number, ordinal, is_active, submitted_via
  ) values (
    p_assignment_id, v_class_id, p_profile_id, p_assignment_group_id,
    null, null, 1, v_ordinal, v_ordinal, true, 'manual'
  )
  returning id into v_submission_id;

  return v_submission_id;
end;
$$;

grant execute on function public.create_manual_submission(bigint, uuid, bigint) to authenticated;
