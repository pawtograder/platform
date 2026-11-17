-- Proof harness for 20261112120100_forgejo_reconciler.sql (#1092).
--
-- Needs the Vault secrets call_edge_function_internal reads (a local Supabase has them), and makes
-- its own fixtures. A kick shows up as a pg_net request to forgejo-reconciler, queued inside
-- this transaction. It all ends in ROLLBACK, so nothing is sent:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/forgejo_reconciler.sql
--
-- Scenarios:
--   1. enrolling in a class without cloud-workspaces          -> no kick
--   2. enrolling three people in a flagged class in one INSERT -> exactly one kick
--   3. a disabled-only enrollment in a flagged class           -> no kick
--   4. turning the flag on                                     -> one kick; saving features again while on -> none
--   5. Vault secret missing                                    -> the enrollment still succeeds, no kick
--   6. the hourly schedule exists
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;

create or replace function pg_temp.kicks() returns bigint language sql as $$
  select count(*) from net.http_request_queue where url like '%/functions/v1/forgejo-reconciler'
$$;

create temp table fx(name text primary key, id uuid);
insert into fx select 'u' || g, gen_random_uuid() from generate_series(1, 6) g;
insert into auth.users (id, email, aud, role)
select id, name || '-' || left(id::text, 8) || '@kick.test', 'authenticated', 'authenticated' from fx;

create temp table fx_class(name text primary key, id bigint);
with c as (
  insert into public.classes (name, slug, features)
  values ('flagged', 'kick-flagged-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]'),
         ('plain', 'kick-plain-' || left(gen_random_uuid()::text, 8), '[]')
  returning id, name
)
insert into fx_class select name, id from c;

-- Profiles for every (user, class) pair, so enrollments can be inserted in one statement.
create temp table fx_profiles as
select fx.name as user_name, fx.id as user_id, c.name as class_name, c.id as class_id,
       gen_random_uuid() as priv, gen_random_uuid() as pub
from fx cross join fx_class c;
insert into public.profiles (id, class_id, is_private_profile, name)
select priv, class_id, true, user_name from fx_profiles
union all select pub, class_id, false, user_name || ' (public)' from fx_profiles;

create or replace function pg_temp.enroll(p_users text[], p_class text, p_disabled boolean default false) returns void
language sql as $$
  insert into public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id, disabled)
  select user_id, class_id, 'student', priv, pub, p_disabled from fx_profiles
  where user_name = any(p_users) and class_name = p_class
$$;

-- 1
create temp table k(v bigint); insert into k select pg_temp.kicks();
select pg_temp.enroll(array['u1'], 'plain');
select pg_temp.check('1 enrolling in a class without the flag does not kick', pg_temp.kicks() = (select v from k));

-- 2
update k set v = pg_temp.kicks();
select pg_temp.enroll(array['u2', 'u3', 'u4'], 'flagged');
select pg_temp.check('2 three enrollments in one INSERT kick once', pg_temp.kicks() = (select v from k) + 1,
  'kicks: ' || (pg_temp.kicks() - (select v from k)));

-- 3
update k set v = pg_temp.kicks();
select pg_temp.enroll(array['u5'], 'flagged', true);
select pg_temp.check('3 a disabled-only enrollment does not kick', pg_temp.kicks() = (select v from k));

-- 4
update k set v = pg_temp.kicks();
update public.classes set features = '[{"name":"cloud-workspaces","enabled":true}]' where id = (select id from fx_class where name = 'plain');
select pg_temp.check('4a turning the flag on kicks', pg_temp.kicks() = (select v from k) + 1);
update k set v = pg_temp.kicks();
update public.classes set features = '[{"name":"cloud-workspaces","enabled":true},{"name":"other","enabled":true}]'
where id = (select id from fx_class where name = 'plain');
select pg_temp.check('4b saving features while already on does not kick', pg_temp.kicks() = (select v from k));

-- 5
update k set v = pg_temp.kicks();
delete from vault.secrets where name = 'edge-function-secret';
select pg_temp.enroll(array['u6'], 'flagged');
select pg_temp.check('5a the enrollment still succeeds without the Vault secret',
  exists (select 1 from public.user_roles where user_id = (select id from fx where name = 'u6')));
select pg_temp.check('5b and no kick is queued', pg_temp.kicks() = (select v from k));

-- 6
select pg_temp.check('6 hourly schedule exists',
  exists (select 1 from cron.job where jobname = 'forgejo-reconciler' and schedule = '41 * * * *'));

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'forgejo_reconciler checks failed'; end if; end $$;

rollback;
