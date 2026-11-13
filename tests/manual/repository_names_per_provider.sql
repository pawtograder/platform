-- Proof harness for 20261112120300_repository_names_per_provider.sql (#1093, merged scope of #1096).
--
-- Makes its own fixtures and ends in ROLLBACK:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/repository_names_per_provider.sql
--
-- Scenarios:
--   1. demo/hw1 can exist once on GitHub and once on Forgejo, but not twice on one provider
--   2. sync and archive skip a name that is only on Forgejo, and run for one that is also on GitHub;
--      they also skip a Forgejo repo under its own owner, which group publish names by the class's GitHub org
--   3. create-repo for a GitHub assignment runs even when Forgejo has a repo with that name;
--      without an assignment it runs for a new name and still skips a Forgejo-only one
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;

create temp table fx(name text primary key, id bigint);
with c as (
  insert into public.classes (name, slug, features, github_org)
  values ('names', 'names-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]', 'names-org')
  returning id
)
insert into fx select 'class', id from c;
create or replace function pg_temp.cls() returns bigint language sql as $$ select id from fx where name = 'class' $$;

-- Future release dates, so inserting them doesn't start GitHub repo creation.
create or replace function pg_temp.assignment(p_slug text, p_provider text) returns bigint language sql as $$
  with s as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls()) returning id)
  insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, git_provider, self_review_setting_id)
  select pg_temp.cls(), p_slug, p_slug, now() + interval '14 days', now() + interval '7 days', 'individual', p_provider, s.id
  from s returning id
$$;
insert into fx values ('gh', pg_temp.assignment('gh-hw1', 'github')), ('fj', pg_temp.assignment('fj-hw1', 'forgejo'));

-- A repository's profile has to be an enrolled student's private profile.
create temp table fx_p(name text primary key, id uuid, pub uuid, user_id uuid);
insert into fx_p select n, gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from unnest(array['a', 'b', 'c']) n;
insert into auth.users (id, email, aud, role)
select user_id, name || '-' || left(user_id::text, 8) || '@names.test', 'authenticated', 'authenticated' from fx_p;
insert into public.profiles (id, class_id, is_private_profile, name)
select id, pg_temp.cls(), true, name from fx_p union all select pub, pg_temp.cls(), false, name || ' (public)' from fx_p;
insert into public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
select user_id, pg_temp.cls(), 'student', id, pub from fx_p;
create or replace function pg_temp.p(n text) returns uuid language sql as $$ select id from fx_p where name = n $$;
create or replace function pg_temp.a(n text) returns bigint language sql as $$ select id from fx where name = n $$;

-- 1
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider)
values (pg_temp.a('fj'), pg_temp.cls(), pg_temp.p('a'), 'demo/hw1', 'forgejo');
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider)
values (pg_temp.a('gh'), pg_temp.cls(), pg_temp.p('a'), 'demo/hw1', 'github');
select pg_temp.check('1a demo/hw1 exists on both providers',
  (select count(*) from public.repositories where repository = 'demo/hw1' and class_id = pg_temp.cls()) = 2);
do $$
begin
  insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider)
  values (pg_temp.a('gh'), pg_temp.cls(), pg_temp.p('b'), 'demo/hw1', 'github');
  perform pg_temp.check('1b a second GitHub demo/hw1 is refused', false, 'insert succeeded');
exception when unique_violation then
  perform pg_temp.check('1b a second GitHub demo/hw1 is refused', true);
end $$;

-- 2
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider)
values (pg_temp.a('fj'), pg_temp.cls(), pg_temp.p('b'), 'demo/hw1-only-forgejo', 'forgejo');
select pg_temp.check('2a sync runs for a name that is also on GitHub',
  public.enqueue_github_sync_repo_permissions(pg_temp.cls(), 'demo', 'hw1', 'names', array['alex']) is not null);
select pg_temp.check('2b sync skips a Forgejo-only name',
  public.enqueue_github_sync_repo_permissions(pg_temp.cls(), 'demo', 'hw1-only-forgejo', 'names', array['alex']) is null);
select pg_temp.check('2c archive runs for a name that is also on GitHub',
  public.enqueue_github_archive_repo(pg_temp.cls(), 'demo', 'hw1') is not null);
select pg_temp.check('2d archive skips a Forgejo-only name',
  public.enqueue_github_archive_repo(pg_temp.cls(), 'demo', 'hw1-only-forgejo') is null);
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider)
values (pg_temp.a('fj'), pg_temp.cls(), pg_temp.p('c'), 'fj-owner/hw1-group-team', 'forgejo');
select pg_temp.check('2e sync skips a Forgejo repo named with the class''s GitHub org',
  public.enqueue_github_sync_repo_permissions(pg_temp.cls(), 'names-org', 'hw1-group-team', 'names', '{}') is null);
select pg_temp.check('2f archive skips it too',
  public.enqueue_github_archive_repo(pg_temp.cls(), 'names-org', 'hw1-group-team') is null);

-- 3
select pg_temp.check('3a create-repo for a GitHub assignment runs despite a Forgejo repo with the same name',
  public.enqueue_github_create_repo(pg_temp.cls(), 'demo', 'hw1-only-forgejo', 'staff/handout', 'names', array['casey'],
    false, null, pg_temp.a('gh'), pg_temp.p('c')) is not null);
select pg_temp.check('3b and it records the GitHub repo beside the Forgejo one',
  (select array_agg(git_provider order by git_provider) from public.repositories
   where repository = 'demo/hw1-only-forgejo' and class_id = pg_temp.cls()) = array['forgejo', 'github']);
select pg_temp.check('3c without an assignment, create-repo runs for a name no host has',
  public.enqueue_github_create_repo(pg_temp.cls(), 'demo', 'hw2-x', 'staff/handout', 'names', array['casey']) is not null);
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider)
values (pg_temp.a('fj'), pg_temp.cls(), pg_temp.p('c'), 'demo/fj-staff', 'forgejo');
select pg_temp.check('3d create-repo with no assignment skips a name only Forgejo has',
  public.enqueue_github_create_repo(pg_temp.cls(), 'demo', 'fj-staff', 'staff/handout', 'names', array['casey']) is null);

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'repository_names_per_provider checks failed'; end if; end $$;

rollback;
