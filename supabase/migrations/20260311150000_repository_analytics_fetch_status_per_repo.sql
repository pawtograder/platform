-- Add repository_id to repository_analytics_fetch_status so status is unique per repository
-- instead of shared across all repos in an assignment.

-- 0. Drop 3-param enqueue function first so it cannot be invoked with old ON CONFLICT (assignment_id)
--    after we change the unique constraint to (assignment_id, repository_id)
drop function if exists public.enqueue_repo_analytics_fetch(bigint, bigint, text);

-- 1. Add repository_id column (nullable for migration)
alter table "public"."repository_analytics_fetch_status"
  add column if not exists "repository_id" bigint;

-- 2. Drop old unique constraint so we can have multiple rows per assignment during backfill
alter table "public"."repository_analytics_fetch_status"
  drop constraint if exists "repository_analytics_fetch_status_unique";

-- 3. Backfill: expand each assignment-level row into one row per repo
insert into "public"."repository_analytics_fetch_status" (
  assignment_id,
  class_id,
  repository_id,
  last_fetched_at,
  last_requested_at,
  status,
  error_message
)
select
  r.assignment_id,
  r.class_id,
  r.id as repository_id,
  f.last_fetched_at,
  f.last_requested_at,
  f.status,
  f.error_message
from "public"."repositories" r
join "public"."repository_analytics_fetch_status" f on f.assignment_id = r.assignment_id and f.repository_id is null
where r.is_github_ready = true;

-- 4. Remove old assignment-only rows (no repository_id)
delete from "public"."repository_analytics_fetch_status"
where repository_id is null;

-- 5. Make repository_id not null
alter table "public"."repository_analytics_fetch_status"
  alter column "repository_id" set not null;

-- 6. Add new unique constraint
alter table "public"."repository_analytics_fetch_status"
  add constraint "repository_analytics_fetch_status_unique" unique (assignment_id, repository_id);

-- 7. Add foreign key
alter table "public"."repository_analytics_fetch_status"
  add constraint "repository_analytics_fetch_status_repository_id_fkey"
  foreign key (repository_id) references repositories(id) on delete cascade;

-- 8. Add index for repository lookups
create index if not exists "idx_repo_analytics_fetch_status_repository"
  on "public"."repository_analytics_fetch_status"(repository_id);

-- 9. Update enqueue RPC to accept optional repository_id and upsert per-repo
-- p_repository_id null = fetch all (cron), no status update here; worker updates on completion
-- p_repository_id non-null = manual refresh for one repo, set last_requested_at for rate limiting
create or replace function public.enqueue_repo_analytics_fetch(
    p_class_id bigint,
    p_assignment_id bigint,
    p_org text,
    p_repository_id bigint default null  -- null = fetch all (cron); non-null = manual refresh for one repo
) returns bigint
language plpgsql
security definer
as $$
declare
    message_id bigint;
    last_req timestamptz;
    v_org text;
begin
    -- Resolve org: use p_org if provided, otherwise derive from class
    v_org := nullif(trim(p_org), '');
    if v_org is null then
        select c.github_org into v_org from public.classes c where c.id = p_class_id;
        v_org := nullif(trim(v_org), '');
    end if;
    if v_org is null then
        raise exception 'Class % has no GitHub org configured; cannot enqueue repo analytics fetch', p_class_id;
    end if;

    -- Enforce caller privileges when called by authenticated user (skip for cron/service role)
    if auth.uid() is not null
        and not (public.authorizeforclassgrader(p_class_id) or public.authorizeforclassinstructor(p_class_id))
    then
        raise exception 'Access denied: insufficient permissions for class %', p_class_id;
    end if;

    -- Validate assignment belongs to class
    if not exists (select 1 from public.assignments where id = p_assignment_id and class_id = p_class_id) then
        raise exception 'Assignment % does not belong to class %', p_assignment_id, p_class_id;
    end if;

    -- Manual refresh only: validate repository and enforce rate limit BEFORE sending
    if p_repository_id is not null then
        -- Verify repository exists and belongs to assignment
        if not exists (
            select 1 from public.repositories r
            where r.id = p_repository_id and r.assignment_id = p_assignment_id
        ) then
            raise exception 'Repository % does not belong to assignment %', p_repository_id, p_assignment_id;
        end if;

        -- Rate limit: 10 minutes between requests for this repo
        select last_requested_at into last_req
        from public.repository_analytics_fetch_status
        where assignment_id = p_assignment_id and repository_id = p_repository_id;

        if last_req is not null and last_req > now() - interval '10 minutes' then
            raise exception 'Rate limited: try again after %', last_req + interval '10 minutes';
        end if;

        -- Upsert fetch status (set last_requested_at for rate limiting)
        insert into public.repository_analytics_fetch_status (
            assignment_id, class_id, repository_id, last_requested_at, status
        )
        select p_assignment_id, p_class_id, p_repository_id, now(), 'fetching'
        from public.repositories r
        where r.id = p_repository_id and r.assignment_id = p_assignment_id
        on conflict (assignment_id, repository_id)
        do update set last_requested_at = now(), status = 'fetching';
    end if;

    -- Enqueue (only reached when repo is valid and not rate-limited, or when p_repository_id is null)
    select pgmq_public.send(
        'async_calls',
        jsonb_build_object(
            'method', 'fetch_repo_analytics',
            'class_id', p_class_id,
            'args', jsonb_build_object(
                'assignment_id', p_assignment_id,
                'org', v_org,
                'repository_id', p_repository_id
            )
        )
    ) into message_id;

    return message_id;
end;
$$;
