-- Assertions for the randomized half of scenario 18.
\set ON_ERROR_STOP on

do $$
declare
  v_worst int;
begin
  select coalesce(max(c), 0) into v_worst from (
    select count(*) c from public.async_worker_slots
     where holder is not null
     group by queue_name, holder) x;

  perform harness.note('18 renew race', 'most rows any one holder ended up on', v_worst::text);
  perform harness.expect('18 renew race', 'no holder holds more than one row per pool', 'true',
    (v_worst <= 1)::text);
  perform harness.expect('18 renew race', 'no message delivered twice during the race', '0',
    (select count(*)::text from (
       select msg_id from harness.claims where scenario = '18 renew race storm'
        group by msg_id having count(*) > 1) d));
  perform harness.expect('18 renew race', 'global_cap 12 held throughout', 'true',
    (select (coalesce(max(live_after), 0) <= 12)::text from harness.slot_log));
  perform harness.expect('18 renew race', 'no live lease stolen during the race', '0',
    (select count(*)::text from harness.slot_log where stolen));
  perform harness.note('18 renew race', 'messages delivered during the race',
    (select count(*)::text from harness.claims where scenario = '18 renew race storm'));
end $$;
