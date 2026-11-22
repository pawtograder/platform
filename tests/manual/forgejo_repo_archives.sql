-- Proof harness for 20261121170100_forgejo_repo_archives.sql (#1378).
--
-- Makes its own fixtures and ends in ROLLBACK. Run it in one transaction with the migration if the
-- migration isn't applied yet:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/manual/forgejo_repo_archives.sql
--
-- It needs no Vault secrets or edge functions: kick_forgejo_reconciler() is replaced, inside the rolled-back
-- transaction, by a stub that counts its calls, so the kick checks don't depend on the real dispatch (which
-- needs the Vault entries invoke_forgejo_reconciler_background_task reads, and swallows its own errors).
--
-- Repo names carry a per-run suffix and every archive lookup is scoped to this run's class, so rows other
-- runs or real classes left in forgejo_repo_archives can't change a result.
--
-- Scenarios:
--   1. deleting Forgejo repo rows queues each name once, lowercased, and kicks the reconciler once;
--      deleting a GitHub row queues nothing
--   2. enqueue_github_archive_repo stays GitHub-only: a Forgejo name queues neither a GitHub job nor a
--      Forgejo archive, a GitHub name still queues the GitHub job, and a GitHub delete never queues a
--      live Forgejo repo with the same owner/name
--   3. a name already pending isn't queued twice
--   4. forgejo_repo_archives_due lists pending entries; claim_forgejo_repo_archive claims once and returns
--      the claim, a live claim hides the entry, and an archived entry can't be claimed
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;

create temp table t_kicks(n integer);
insert into t_kicks values (0);
create or replace function public.kick_forgejo_reconciler() returns void
language plpgsql security definer set search_path = public as $$
begin
  update pg_temp.t_kicks set n = n + 1;
end;
$$;
create or replace function pg_temp.kicks() returns integer language sql as $$ select n from pg_temp.t_kicks $$;
create or replace function pg_temp.github_jobs(p_class bigint) returns bigint language sql as $$
  select count(*) from public.api_gateway_calls where class_id = p_class and method = 'archive_repo_and_lock'
$$;

create temp table fx_run(s text);
insert into fx_run values (left(replace(gen_random_uuid()::text, '-', ''), 8));
-- A Forgejo name and a GitHub name for this run.
create or replace function pg_temp.n(p text) returns text language sql as $$
  select 'arc-org/' || p || '-' || (select s from pg_temp.fx_run)
$$;
create or replace function pg_temp.gn(p text) returns text language sql as $$
  select 'arc-gh/' || p || '-' || (select s from pg_temp.fx_run)
$$;

create temp table fx_class(id bigint);
with c as (
  insert into public.classes (name, slug, features, forgejo_org, github_org)
  values ('archives', 'arc-' || (select s from fx_run), '[{"name":"cloud-workspaces","enabled":true}]',
          'arc-org', 'arc-gh')
  returning id
)
insert into fx_class select id from c;
create or replace function pg_temp.cls() returns bigint language sql as $$ select id from fx_class $$;
create or replace function pg_temp.pending(p_repository text) returns bigint language sql as $$
  select count(*) from public.forgejo_repo_archives
  where class_id = pg_temp.cls() and repository = p_repository and archived_at is null
$$;

-- One Forgejo and one GitHub assignment in the same class, so the first delete is a mixed-provider batch.
with s as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls()) returning id)
insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, repo_mode, template_repo,
                                git_provider, self_review_setting_id)
select pg_temp.cls(), 'hw1', 'hw1', now() + interval '7 days', now() - interval '1 hour', 'groups',
       'template_only_staff', pg_temp.n('hw1-handout'), 'forgejo', s.id
from s;
with s as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls()) returning id)
insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, repo_mode, template_repo,
                                git_provider, self_review_setting_id)
select pg_temp.cls(), 'hw2', 'hw2', now() + interval '7 days', now() - interval '1 hour', 'groups',
       'template_only_staff', pg_temp.gn('hw2-handout'), 'github', s.id
from s;
create or replace function pg_temp.a() returns bigint language sql as $$
  select id from public.assignments where class_id = pg_temp.cls() and git_provider = 'forgejo'
$$;
create or replace function pg_temp.gh() returns bigint language sql as $$
  select id from public.assignments where class_id = pg_temp.cls() and git_provider = 'github'
$$;

create temp table fx_g(name text primary key, id bigint);
with g as (
  insert into public.assignment_groups (assignment_id, class_id, name)
  select case when n in ('g3', 'g5', 'g6') then pg_temp.gh() else pg_temp.a() end, pg_temp.cls(), n
  from unnest(array['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']) n
  returning id, name
)
insert into fx_g select name, id from g;
create or replace function pg_temp.g(p text) returns bigint language sql as $$ select id from fx_g where name = p $$;
create or replace function pg_temp.add_repo(p_group text, p_repository text, p_provider text) returns void
language sql as $$
  insert into public.repositories (assignment_id, class_id, assignment_group_id, repository, git_provider, is_github_ready)
  values (case when p_provider = 'github' then pg_temp.gh() else pg_temp.a() end, pg_temp.cls(), pg_temp.g(p_group),
          p_repository, p_provider, true)
