-- Proof harness for 20261121170100_forgejo_repo_archives.sql (#1378).
--
-- Makes its own fixtures and ends in ROLLBACK. Run it in one transaction with the migration if the
-- migration isn't applied yet:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/manual/forgejo_repo_archives.sql
--
-- Scenarios:
--   1. deleting Forgejo repo rows queues each name once, lowercased, and kicks the reconciler once;
--      deleting a GitHub row queues nothing
--   2. enqueue_github_archive_repo for a Forgejo name queues a Forgejo archive and no GitHub job;
--      for a GitHub name it still queues the GitHub job and no Forgejo archive
--   3. a name already pending isn't queued twice
--   4. forgejo_repo_archives_due lists pending entries; claim_forgejo_repo_archive claims once, a live
--      claim hides the entry, and an archived entry can't be claimed
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.kicks() returns bigint language sql as $$
  select count(*) from net.http_request_queue where url like '%/functions/v1/forgejo-reconciler'
$$;
create or replace function pg_temp.github_jobs(p_class bigint) returns bigint language sql as $$
  select count(*) from public.api_gateway_calls where class_id = p_class and method = 'archive_repo_and_lock'
$$;

create temp table fx_class(id bigint);
with c as (
  insert into public.classes (name, slug, features, forgejo_org, github_org)
  values ('archives', 'arc-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]',
          'arc-org', 'arc-gh')
  returning id
)
insert into fx_class select id from c;
create or replace function pg_temp.cls() returns bigint language sql as $$ select id from fx_class $$;

with s as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls()) returning id)
insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, repo_mode, template_repo,
                                git_provider, self_review_setting_id)
select pg_temp.cls(), 'hw1', 'hw1', now() + interval '7 days', now() - interval '1 hour', 'groups',
       'template_only_staff', 'arc-org/hw1-handout', 'forgejo', s.id
from s;
create or replace function pg_temp.a() returns bigint language sql as $$
  select id from public.assignments where class_id = pg_temp.cls()
$$;

create temp table fx_g(name text primary key, id bigint);
with g as (
  insert into public.assignment_groups (assignment_id, class_id, name)
  select pg_temp.a(), pg_temp.cls(), n from unnest(array['g1', 'g2', 'g3', 'g4']) n
  returning id, name
)
insert into fx_g select name, id from g;
insert into public.repositories (assignment_id, class_id, assignment_group_id, repository, git_provider, is_github_ready)
select pg_temp.a(), pg_temp.cls(), g.id, r.repository, r.provider, true
from (values ('g1', 'arc-org/Hw1-Group-G1', 'forgejo'), ('g2', 'arc-org/hw1-group-g2', 'forgejo'),
             ('g3', 'arc-gh/hw1-group-g3', 'github'), ('g4', 'arc-org/hw1-group-g4', 'forgejo')) r(g, repository, provider)
join fx_g g on g.name = r.g;

-- 1
create temp table k(v bigint);
insert into k values (pg_temp.kicks());
delete from public.repositories where class_id = pg_temp.cls() and repository in ('arc-org/Hw1-Group-G1', 'arc-org/hw1-group-g2', 'arc-gh/hw1-group-g3');
select pg_temp.check('1a each deleted Forgejo row is queued once, lowercased',
  (select array_agg(repository order by repository) from public.forgejo_repo_archives where class_id = pg_temp.cls())
    = array['arc-org/hw1-group-g1', 'arc-org/hw1-group-g2'],
  (select string_agg(repository, ', ') from public.forgejo_repo_archives where class_id = pg_temp.cls()));
select pg_temp.check('1b the delete kicks the reconciler once', pg_temp.kicks() = (select v from k) + 1,
  'kicks: ' || (pg_temp.kicks() - (select v from k)));

-- 2
update k set v = pg_temp.github_jobs(pg_temp.cls());
select pg_temp.check('2a a Forgejo name queues no GitHub job',
  public.enqueue_github_archive_repo(pg_temp.cls(), null, 'arc-org/hw1-group-g4', 'test') is null
  and pg_temp.github_jobs(pg_temp.cls()) = (select v from k));
select pg_temp.check('2b ... and queues a Forgejo archive',
  exists (select 1 from public.forgejo_repo_archives where repository = 'arc-org/hw1-group-g4' and archived_at is null));
insert into public.repositories (assignment_id, class_id, assignment_group_id, repository, git_provider, is_github_ready)
values (pg_temp.a(), pg_temp.cls(), (select id from fx_g where name = 'g3'), 'arc-gh/hw1-group-g5', 'github', true);
select pg_temp.check('2c a GitHub name still queues the GitHub job and no Forgejo archive',
  public.enqueue_github_archive_repo(pg_temp.cls(), 'arc-gh', 'hw1-group-g5', 'test') is not null
  and not exists (select 1 from public.forgejo_repo_archives where repository = 'arc-gh/hw1-group-g5'));

-- 3
select pg_temp.check('3 a pending name isn''t queued again',
  public.queue_forgejo_repo_archives(array[pg_temp.cls()], array['arc-org/HW1-group-g4']) = 0
  and (select count(*) from public.forgejo_repo_archives where repository = 'arc-org/hw1-group-g4') = 1);

-- 4
create temp table due as select * from public.forgejo_repo_archives_due(10, NULL) where class_id = pg_temp.cls();
select pg_temp.check('4a every pending entry is due', (select count(*) from due) = 3);
create temp table ids as select id from public.forgejo_repo_archives where repository = 'arc-org/hw1-group-g1';
select pg_temp.check('4b the first claim wins, the second loses',
  public.claim_forgejo_repo_archive((select id from ids), 10)
  and not public.claim_forgejo_repo_archive((select id from ids), 10));
select pg_temp.check('4c a live claim hides the entry',
  not exists (select 1 from public.forgejo_repo_archives_due(10, NULL) where id = (select id from ids)));
update public.forgejo_repo_archives set claimed_at = now() - interval '11 minutes' where id = (select id from ids);
select pg_temp.check('4d a stale claim is due again', exists (select 1 from public.forgejo_repo_archives_due(10, NULL) where id = (select id from ids)));
update public.forgejo_repo_archives set archived_at = now() where id = (select id from ids);
select pg_temp.check('4e an archived entry can''t be claimed', not public.claim_forgejo_repo_archive((select id from ids), 10));
select pg_temp.check('4f once archived, the name can be queued again',
  public.queue_forgejo_repo_archives(array[pg_temp.cls()], array['arc-org/hw1-group-g1']) = 1);

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'forgejo_repo_archives checks failed'; end if; end $$;

rollback;
