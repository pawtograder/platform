
create or replace function public.enqueue_github_create_repo(
  p_class_id bigint,
  p_org text,
  p_repo_name text,
  p_template_repo text,
  p_course_slug text,
  p_github_usernames text[],
  p_is_template_repo boolean default false,
  p_debug_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id bigint;
  message_id bigint;
begin
  -- Insert log record first
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('create_repo', 0, p_class_id, p_debug_id)
  returning id into log_id;
  
  -- Enqueue message with log_id
  -- PGMQ 1.5: send now returns SETOF bigint instead of bigint
  select * from pgmq.send(
    'async_calls',
    jsonb_build_object(
      'method', 'create_repo',
      'class_id', p_class_id,
      'debug_id', p_debug_id,
      'log_id', log_id,
      'args', jsonb_build_object(
        'org', p_org,
        'repoName', p_repo_name,
        'templateRepo', p_template_repo,
        'isTemplateRepo', p_is_template_repo,
        'courseSlug', p_course_slug,
        'githubUsernames', p_github_usernames
      )
    )
  ) into message_id;
  
  return message_id;
end;
$$;

revoke all on function public.enqueue_github_create_repo(bigint, text, text, text, text, text[], boolean, text) from public;
grant execute on function public.enqueue_github_create_repo(bigint, text, text, text, text, text[], boolean, text) to service_role;


create or replace function public.enqueue_github_sync_student_team(
  p_class_id bigint,
  p_org text,
  p_course_slug text,
  p_affected_user_id uuid default null,
  p_debug_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id bigint;
  message_id bigint;
begin
  -- Insert log record first
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('sync_student_team', 0, p_class_id, p_debug_id)
  returning id into log_id;
  
  return message_id;
end;
$$;

