# Office Hours Queue Health

What to check when office hours look wrong, and the alert that says so before anyone reports it.

The staff dashboard already shows this per class, behind the `office-hours-queue-health` course
flag: each queue card carries how many requests are waiting, the oldest wait, and an Unstaffed
badge, and instructors get a browser alert when a queue turns red. That only helps while somebody
has the page open. The metric below reports the same condition for every class, whether or not
anyone is looking.

## The signal

`pawtograder_office_hours_queues_red{class_id}` — active queues at or over their class's own
threshold, by either of:

- **waiting**: open requests on the queue, against `waiting_red` (default 5)
- **oldest wait**: age of the oldest open request in minutes, against `oldest_wait_red_minutes`
  (default 30)

Both live in `classes.office_hours_health_thresholds`, which instructors edit in Queue Settings. A
class that deliberately runs a long queue raises its own limit and stops alerting, here and on the
dashboard, without a deploy.

Four more gauges are published for diagnosis, all labelled by `class_id`:

| Gauge                                          | Means                              |
| ---------------------------------------------- | ---------------------------------- |
| `pawtograder_office_hours_queues_active`       | Active queues in the class         |
| `pawtograder_office_hours_queues_unstaffed`    | Active queues with nobody on shift |
| `pawtograder_office_hours_requests_waiting`    | Open requests across those queues  |
| `pawtograder_office_hours_oldest_wait_minutes` | Oldest open request, in minutes    |

## What normal looks like

Outside office hours, `queues_red` is 0 and `queues_unstaffed` equals `queues_active` — nobody is
on shift because there is nothing to staff. That is not an incident.

During a posted session, `queues_unstaffed` should fall as TAs start their shifts, and
`oldest_wait_minutes` should stay under the class's threshold. A `queues_red` that rises and then
falls within a few minutes is a queue absorbing a rush, which is the system working.

The shape worth acting on is `queues_red > 0` **sustained**, especially with
`queues_unstaffed > 0` next to it: students are waiting on a queue nobody is working.

## Checking it by hand

The metric comes from one function, which the scrape calls as `service_role`:

```sql
SELECT * FROM public.metrics_office_hours_queue_health() ORDER BY queues_red DESC;
```

It is `SECURITY DEFINER` and reads every class, so it is revoked from `anon` and `authenticated`
and granted only to `service_role`. Run it as the service role or as the database owner.

To see which queue inside a class is the red one, use the per-class RPC the dashboard uses — it
needs a staff member's JWT for that class:

```sql
SELECT * FROM public.office_hours_queue_health(<class_id>);
```

## Triage

**`queues_red` high for one class, `queues_unstaffed` 0.** The queue is staffed and still behind.
This is a staffing-level problem, not a platform one. Tell the course; there is nothing to fix
here.

**`queues_red` high and `queues_unstaffed` high, during a posted session.** Either nobody started
their shift, or shifts are ending without being noticed. Check
`help_queue_assignments` for the class: rows with `ended_at IS NULL` are the open shifts. If the
course has `office-hours-shift-release` on, a TA's requests return to the queue when their last
shift ends, so a shift that ended by accident shows up as a sudden rise in `requests_waiting`.

**`queues_red` rises across many classes at once.** Not a staffing problem. Look at realtime and
the database before office hours: if help request updates are not reaching clients, students
re-ask and queues inflate. Check `pawtograder_queue_depth` and the circuit breaker gauges first.

**The gauges vanish from the scrape.** `metrics_office_hours_queue_health` is read non-fatally and
a deployment that has not applied `20261119130000` has no such function, so the scrape drops these
gauges and keeps every other metric. Confirm the migration applied before investigating further.

**The gauge and the dashboard disagree.** They should not: both count only active queues, count
waiting as `help_requests.status = 'open'`, and treat a shift as `ended_at IS NULL`. If they
differ, one of the two definitions has drifted — compare
`20261119130000_metrics_office_hours_queue_health.sql` against
`20261117174200_office_hours_queue_health.sql` and fix the metric to match the dashboard, not the
other way round.

## Suggested alert (not shipped)

Not in the chart yet, because what counts as too long is a course's decision and the thresholds
already encode it. If a deployment wants paging:

```yaml
- alert: OfficeHoursQueueRed
  expr: pawtograder_office_hours_queues_red > 0
  for: 15m
  labels: { severity: info }
  annotations:
    summary: "Office hours queue over threshold in class {{ $labels.class_id }}"
    runbook_url: "https://github.com/pawtograder/platform/blob/main/docs/operations/office-hours-queue-health.md"
```

`for: 15m` is the point: a queue that is briefly red is normal, and only a sustained one is worth
anyone's attention. Keep it at `info`. Nobody should be woken up because a class is busy.
