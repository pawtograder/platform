-- Prerequisites for the per-org async lease harness.
--
-- Everything here is the MINIMUM the migration needs in order to apply and run. It is deliberately
-- not a copy of the real schema: the point of the harness is to exercise
-- 20260912120000_per_org_async_leases.sql verbatim, so anything it does not read should not be here
-- to confuse the picture.
\set ON_ERROR_STOP on

-- The Supabase platform roles. The stock supabase/postgres image already ships anon /
-- authenticated / service_role, but create them if a future image does not, because the migration's
-- REVOKE/GRANT statements name them.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create extension if not exists pgmq;
create schema if not exists pgmq_public;

-- STUB. The production public.classes carries ~20 columns, RLS policies and a pile of foreign keys.
-- The allocator reads exactly two of them, so two is what this has. See the README note in run.sh
-- about what that does and does not prove.
create table if not exists public.classes (
  id bigint primary key,
  github_org text
);

select pgmq.create('async_calls');
-- The worker drains BOTH of these (ASYNC_QUEUE_NAMES in github-async-worker/index.ts). The
-- low-priority one exists in prod from 20260322000001; the harness recreates it so scenario 11 can
-- prove the migration seeds it a pool.
select pgmq.create('async_calls_low_priority');
