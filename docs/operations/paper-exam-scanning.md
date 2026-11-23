# Paper Exam Scanning

What to check when a paper exam batch looks stuck, and how to tell a batch that is working slowly
from one that has failed.

Paper exams are off by default. A course turns them on with the `exams` course flag ("Paper exams"
under Course Settings > Feature flags). The flag gates the pages themselves, not just the nav:
`ExamFeatureGate` renders a notice for a pasted URL, so a course that never opted in does not reach
a live upload form.

**Turning the flag off is not a complete rollback, and that is worth knowing before you reach for
it.** The gate is a render-time check in the UI. `enqueue_exam_process_batch` and
`enqueue_exam_finalize` check only that the caller is an instructor or grader for the batch's class
(`20261107120000_exam_grading.sql:972` and `:1051`); neither looks at the course's `exams` feature.
So after the flag is off, staff with an already-open Scans or Match Review page, and anyone calling
the RPC directly, can still queue worker jobs and spend the shared Gemini budget. It also does not
cancel work already queued, which drains on its own.

To actually stop work, turn the flag off **and** confirm the queue is empty (see
[Checking it by hand](#checking-it-by-hand)). Pushing the check down into the two RPCs is #1422.
Until that lands, the two-step above is the rollback.

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
Those are the rows `enqueue_exam_finalize` re-enqueues, but **nothing calls it automatically.** The
cron worker drains queued messages; it never creates new finalize messages. A row whose finalize
message is no longer queued stays unfinished until staff re-run `exams scans finalize` or the match
review action. Do not wait for a recovery that will not come.

**Start every give-up investigation here**, because dead-lettered messages are kept in a normal
table rather than only in the queue. The table is `service_role` only (`revoke all ... from anon,
authenticated`, migration `20261107120000_exam_grading.sql:380-383`), so this needs the service role
key or a direct database connection, not a signed-in client:

```sql
select created_at, method, error_type, error_message, retry_count,
       envelope->>'batch_id' as batch_id, debug_id
from public.exam_async_worker_dlq_messages
order by created_at desc
limit 50;
```

Almost every row corresponds to a batch that was also set to `error`. The exception is a batch
already in `completed`: `setBatchError` ends with `.neq('status', 'completed')` (`index.ts:167`), so
a late or duplicate finalize that read the row before it was stamped reaches the DLQ and Sentry
without changing the batch. A DLQ row pointing at a `completed` batch is that case, not corruption.
`envelope` holds the original message, so a reproduction does not need the queue.

`error_type` is the error's class name (`index.ts:128`), which identifies two of the four give-up
paths and not the other two. Read the row like this:

| Give-up path                | How to recognize it                                           |
| --------------------------- | ------------------------------------------------------------- |
| Rejected scan path          | `error_type` is `ScanPathRejectedError` or a subclass of it   |
| Rate-limit budget exhausted | `error_type` is `ProviderRateLimitError`, `retry_count` at 20 |
| Poison pill                 | `error_message` starts with `read_ct=`                        |
| Retry budget exhausted      | neither of the above, `retry_count` at 5                      |

The last two both store a plain `Error`: the poison-pill guard raises one itself, and the retry path
stores whatever the final attempt threw. So `error_message` and `retry_count` do the work there, not
`error_type`.

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
itself every 30 seconds, bounded at 30 attempts, which is about 15 minutes. Past that it throws,
but the error does not surface straight away: the OCR wait bumps `ocr_waits`, not `retry_count`, so
the throw lands on the transient path with `retry_count` still 0 and buys five more attempts at
`min(300, 10 * 2^n)` seconds, another 310s. **Budget about 20 minutes from the last OCR write to the
batch showing an error**, and expect it to sit in `ocr` for all of it. If the status has not
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

**No log lines at all.** The worker is not being invoked, and two separate things would have to have
failed. The scheduled path is the pg_cron job `invoke-exam-async-worker-every-minute`
(`20261107120000_exam_grading.sql:1181`), which runs every minute and calls
`invoke_exam_async_worker_background_task()`: it does nothing when the queue is empty, starts 5
workers when 10 or more messages are waiting, and 2 otherwise. The other path is not a trigger; the
two enqueue RPCs invoke the worker themselves after sending.

Check `cron.job_run_details` for that job first. If the job is running and the queue is not empty,
the problem is between the database and the function: confirm the edge function is deployed and that
`net.http_post` is reaching it.

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
- **No alert, and no column to build one on.** Nothing pages or posts when a batch sits in `error`,
  so the first person to know is whichever staff member reloads the Scans page. `exam_scan_batches`
  also records no stage-entry time, only `created_at`, so "this batch has been stuck for two hours"
  cannot be expressed in SQL today. #1423 covers the missing column, and is the blocker for
  [Suggested alert](#suggested-alert-not-shipped).
- **The `exams` flag is not enforced where the work is queued.** `enqueue_exam_process_batch` and
  `enqueue_exam_finalize` check staff role and not the course feature, so turning the flag off does
  not reliably stop new worker jobs or new spend. Raised by CodeRabbit on this PR, tracked as #1422.
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

**This query is wrong as written, and it cannot be written correctly today.** `exam_scan_batches`
has `created_at` and nothing else: no column records when a batch entered its current status. A
batch that sat in `review` for three days and then started finalize normally has a `created_at`
three days old, so this fires immediately on a healthy finalize. Measuring time in the active stage
needs a stage-entry timestamp that does not exist yet. That column is #1423, and it is the first
thing to add before anyone ships this alert.

Two hours rather than thirty minutes because a 200-paper Process legitimately takes about 35
minutes, and an alert that fires on a large exam running normally is an alert people learn to
ignore. `review` is excluded for the same reason it is excluded from the triage query: it is waiting
for a person, and there is no duration at which that becomes an incident.

Severity `info`. A stuck batch delays a grading session; it does not lose data, and the pages are
still in storage either way.
