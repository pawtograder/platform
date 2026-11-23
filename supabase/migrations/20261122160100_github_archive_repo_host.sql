-- enqueue_github_archive_repo takes the repo's host from a caller that knows it.
--
-- 20261118140100_repository_names_per_provider.sql made names unique per provider and kept a by-name
-- guard: skip a name that has a non-GitHub row and no GitHub row. A caller that deletes the GitHub row
-- first (delete_assignment_with_all_data) then hit that guard whenever another assignment in the class
-- had a Forgejo repo with the same owner/name, and the GitHub repo was never archived.
--
-- p_git_provider = 'github' says the caller held a GitHub row (or the GitHub template), so the guard is
-- skipped. Any other provider queues nothing: Forgejo repos are archived through forgejo_repo_archives.
-- NULL keeps the by-name guard for callers that don't know the host. The body is otherwise unchanged.

DROP FUNCTION IF EXISTS public.enqueue_github_archive_repo(bigint, text, text, text);

CREATE FUNCTION public.enqueue_github_archive_repo(p_class_id bigint, p_org text, p_repo text,
  p_debug_id text DEFAULT NULL, p_git_provider text DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  log_id bigint; message_id bigint;
  v_full_name text := case when strpos(p_repo, '/') > 0 then p_repo else p_org || '/' || p_repo end;
begin
  if p_git_provider is not null and p_git_provider <> 'github' then
    return null;
  end if;
  -- Match the same owner/name that archiveRepoAndLock will use.
  -- Without a host, skip only a name that is on another host and not on GitHub.
  if p_git_provider is null
     and exists (select 1 from public.repositories where class_id = p_class_id and repository = v_full_name
                and git_provider <> 'github')
     and not exists (select 1 from public.repositories where class_id = p_class_id and repository = v_full_name
                and git_provider = 'github') then
    return null;
  end if;
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id) values ('archive_repo_and_lock', 0, p_class_id, p_debug_id)
  returning id into log_id;
  select pgmq_public.send('async_calls', jsonb_build_object( 'method', 'archive_repo_and_lock', 'class_id', p_class_id,
      'debug_id', p_debug_id, 'log_id', log_id, 'args', jsonb_build_object('org', p_org, 'repo', p_repo) )) into message_id;
  return message_id;
end;
$$;

REVOKE ALL ON FUNCTION public.enqueue_github_archive_repo(bigint, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_archive_repo(bigint, text, text, text, text) TO service_role;
