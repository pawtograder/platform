-- CW-12 (#1092): run forgejo-account-reconciler hourly, and right away when someone joins a
-- cloud-workspaces class or a class turns the flag on. The hourly run is what makes this
-- self-healing: it catches a kick that never ran, a pass that failed, and anyone enrolled before
-- this shipped.

create or replace function public.invoke_forgejo_account_reconciler_background_task()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.call_edge_function_internal(
    '/functions/v1/forgejo-account-reconciler',
    'POST',
    '{"Content-type":"application/json","x-supabase-webhook-source":"forgejo-account-reconciler"}'::jsonb,
    '{}'::jsonb,
    5000,
    null, null, null, null, null
  );
end;
$$;

revoke all on function public.invoke_forgejo_account_reconciler_background_task() from public, anon, authenticated;
grant execute on function public.invoke_forgejo_account_reconciler_background_task() to service_role;

-- A kick is only a head start on the hourly run, so it must never fail the write that caused it:
-- call_edge_function_internal raises when its Vault secrets are missing.
create or replace function public.kick_forgejo_account_reconciler()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.invoke_forgejo_account_reconciler_background_task();
exception
  when others then
    raise warning 'forgejo-account-reconciler kick skipped: %', sqlerrm;
end;
$$;

revoke all on function public.kick_forgejo_account_reconciler() from public, anon, authenticated;

-- Statement-level, so a roster import of hundreds of rows kicks once.
create or replace function public.kick_forgejo_account_reconciler_on_enrollment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from new_roles r join public.classes c on c.id = r.class_id
    where not r.disabled and public.cloud_workspaces_enabled(c.features)
  ) then
    perform public.kick_forgejo_account_reconciler();
  end if;
  return null;
end;
$$;

create trigger forgejo_account_reconciler_on_enrollment
  after insert on public.user_roles
  referencing new table as new_roles
  for each statement execute function public.kick_forgejo_account_reconciler_on_enrollment();

create or replace function public.kick_forgejo_account_reconciler_on_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.cloud_workspaces_enabled(new.features) and not public.cloud_workspaces_enabled(old.features) then
    perform public.kick_forgejo_account_reconciler();
  end if;
  return null;
end;
$$;

create trigger forgejo_account_reconciler_on_flag
  after update of features on public.classes
  for each row execute function public.kick_forgejo_account_reconciler_on_flag();

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'forgejo-account-reconciler') then
      perform cron.unschedule('forgejo-account-reconciler');
    end if;
    perform cron.schedule(
      'forgejo-account-reconciler',
      '41 * * * *',
      $$select public.invoke_forgejo_account_reconciler_background_task();$$
    );
    raise notice 'Forgejo account reconciler cron scheduled hourly';
  end if;
exception
  when insufficient_privilege then
    raise notice 'Skipping forgejo-account-reconciler cron schedule: insufficient privilege';
end;
$cron$;
