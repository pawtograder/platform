SELECT pgmq.create('notification_emails');

grant insert on table "pgmq"."a_notification_emails" to "service_role";
grant select on table "pgmq"."a_notification_emails" to "service_role";
grant delete on table "pgmq"."q_notification_emails" to "service_role";
grant insert on table "pgmq"."q_notification_emails" to "service_role";
grant select on table "pgmq"."q_notification_emails" to "service_role";
grant update on table "pgmq"."q_notification_emails" to "service_role";
grant delete on table "pgmq"."a_notification_emails" to "service_role";
grant references on table "pgmq"."a_notification_emails" to "service_role";
grant trigger on table "pgmq"."a_notification_emails" to "service_role";
grant truncate on table "pgmq"."a_notification_emails" to "service_role";
grant update on table "pgmq"."a_notification_emails" to "service_role";
grant delete on table "pgmq"."meta" to "service_role";
grant insert on table "pgmq"."meta" to "service_role";
grant references on table "pgmq"."meta" to "service_role";
grant select on table "pgmq"."meta" to "service_role";
grant trigger on table "pgmq"."meta" to "service_role";
grant truncate on table "pgmq"."meta" to "service_role";
grant update on table "pgmq"."meta" to "service_role";
grant references on table "pgmq"."q_notification_emails" to "service_role";
grant trigger on table "pgmq"."q_notification_emails" to "service_role";
grant truncate on table "pgmq"."q_notification_emails" to "service_role";
alter table "pgmq"."a_notification_emails" enable row level security;
alter table "pgmq"."q_notification_emails" enable row level security;

grant usage, select, update
on all sequences in schema pgmq
to anon, authenticated, service_role;

alter default privileges in schema pgmq
grant usage, select, update
on sequences
to anon, authenticated, service_role;

grant all on function pgmq.pop(text) to "service_role";
grant all on function pgmq.read(text, integer, integer) to "service_role";
grant all on function pgmq.send(text, jsonb, integer) to "service_role";
grant all on function pgmq.send_batch(text, jsonb[], integer) to "service_role";


grant all on function pgmq_public.pop(text) to "service_role";
grant all on function pgmq_public.read(text, integer, integer) to "service_role";
grant all on function pgmq_public.send(text, jsonb, integer) to "service_role";
grant all on function pgmq_public.send_batch(text, jsonb[], integer) to "service_role";

grant all on function pgmq.pop(text) to "service_role";
grant all on function pgmq.read(text, integer, integer) to "service_role";
grant all on function pgmq.send(text, jsonb, integer) to "service_role";
grant all on function pgmq.send_batch(text, jsonb[], integer) to "service_role";


grant all on function pgmq_public.pop(text) to "service_role";
grant all on function pgmq_public.read(text, integer, integer) to "service_role";
grant all on function pgmq_public.send(text, jsonb, integer) to "service_role";
grant all on function pgmq_public.send_batch(text, jsonb[], integer) to "service_role";
