-- CW-P2b (#1378): archive a Forgejo repo once it no longer belongs to a student or group, as
-- archiveRepoAndLock does on GitHub (remove every collaborator, rename it archived-<timestamp>-<name>).
--
-- Before this, every GitHub archive path skipped Forgejo: the dissolve and cleanup RPCs only call
-- enqueue_github_archive_repo for git_provider = 'github' rows, and that function returned null for a
-- Forgejo name. The students kept write access, and the name stayed taken, so a new group deriving the
-- same name would have adopted the old repo with its old collaborators.
--
-- Deleting a Forgejo row was refused outright until now (repositories_validate_git_provider), which
-- this migration lifts at the end.
--
-- Now two things queue a Forgejo repo in forgejo_repo_archives, which forgejo-reconciler drains at the
-- start of each pass:
--   1. deleting a Forgejo repositories row, by any path (group dissolve, individual repo cleanup,
--      instructor move), through a statement-level trigger;
--   2. enqueue_github_archive_repo called for a Forgejo name (the last member leaving a group keeps the
--      row, so only this catches it). Its GitHub path is unchanged.
-- Rows stay after archiving, with the new name, as a record of where the repo went.

CREATE TABLE IF NOT EXISTS public.forgejo_repo_archives (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- No foreign keys: the class or repository row may be gone, and the repo must still be archived.
  class_id bigint NOT NULL,
  repository text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  archived_at timestamptz,
  archived_as text
);

COMMENT ON TABLE public.forgejo_repo_archives IS
  'Forgejo repos to archive because they no longer belong to a student or group (#1378). Drained by forgejo-reconciler. Written only by the service role and triggers.';

-- One pending entry per name; the reconciler and the repo-creation guard look names up while pending.
CREATE UNIQUE INDEX IF NOT EXISTS forgejo_repo_archives_pending_idx
  ON public.forgejo_repo_archives (repository) WHERE archived_at IS NULL;

ALTER TABLE public.forgejo_repo_archives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.forgejo_repo_archives FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.forgejo_repo_archives TO service_role;

-- Queues each name once, lowercased like every Forgejo name Pawtograder stores, and kicks the reconciler.
CREATE OR REPLACE FUNCTION public.queue_forgejo_repo_archives(p_class_ids bigint[], p_repositories text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_queued integer;
BEGIN
  INSERT INTO public.forgejo_repo_archives (class_id, repository)
  SELECT DISTINCT ON (lower(x.repository)) x.class_id, lower(x.repository)
  FROM unnest(p_class_ids, p_repositories) AS x(class_id, repository)
  WHERE x.repository LIKE '%_/_%'
  ORDER BY lower(x.repository)
  ON CONFLICT (repository) WHERE archived_at IS NULL DO NOTHING;
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  IF v_queued > 0 THEN
    PERFORM public.kick_forgejo_reconciler();
  END IF;
  RETURN v_queued;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_forgejo_repo_archives(bigint[], text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_forgejo_repo_archives(bigint[], text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.queue_forgejo_repo_archives_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.queue_forgejo_repo_archives(
    ARRAY(SELECT o.class_id FROM old_rows o WHERE o.git_provider = 'forgejo' AND o.repository IS NOT NULL ORDER BY o.id),
    ARRAY(SELECT o.repository FROM old_rows o WHERE o.git_provider = 'forgejo' AND o.repository IS NOT NULL ORDER BY o.id)
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_forgejo_repo_archives_on_delete() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS forgejo_repo_archive_on_delete ON public.repositories;
CREATE TRIGGER forgejo_repo_archive_on_delete
  AFTER DELETE ON public.repositories
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.queue_forgejo_repo_archives_on_delete();

-- 20261020150000_assignment_git_provider.sql refused to delete a Forgejo repositories row "until
-- provider-aware cleanup exists", so every path above (dissolve, cleanup, move) failed for a Forgejo
-- row and this trigger never saw one. The trigger above is that cleanup, so the guard now checks
-- inserts and updates only; repositories_validate_git_provider's DELETE branch is no longer reached.
DROP TRIGGER IF EXISTS repositories_validate_git_provider ON public.repositories;
CREATE TRIGGER repositories_validate_git_provider
  BEFORE INSERT OR UPDATE OF git_provider, assignment_id ON public.repositories
  FOR EACH ROW EXECUTE FUNCTION public.repositories_validate_git_provider();

-- From 20261118140100_repository_names_per_provider.sql. A name held only by a Forgejo row now queues a
-- Forgejo archive instead of returning without one; the GitHub path is unchanged. Still returns null for it:
-- no GitHub job was queued.
CREATE OR REPLACE FUNCTION public.enqueue_github_archive_repo( p_class_id bigint, p_org text, p_repo text, p_debug_id text default null
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  log_id bigint; message_id bigint;
  v_full_name text := case when strpos(p_repo, '/') > 0 then p_repo else p_org || '/' || p_repo end;
begin
  -- Match the same owner/name that archiveRepoAndLock will use.
  -- Skip only a name that is on another host and not on GitHub: a name is unique per provider.
  if exists (select 1 from public.repositories where class_id = p_class_id and repository = v_full_name
                and git_provider <> 'github')
     and not exists (select 1 from public.repositories where class_id = p_class_id and repository = v_full_name
                and git_provider = 'github') then
    if exists (select 1 from public.repositories where class_id = p_class_id and repository = v_full_name
                  and git_provider = 'forgejo') then
      perform public.queue_forgejo_repo_archives(array[p_class_id], array[v_full_name]);
    end if;
    return null;
  end if;
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id) values ('archive_repo_and_lock', 0, p_class_id, p_debug_id)
  returning id into log_id;
  select pgmq_public.send('async_calls', jsonb_build_object( 'method', 'archive_repo_and_lock', 'class_id', p_class_id,
      'debug_id', p_debug_id, 'log_id', log_id, 'args', jsonb_build_object('org', p_org, 'repo', p_repo) )) into message_id;
  return message_id;
end;
$$;

-- Pending archives, never-claimed first and then oldest claim, so one that keeps failing can't hold every place.
CREATE OR REPLACE FUNCTION public.forgejo_repo_archives_due(p_stale_minutes integer, p_limit integer)
RETURNS TABLE (id bigint, class_id bigint, repository text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.class_id, a.repository
  FROM public.forgejo_repo_archives a
  WHERE a.archived_at IS NULL
    AND (a.claimed_at IS NULL OR a.claimed_at < now() - make_interval(mins => p_stale_minutes))
  ORDER BY a.claimed_at ASC NULLS FIRST, a.id
  LIMIT p_limit;
$$;

-- The caller's claim on this entry, or null when it's archived or a live pass holds it. The claim is the
-- claimed_at it wrote: every later write to the entry filters on it (and on archived_at IS NULL), so a pass
-- that stalls past p_stale_minutes and loses the entry to another can't overwrite what that one recorded.
DROP FUNCTION IF EXISTS public.claim_forgejo_repo_archive(bigint, integer);
CREATE FUNCTION public.claim_forgejo_repo_archive(p_id bigint, p_stale_minutes integer)
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.forgejo_repo_archives
  SET claimed_at = clock_timestamp()
  WHERE id = p_id
    AND archived_at IS NULL
    AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => p_stale_minutes))
  RETURNING claimed_at;
$$;

REVOKE ALL ON FUNCTION public.forgejo_repo_archives_due(integer, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_forgejo_repo_archive(bigint, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_repo_archives_due(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_forgejo_repo_archive(bigint, integer) TO service_role;
