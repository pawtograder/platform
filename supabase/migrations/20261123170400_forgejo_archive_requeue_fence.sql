-- Fence an in-flight keep decision when a new last-member departure queues cleanup.
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
  ON CONFLICT (repository) WHERE archived_at IS NULL DO UPDATE
  SET claimed_at = NULL
  -- A new departure supersedes a worker's earlier decision to keep the repository.
  -- Invalidate its CAS token while the pending-name uniqueness lock is held. If
  -- completion wins first this inserts a new job; if enqueue wins, completion fails.
  -- Once a destination is committed the job must finish archiving, not be kept.
  WHERE forgejo_repo_archives.archived_as IS NULL
    AND forgejo_repo_archives.claimed_at IS NOT NULL;
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  IF v_queued > 0 THEN
    PERFORM public.kick_forgejo_reconciler();
  END IF;
  RETURN v_queued;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_forgejo_repo_archives(bigint[], text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_forgejo_repo_archives(bigint[], text[]) TO service_role;

