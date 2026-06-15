-- A/B deployment channels: pin a course to a named web + edge-functions build.
--
-- "stable" (default) is served by the primary release. Any other value routes
-- the course to a same-named host (<channel>.<base-host>) running a canary build
-- of the web app + edge functions, deployed by the Helm chart's `channels` list.
-- All channels share THIS database — so channel code must be schema-compatible
-- with stable (expand/contract migrations only). The web app reads this column in
-- middleware and redirects each course to its channel's host, which lets one user
-- belong to courses on different channels in the same session.
--
-- Additive + backfilled with a default, so existing rows and the stable release
-- are unaffected. Set by admins (Studio/SQL); no in-app UI yet.
alter table public.classes
  add column if not exists deployment_channel text not null default 'stable';

-- deployment_channel is a host-routing key (becomes a DNS label / host), so
-- constrain it to a DNS-1123 label: lowercase alphanumeric + internal hyphens,
-- start/end alphanumeric, <=63 chars. Guarded so re-application is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'classes_deployment_channel_label_chk'
  ) then
    alter table public.classes
      add constraint classes_deployment_channel_label_chk
      check (deployment_channel ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
  end if;
end $$;

comment on column public.classes.deployment_channel is
  'A/B deployment channel serving this course. "stable" = primary release; other values route the course to a same-named host running a canary web + edge-functions build against this shared DB.';
