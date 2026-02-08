-- Create the missing dead letter queue for the discord async worker.
-- The discord_async_calls queue was created in 20251213194246_calendar_discord.sql,
-- and the DLQ tracking table (discord_async_worker_dlq_messages) was also created there,
-- but the actual pgmq DLQ queue was never created.
--
-- Without this queue, messages that exceed 5 retries can never be archived or dead-lettered,
-- causing an infinite retry storm where the worker re-reads the same failed messages forever.

-- 1. Create the missing DLQ queue
do $$
begin
  perform pgmq.create('discord_async_calls_dlq');
exception when others then
  -- queue likely exists; ignore
  null;
end $$;

-- Grant the required table permissions so service_role can archive/read/write
grant insert on table pgmq.q_discord_async_calls_dlq to service_role;
grant select on table pgmq.q_discord_async_calls_dlq to service_role;
grant delete on table pgmq.q_discord_async_calls_dlq to service_role;
grant update on table pgmq.q_discord_async_calls_dlq to service_role;

grant insert on table pgmq.a_discord_async_calls_dlq to service_role;
grant select on table pgmq.a_discord_async_calls_dlq to service_role;
grant delete on table pgmq.a_discord_async_calls_dlq to service_role;
grant update on table pgmq.a_discord_async_calls_dlq to service_role;

-- 2. Update get_async_queue_sizes() to include discord queue metrics
drop function if exists public.get_async_queue_sizes();

create or replace function public.get_async_queue_sizes()
returns table (
  async_queue_size bigint,
  dlq_queue_size bigint,
  gradebook_row_recalculate_queue_size bigint,
  discord_queue_size bigint,
  discord_dlq_queue_size bigint
)
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  return query
  select
    (select count(*)::bigint from pgmq.q_async_calls where vt <= now()) as async_queue_size,
    (select count(*)::bigint from pgmq.q_async_calls_dlq where vt <= now()) as dlq_queue_size,
    (select count(*)::bigint from pgmq.q_gradebook_row_recalculate where vt <= now()) as gradebook_row_recalculate_queue_size,
    (select count(*)::bigint from pgmq.q_discord_async_calls where vt <= now()) as discord_queue_size,
    (select count(*)::bigint from pgmq.q_discord_async_calls_dlq where vt <= now()) as discord_dlq_queue_size;
end;
$$;

-- Re-apply grants
revoke all on function public.get_async_queue_sizes() from public;
grant execute on function public.get_async_queue_sizes() to service_role;
