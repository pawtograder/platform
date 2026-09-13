-- Interleaved into the storm body every fourth claim, so slots actually churn between holders
-- instead of the first sixteen sessions renewing their way through the whole run.
select pgmq_public.release_org_slot('async_calls', :'h');
