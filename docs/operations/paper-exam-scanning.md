# Paper Exam Scanning

What to check when a paper exam batch looks stuck, and how to tell a batch that is working slowly
from one that has failed.

Paper exams are off by default. A course turns them on with the `exams` course flag ("Paper exams"
under Course Settings > Feature flags). The flag gates the pages themselves, not just the nav:
`ExamFeatureGate` renders a notice for a pasted URL, so a course that never opted in cannot enqueue
worker jobs or spend the shared Gemini budget. Turning the flag off is the rollback for anything in
this document. It stops new work immediately. It does not cancel work already queued, which drains
on its own.

Scanning is asynchronous. Staff upload a PDF, press Process, and everything after that happens in
the `exam-async-worker` edge function reading a PGMQ queue. Nothing about that is visible in the
browser except the batch's status, so almost every question in this document is answered by one of
two things: the batch row, or the worker's logs.

## The signal

**There are no Prometheus gauges for exams.** This is the honest difference between this playbook
and [Office Hours Queue Health](./office-hours-queue-health.md), which can point at
`pawtograder_office_hours_queues_red` and be done. Nothing scrapes exam state, so there is no alert
that fires before a human notices. See [What we do not have](#what-we-do-not-have) at the end.

What exists instead:

**The batch status**, on `exam_scan_batches.status`, one of `uploaded`, `ocr`, `matching`, `review`,
`finalizing`, `completed`, `error`. This is the primary signal and it is the one staff see. A batch
that failed carries the reason in `exam_scan_batches.error`, written by `setBatchError` before the
message is dead-lettered, so the Scans page shows staff what went wrong without anyone reading a
log.

**The worker's log lines**, all prefixed `[exam-async-worker]`, added by #1321:

| Line                                                 | Means                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `run start`                                          | An invocation began                                                                   |
| `pass N: read M message(s)`                          | What one queue read returned. Not queue depth                                         |
| `handling <method> msg_id=.. batch=.. read_ct=..`    | Printed before the handler, so a message that kills the isolate still leaves its name |
| `retry N for <method> (batch B) in Ds: <error>`      | A transient failure requeued. **Not** an incident on its own                          |
| `rate-limit retry N for <method> (batch B) in Ds`    | The provider asked us to slow down                                                    |
| `run done: N message(s) attempted, F failed, in Xms` | An invocation finished                                                                |

`read_ct` is the one to watch. A climbing `read_ct` on the same `msg_id` is the shape of a poison
pill, and at 8 (`PGMQ_MAX_READ_CT`) the worker gives up on it.

**Sentry**, where every event carries `function=exam-async-worker` plus `exam_method` and
`batch_id`, and, since #1293, an `attempt` tag saying which try gave up. Only give-ups are reported.
A transient failure that recovers on retry raises no event by design, because a 200-student finalize
makes roughly 1800 provider calls and capturing every recovery buried the failures that mattered.
If you want the retry rate, read the `retry` log lines, not Sentry.

## What normal looks like

A batch moves `uploaded` to `ocr` to `matching` to `review`, waits there for a human to confirm the
student matches, then goes `finalizing` to `completed`. **`review` is not a stall.** It is the
system waiting for staff, and a batch can sit there for days legitimately.

Retries are normal. The worker requeues a transient failure with exponential backoff,
`min(300, 10 * 2^n)` seconds, up to 5 attempts. A handful of `retry 1 for ...` lines in a run is the
backoff working. What is not normal is the same `batch=` appearing at `retry 4` and `retry 5`.

Slow is normal too, and worth calibrating before declaring an incident. On staging on 2026-11-11,
with the real provider, Process took about **2.5 seconds per page** and finalize about **7.5 seconds
per submission**. For a 200-student, 4-page exam that is roughly **35 minutes for Process alone**. A
batch that has been in `ocr` for twenty minutes is probably fine. One that has been there for three
hours is not.

The worker reads 5 messages at a time for up to 50 passes per invocation, with a 120 second
visibility timeout. A message whose worker is killed mid-flight is never archived, so it reappears
after 120 seconds and the next invocation picks it up. **Nothing is lost when the worker dies.** It
just gets slower.

## Checking it by hand

Every batch not in a terminal state, oldest first:

```sql
select b.id, b.class_id, b.exam_id, b.status, b.total_pages, b.pages_per_exam,
       b.error, b.created_at, now() - b.created_at as age
from public.exam_scan_batches b
where b.status not in ('completed', 'review')
order by b.created_at;
```

`review` is excluded deliberately: it is waiting for a human, not for us. Add it back when you want
the whole picture.

How far one batch's pages have got:

```sql
select p.batch_id,
       count(*) as pages,
       count(p.ocr_data) as ocr_done,
       count(*) filter (where p.ocr_data is null) as ocr_pending
from public.exam_scan_pages p
where p.batch_id = :batch_id
group by p.batch_id;
```

Match state for a batch, which is what `review` is waiting on, and how much of finalize has
actually completed:

```sql
select match_status,
       count(*) as scanned,
       count(submission_id) as submissions,
       count(finalized_at) as finalized
from public.exam_scanned_submissions
where batch_id = :batch_id
group by match_status;
```

`unmatched` and `suggested` need a human. `confirmed` and `skipped` are done. `finalized_at` is the
single completion marker, set transactionally once the submission, its page files and the exam
artifact are all written, so `submissions > finalized` means a finalize started and did not finish.
Those are exactly the rows `enqueue_exam_finalize` re-enqueues, so they generally recover on their
own.

**Start every give-up investigation here**, because dead-lettered messages are kept in a normal
table rather than only in the queue:

```sql
select created_at, method, error_type, error_message, retry_count,
       envelope->>'batch_id' as batch_id, debug_id
from public.exam_async_worker_dlq_messages
order by created_at desc
limit 50;
```

Every row corresponds to a batch that was also set to `error`, and `error_type` separates the four
give-up paths (poison pill, rejected scan path, rate-limit budget exhausted, retry budget exhausted)
without reading any logs. `envelope` holds the original message, so a reproduction does not need the
queue.

The queue itself lives in the `pgmq` schema, which is **not exposed over PostgREST**, so depth
cannot be read from the app or from a Supabase client. It needs a direct database connection:

```sql
select * from pgmq.metrics('exam_processing');
select * from pgmq.metrics('exam_processing_dlq');
```

For the worker logs, filter the edge function logs for `[exam-async-worker]`. Two queries worth
keeping:

- `[exam-async-worker] retry` over the last hour, to see whether transient failures are rising
- `[exam-async-worker] handling` filtered to one `batch=`, to follow a single batch through

## Triage

**Batch in `error`.** Read `exam_scan_batches.error` first. It is the exception message from the
path that gave up and it usually names the problem outright. For the full context, including the
original message, find the matching row in `exam_async_worker_dlq_messages`. The batch is
recoverable: `error` is one of the two statuses the Scans page offers Process for, so staff can
retry once the cause is fixed. Re-running Process preserves matches that were already confirmed.

**Batch stuck in `ocr`.** Page OCR runs as separate queue messages, possibly across concurrent
invocations, and `match` must not start until all of them finish. So the match message re-queues
itself every 30 seconds, bounded at 30 attempts, which is about 15 minutes. Past that it is treated
as a real failure and the batch surfaces an error rather than waiting forever. If the status has not
moved and no error has appeared, check `ocr_pending` with the query above; if pages are still
unread, find out whether the worker is running at all before anything else.

**Batch stuck in `uploaded`.** Nobody pressed Process, or the enqueue did not fire. Check the queue
depth. An empty queue with a batch in `uploaded` means no message was ever sent.

**`read_ct` climbing on one `msg_id`.** A poison pill: a message that fails the same way every time.
At 8 reads the worker dead-letters it and sets the batch to `error`, and the envelope lands in
`exam_async_worker_dlq_messages` where it can be replayed. If you catch it before then, the
`handling` log line names the `batch` and the `method`, which is enough to reproduce. Do not simply
delete the message: the batch would sit in a non-terminal status with nothing left to advance it.

One thing to know before counting retries: `requeue()` sends a **fresh** PGMQ message, so `read_ct`
resets to 0 on every requeue. The poison-pill guard therefore only catches messages that fail
_before_ the handler requeues them. Budget exhaustion on the retry path is counted separately, by
`retry_count` in the envelope, which is why both limits exist.

**Rate-limit retries across many batches.** The Gemini and Vision quota is **one shared pool for the
whole course, about $10 a month, shared with CI**. When it is spent, both APIs switch off for
everyone, not just for exams. So a run full of `rate-limit retry` lines is a budget problem, not a
provider problem, and it affects other teams. Say so in `#fn-observability` rather than retrying
into the wall. The worker bounds these at 20 attempts before giving up.

**Transient retries across many batches, no rate limits.** This is the provider being unwell. The
backoff handles it and the batches will finish late rather than fail, unless one exhausts its 5
attempts. Watch the `retry` lines; if they stop climbing, do nothing.

**"Refusing to read it" in the error.** A scan path guard (#1078). The worker checks that every
page's `image_path` names the class, exam and batch it is processing before reading any of them.
This rejects immediately rather than after five retries, because it will reject identically every
time. It means a page row points somewhere it should not, which is a data problem, not a transient
one. Do not retry it; find out how the path got written.

**No log lines at all.** The worker is not being invoked. It is driven both by database triggers on
enqueue and by a periodic invocation, so both would have to fail. Check the edge function is
deployed and check `net.http_post` is reaching it.

**After a deploy, "did my change actually ship?"** Be careful here, because the obvious answer is
wrong. `helm upgrade --install` runs without `--atomic`
([release-images.yml:734](../../.github/workflows/release-images.yml#L734)), so when a post-upgrade
hook fails the workloads **are still deployed** and only the Helm release is marked `failed`. A red
deploy does not mean your code did not ship. This is what #1357 turned out to be: staging reported
failed deploys from 2026-11-20 while the code in them was live the whole time. Separately, the
"Recover stuck helm release" step matches only `pending-*` states, never `failed`, so a failed
release stays failed until someone intervenes.

## What we do not have

Stating these plainly so January inherits the list rather than discovering it.

- **No metrics.** No gauge for queue depth, batch age, retry rate or time-in-stage. Everything above
  is a manual query. Queue depth specifically needs a new RPC and a migration, because `pgmq` is not
  exposed over PostgREST.
- **No alert.** Nothing pages or posts when a batch sits in `error`. The first person to know is
  whichever staff member reloads the Scans page.
- **No load test at the size we claim to support.** The largest real run is 4 students
  (staging, 2026-11-11) and the seeder caps at 60 papers and bypasses the worker entirely. #1337
  covers running 200 through the real pipeline, and the per-stage timings it produces should replace
  the extrapolated numbers in [What normal looks like](#what-normal-looks-like).
- **No visual regression coverage.** No exam spec calls `visualScreenshot`, so Argos cannot catch a
  layout break in the grader view or the template editor. Every Argos diff on an exam PR is in the
  gradebook or pseudonymous grading.
- **No Sentry access for the team.** Events are tagged and routed correctly, but nobody on Paper
  Exams can currently read them, so the `attempt` tag added in #1293 is not being used by anyone.

## Suggested alert (not shipped)

Not in the chart, because there is no metric to alert on yet. The first one worth publishing is a
batch sitting in a non-terminal, non-`review` status past the point where slow becomes stuck:

```sql
select count(*)
from public.exam_scan_batches
where status in ('uploaded', 'ocr', 'matching', 'finalizing')
  and created_at < now() - interval '2 hours';
```

Two hours rather than thirty minutes because a 200-paper Process legitimately takes about 35
minutes, and an alert that fires on a large exam running normally is an alert people learn to
ignore. `review` is excluded for the same reason it is excluded from the triage query: it is waiting
for a person, and there is no duration at which that becomes an incident.

Severity `info`. A stuck batch delays a grading session; it does not lose data, and the pages are
still in storage either way.
