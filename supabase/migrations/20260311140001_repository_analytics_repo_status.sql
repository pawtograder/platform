-- Per-repository fetch tracking for incremental analytics fetching
ALTER TYPE public.github_async_method ADD VALUE IF NOT EXISTS 'fetch_repo_analytics';

create table if not exists "public"."repository_analytics_repo_status" (
    "repository_id" bigint not null,
    "last_fetched_at" timestamp with time zone,
    "last_commit_sha" text,
    constraint repository_analytics_repo_status_pkey primary key (repository_id),
    constraint repository_analytics_repo_status_repository_id_fkey foreign key (repository_id) references repositories(id) on delete cascade
);

create index if not exists idx_repo_analytics_repo_status_last_fetched
    on repository_analytics_repo_status(last_fetched_at);

alter table "public"."repository_analytics_repo_status" enable row level security;

-- Instructors and graders can read via class join (worker uses service role)
create policy "Instructors and graders can read repo status"
    on "public"."repository_analytics_repo_status"
    for select
    using (
        exists (
            select 1 from repositories r
            where r.id = repository_analytics_repo_status.repository_id
            and (public.authorizeforclassgrader(r.class_id) or public.authorizeforclassinstructor(r.class_id))
        )
    );

-- Service role manages via worker
create policy "Service role can manage repo status"
    on "public"."repository_analytics_repo_status"
    for all
    to service_role
    using (true)
    with check (true);
