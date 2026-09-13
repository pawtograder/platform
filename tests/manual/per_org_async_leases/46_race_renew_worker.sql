-- RENEW half. Runs under the same holder string as a 44_race_worker.sql session and does nothing
-- but renew, as fast as it can, so its row lock keeps landing on top of that holder's claims. This
-- is the heartbeat timer from the worker's point of view, with the sleep removed.
select pgmq_public.renew_org_slot('async_calls', :'h', 30);
