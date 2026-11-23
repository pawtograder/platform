-- Proof harness for 20261122160000_forgejo_repo_archives.sql (#1378).
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
--      live Forgejo repo with the same owner/name; a caller passing p_git_provider => 'github' still
--      archives the GitHub repo after deleting its row (20261122160100_github_archive_repo_host.sql)
--   3. a name already pending isn't queued twice
--   4. forgejo_repo_archives_due lists pending entries; claim_forgejo_repo_archive claims once and returns
--      the claim, a live claim hides the entry, and immediate deletion can't claim a recorded destination
--   5. last-member departure is atomic with disabling the repo and queueing the archive
--   6. individual cleanup preserves ungrouped Forgejo repositories and reports how many stayed
--   7. assignment deletion queues only a handout in the course's Forgejo org
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
update k set v = pg_temp.github_jobs(pg_temp.cls());
select pg_temp.check('2e ... and with the host passed, the deleted GitHub repo is still archived on GitHub',
  public.enqueue_github_archive_repo(pg_temp.cls(), 'arc-org', 'shared-' || (select s from fx_run), 'test',
                                     p_git_provider => 'github') is not null
  and pg_temp.github_jobs(pg_temp.cls()) = (select v from k) + 1
  and pg_temp.pending(pg_temp.n('shared')) = 0);
select pg_temp.check('2f a Forgejo host queues no GitHub job',
  public.enqueue_github_archive_repo(pg_temp.cls(), 'arc-gh', 'hw2-group-g5-' || (select s from fx_run), 'test',
                                     p_git_provider => 'forgejo') is null
  and pg_temp.github_jobs(pg_temp.cls()) = (select v from k) + 1);

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
update public.forgejo_repo_archives set archived_as = 'archived-g1' where id = (select id from ids);
select pg_temp.check('4e immediate deletion cannot claim a stale entry with a destination',
  public.claim_forgejo_repo_archive((select id from ids), 10, true) is null);
select pg_temp.check('4f the reconciler can reclaim an entry with a destination',
  public.claim_forgejo_repo_archive((select id from ids), 10) is not null);
update public.forgejo_repo_archives set archived_at = now() where id = (select id from ids);
select pg_temp.check('4g an archived entry can''t be claimed', public.claim_forgejo_repo_archive((select id from ids), 10) is null);
select pg_temp.check('4h once archived, the name can be queued again',
  public.queue_forgejo_repo_archives(array[pg_temp.cls()], array[pg_temp.n('Hw1-Group-G1')]) = 1);

-- 5
select pg_temp.add_repo('g7', pg_temp.n('last-member'), 'forgejo');
create temp table fx_members(name text primary key, user_id uuid, priv uuid, pub uuid);
insert into fx_members select n, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
from unnest(array['first', 'last', 'staff']) n;
insert into auth.users (id, email, aud, role)
select user_id, user_id || '@archives.test', 'authenticated', 'authenticated' from fx_members;
insert into public.profiles (id, class_id, is_private_profile, name)
select priv, pg_temp.cls(), true, name from fx_members
union all
select pub, pg_temp.cls(), false, name from fx_members;
insert into public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
select user_id, pg_temp.cls(),
       (case when name = 'staff' then 'instructor' else 'student' end)::public.app_role, priv, pub
from fx_members;
insert into public.assignment_groups_members (assignment_group_id, assignment_id, class_id, profile_id, added_by)
select pg_temp.g('g7'), pg_temp.a(), pg_temp.cls(), priv, priv from fx_members where name <> 'staff';
-- Simulate the reconciler having granted both new members access.
update public.repositories set is_github_ready = true where repository = pg_temp.n('last-member');

create function pg_temp.member_id(p_name text) returns bigint language sql as $$
  select m.id from public.assignment_groups_members m
  join fx_members f on f.priv = m.profile_id
  where m.assignment_group_id = pg_temp.g('g7') and f.name = p_name
$$;
select pg_temp.check('5a a non-final departure succeeds',
  public.leave_forgejo_assignment_group(pg_temp.member_id('first')));
select pg_temp.check('5b the repo stays ready while a member remains',
  pg_temp.pending(pg_temp.n('last-member')) = 0 and
  (select is_github_ready from public.repositories where repository = pg_temp.n('last-member')));

create function pg_temp.fail_archive() returns trigger language plpgsql as $$
begin
  if new.repository = pg_temp.n('last-member') then
    raise check_violation using message = 'simulated queue failure';
  end if;
  return new;
end
$$;
create trigger fail_archive before insert on public.forgejo_repo_archives
for each row execute function pg_temp.fail_archive();
do $$
begin
  perform public.leave_forgejo_assignment_group(pg_temp.member_id('last'));
  perform pg_temp.check('5c a failed queue rolls back the departure', false);
exception when check_violation then
  perform pg_temp.check('5c a failed queue rolls back the departure',
    sqlerrm = 'simulated queue failure' and pg_temp.member_id('last') is not null and
    (select is_github_ready from public.repositories where repository = pg_temp.n('last-member')) and
    pg_temp.pending(pg_temp.n('last-member')) = 0);
end
$$;
drop trigger fail_archive on public.forgejo_repo_archives;
select pg_temp.check('5d a retry of the final departure succeeds',
  public.leave_forgejo_assignment_group(pg_temp.member_id('last')));
select pg_temp.check('5e the final departure removes membership, disables the repo, and queues one archive',
  pg_temp.member_id('last') is null and pg_temp.pending(pg_temp.n('last-member')) = 1 and
  (select not is_github_ready from public.repositories where repository = pg_temp.n('last-member')));

-- 6: Forgejo-only courses work with both null and empty GitHub orgs.
update public.classes set github_org = null where id = pg_temp.cls();
update public.assignments set group_config = 'both' where id = pg_temp.a();
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider, is_github_ready)
select pg_temp.a(), pg_temp.cls(), priv, pg_temp.n('individual-' || name), 'forgejo', true
from fx_members where name in ('first', 'last');
select set_config('request.jwt.claim.sub', (select user_id::text from fx_members where name = 'staff'), true);
create temp table cleanup_only_kept as select public.cleanup_individual_repositories_for_assignment(
  pg_temp.cls(), pg_temp.a()
) as result;
select pg_temp.check('6a an all-preserved cleanup reports what it kept',
  (select result->>'message' like 'Kept 2 Forgejo repositories%' and
          (result#>>'{summary,skipped_not_in_group}')::int = 2 and
          (result#>>'{summary,repositories_deleted}')::int = 0 from cleanup_only_kept));

insert into public.assignment_groups_members (assignment_group_id, assignment_id, class_id, profile_id, added_by)
select pg_temp.g('g7'), pg_temp.a(), pg_temp.cls(), priv, priv from fx_members where name = 'last';
update public.classes set github_org = '' where id = pg_temp.cls();
create temp table cleanup_mixed as select public.cleanup_individual_repositories_for_assignment(
  pg_temp.cls(), pg_temp.a()
) as result;
select pg_temp.check('6b cleanup archives the grouped student''s repo and keeps the ungrouped student''s',
  (select (result#>>'{summary,skipped_not_in_group}')::int = 1 and
          (result#>>'{summary,repositories_deleted}')::int = 1 from cleanup_mixed) and
  pg_temp.pending(pg_temp.n('individual-last')) = 1 and
  pg_temp.pending(pg_temp.n('individual-first')) = 0 and
  exists (select 1 from public.repositories where repository = pg_temp.n('individual-first')));

-- GitHub targets still require an organization (and failed cleanup retains the repo).
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider, is_github_ready)
select pg_temp.gh(), pg_temp.cls(), priv, pg_temp.gn('guard'), 'github', true
from fx_members where name = 'first';
do $$
declare org text;
begin
  foreach org in array array[null::text, ''] loop
    update public.classes set github_org = org where id = pg_temp.cls();
    begin
      perform public.cleanup_individual_repositories_for_assignment(pg_temp.cls(), pg_temp.gh());
      perform pg_temp.check('6c GitHub cleanup rejects missing org', false);
    exception when raise_exception then
      perform pg_temp.check('6c GitHub cleanup rejects missing org',
        sqlerrm = 'Course has no GitHub organization configured' and
        exists (select 1 from public.repositories where repository = pg_temp.gn('guard')));
    end;
  end loop;
end
$$;
update public.classes set github_org = 'arc-gh' where id = pg_temp.cls();

-- 7
-- Check an existing wrong-org value at deletion so updates are not a prerequisite for the guard.
update public.assignments set template_repo = ' Other-Org/Handout ' where id = pg_temp.a();
do $$
begin
  perform public.delete_assignment_with_all_data(pg_temp.a(), pg_temp.cls());
  perform pg_temp.check('7a assignment deletion rejects a handout in another org', false);
exception when check_violation then
  perform pg_temp.check('7a assignment deletion rejects a handout in another org',
    sqlerrm like '%handout must belong%' and pg_temp.a() is not null and
    pg_temp.pending('other-org/handout') = 0 and
    exists (select 1 from public.repositories where repository = pg_temp.n('individual-first')));
end
$$;
update public.assignments set template_repo = ' ' || upper(pg_temp.n('hw1-handout')) || ' ' where id = pg_temp.a();
create temp table assignment_delete as select public.delete_assignment_with_all_data(
  pg_temp.a(), pg_temp.cls()
) as result;
select pg_temp.check('7b assignment deletion returns only normalized Forgejo targets and queues the expected repos',
  (select result->>'success' = 'true' and
          result->'forgejo_repositories' @> jsonb_build_array(
            jsonb_build_object('kind', 'template', 'full_name', pg_temp.n('hw1-handout'))
          ) from assignment_delete) and
  pg_temp.a() is null and pg_temp.pending(pg_temp.n('hw1-handout')) = 1 and
  pg_temp.pending(pg_temp.n('individual-first')) = 1);

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'forgejo_repo_archives checks failed'; end if; end $$;

rollback;
