-- Session R. Holds the row lock on racer's slot across a wall-clock window, which is exactly what
-- an independent renewal timer does for the microseconds it takes to commit. The explicit
-- transaction and the sleep only widen that window so the race is deterministic instead of a
-- coin flip; nothing else about the interleaving is contrived.
\set ON_ERROR_STOP on
begin;
select pgmq_public.renew_org_slot('async_calls', 'racer', 600) as renewed;
select pg_sleep(4);
commit;