$$;
select pg_temp.add_repo('g1', pg_temp.n('Hw1-Group-G1'), 'forgejo');
select pg_temp.add_repo('g2', pg_temp.n('hw1-group-g2'), 'forgejo');
select pg_temp.add_repo('g3', pg_temp.gn('hw2-group-g3'), 'github');
select pg_temp.add_repo('g4', pg_temp.n('hw1-group-g4'), 'forgejo');

-- 1
create temp table k(v bigint);
insert into k values (pg_temp.kicks());
delete from public.repositories
where class_id = pg_temp.cls()
  and repository in (pg_temp.n('Hw1-Group-G1'), pg_temp.n('hw1-group-g2'), pg_temp.gn('hw2-group-g3'));
select pg_temp.check('1a each deleted Forgejo row is queued once, lowercased',
  (select array_agg(repository order by repository) from public.forgejo_repo_archives where class_id = pg_temp.cls())
    = array[lower(pg_temp.n('Hw1-Group-G1')), pg_temp.n('hw1-group-g2')],
  (select string_agg(repository, ', ') from public.forgejo_repo_archives where class_id = pg_temp.cls()));
select pg_temp.check('1b the delete kicks the reconciler once', pg_temp.kicks() = (select v from k) + 1,
  'kicks: ' || (pg_temp.kicks() - (select v from k)));

-- 2
update k set v = pg_temp.github_jobs(pg_temp.cls());
select pg_temp.check('2a a Forgejo name queues no GitHub job',
  public.enqueue_github_archive_repo(pg_temp.cls(), null, pg_temp.n('hw1-group-g4'), 'test') is null
  and pg_temp.github_jobs(pg_temp.cls()) = (select v from k));
select pg_temp.check('2b ... and no Forgejo archive: callers holding a Forgejo row queue it themselves',
  pg_temp.pending(pg_temp.n('hw1-group-g4')) = 0);
select pg_temp.add_repo('g5', pg_temp.gn('hw2-group-g5'), 'github');
select pg_temp.check('2c a GitHub name still queues the GitHub job and no Forgejo archive',
  public.enqueue_github_archive_repo(pg_temp.cls(), 'arc-gh', 'hw2-group-g5-' || (select s from fx_run), 'test') is not null
  and pg_temp.pending(pg_temp.gn('hw2-group-g5')) = 0);
-- The same owner/name on both hosts, as delete_assignment_with_all_data sees it: the GitHub row is deleted, then
-- its archive is enqueued by name while the other assignment's Forgejo row is still live.
select pg_temp.add_repo('g6', pg_temp.n('shared'), 'github');
select pg_temp.add_repo('g7', pg_temp.n('shared'), 'forgejo');
delete from public.repositories where class_id = pg_temp.cls() and repository = pg_temp.n('shared') and git_provider = 'github';
select public.enqueue_github_archive_repo(pg_temp.cls(), 'arc-org', 'shared-' || (select s from fx_run), 'test');
select pg_temp.check('2d a GitHub delete never queues a live Forgejo repo with the same name',
  pg_temp.pending(pg_temp.n('shared')) = 0);

-- 3
select pg_temp.check('3a a name is queued once',
  public.queue_forgejo_repo_archives(array[pg_temp.cls()], array[pg_temp.n('hw1-group-g4')]) = 1);
select pg_temp.check('3b a pending name isn''t queued again, in any case',
  public.queue_forgejo_repo_archives(array[pg_temp.cls()], array[upper(pg_temp.n('hw1-group-g4'))]) = 0
  and pg_temp.pending(pg_temp.n('hw1-group-g4')) = 1);

-- 4
create temp table due as select * from public.forgejo_repo_archives_due(10, NULL) where class_id = pg_temp.cls();
select pg_temp.check('4a every pending entry is due', (select count(*) from due) = 3, (select count(*) from due)::text);
create temp table ids as
  select id from public.forgejo_repo_archives
  where class_id = pg_temp.cls() and repository = lower(pg_temp.n('Hw1-Group-G1'));
create temp table claims(first timestamptz, second timestamptz);
insert into claims
  select public.claim_forgejo_repo_archive((select id from ids), 10), public.claim_forgejo_repo_archive((select id from ids), 10);
select pg_temp.check('4b the first claim wins and returns the claimed_at it wrote, the second loses',
  (select first is not null and second is null from claims)
  and (select claimed_at from public.forgejo_repo_archives where id = (select id from ids)) = (select first from claims));
select pg_temp.check('4c a live claim hides the entry',
  not exists (select 1 from public.forgejo_repo_archives_due(10, NULL) where id = (select id from ids)));
update public.forgejo_repo_archives set claimed_at = now() - interval '11 minutes' where id = (select id from ids);
select pg_temp.check('4d a stale claim is due again', exists (select 1 from public.forgejo_repo_archives_due(10, NULL) where id = (select id from ids)));
update public.forgejo_repo_archives set archived_at = now() where id = (select id from ids);
select pg_temp.check('4e an archived entry can''t be claimed', public.claim_forgejo_repo_archive((select id from ids), 10) is null);
select pg_temp.check('4f once archived, the name can be queued again',
  public.queue_forgejo_repo_archives(array[pg_temp.cls()], array[pg_temp.n('Hw1-Group-G1')]) = 1);

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'forgejo_repo_archives checks failed'; end if; end $$;

rollback;
