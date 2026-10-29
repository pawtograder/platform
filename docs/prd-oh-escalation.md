# PRD: Office Hours Ticket Escalation

Status: V1 built on `feature/oh-escalation`, revised after capstone feedback. Owner: Rishi Dilip.

## Problem

Students told us in discovery interviews that when a TA can't resolve their question, they have no way to hand it to someone more experienced. They rejoin the queue at the back and wait again, often for a question that takes two minutes once the right person sees it. Today the only staff action short of resolving is "Stop helping", which returns the ticket to the queue with no note and no priority. Every rejoin adds a ticket to the line for everyone else.

## Goals

- An escalated student waits less than a student who rejoins from the back of the queue.
- The next staff member sees what was tried and what is still open without asking the student to explain again.
- Students can only escalate after a staff member has helped them, so escalation can't be used to skip the line.
- Staff can stop a ticket from being escalated again when more help won't fix it.

## Non-goals

- Automatic routing by topic or assignment.
- Notifications outside the app (email, Discord, push).
- Analytics dashboards for escalation data.
- Escalation targets or new staff roles. An escalated ticket is flagged to every staff member working the queue.
- A cap on escalations per ticket. Staff decide case by case with End ticket.

## Definitions

- Session: a help queue with at least one staff member actively working it (an active `help_queue_assignments` row).
- Picked up: the ticket is `in_progress` with an assignee.
- Check-in: the 10 minutes after staff press Resolve, during which the ticket's students can answer "Did your problem get fixed?".

## V1 scope

In:

- TA escalation: while helping, the assigned staff member can escalate at any time with a required note (max 500 characters).
- Resolve (staff): the ticket becomes `resolved` and the student sees "Did your problem get fixed?" on any course page.
  - Yes: the ticket stays resolved and the student gets the existing feedback prompt.
  - No: the student writes a required note on what is still unclear, and the ticket is escalated.
  - No answer within 10 minutes: the ticket stays resolved.
- End ticket (staff, red): the ticket becomes `closed` with no check-in. Nobody can escalate it again, and students cannot reopen it.
- On escalate, the ticket returns to `open`, the assignee is cleared, and an escalation record is stored (who escalated, previous assignee, note, timestamp).
- In every queue view, escalated open tickets sort above normal open tickets, ordered among themselves by original `created_at`. Any staff member can claim one.
- An Escalated badge on the ticket, with a count when it has been escalated more than once ("Escalated ×2"). Staff queue rows also preview the latest note.
- On an escalated ticket, staff see a history panel: who already helped, time waited in line, and every escalation note.
- Escalation notes are visible to course staff only.

Cut:

- An Escalate button for students during help.
- Escalating to a specific role or staff member.
- Escalating across queues.
- Editing or withdrawing an escalation.

## Success metrics

Each metric has a baseline we can compute from existing tables (`help_requests`, `help_request_students`, `help_request_work_sessions`, `help_request_feedback`). After launch, `help_request_escalations` identifies escalated tickets. Targets are proposals to confirm with course staff.

- Rejoin rate: share of resolved or closed tickets whose student opens a new ticket in the same queue within 2 hours. Target: half of baseline.
- Total wait per question: time spent `open` (ticket creation or escalation until the next work session starts), summed across pickups. Compare escalated tickets to rejoin pairs from the baseline. Target: 50% lower.
- Same-session resolution: share of escalated tickets resolved before the last active `help_queue_assignments` row for that queue ends. Baseline is the same measure for rejoin pairs. Target: 80% or more.
- Feedback: thumbs-up rate in `help_request_feedback` for escalated tickets vs. rejoin pairs. Target: escalated rate at or above baseline.
- Fairness check (no target): `longest_wait_seconds_at_start` on work sessions for non-escalated tickets, before vs. after launch. A rise means escalations are pushing everyone else back.

## Acceptance criteria

- [ ] An `open` ticket shows no Escalate action to anyone; the backend rejects escalating one.
- [ ] The assigned staff member sees Escalate on an `in_progress` ticket. Students and other staff do not.
- [ ] When staff press Resolve, every student on the ticket sees "Did your problem get fixed?" on any course page.
- [ ] Answering Yes keeps the ticket resolved; answering No requires a note, and an empty note shows an inline error.
- [ ] The check-in disappears after 10 minutes, and the backend rejects a late answer.
- [ ] After End ticket, the ticket is `closed`, no check-in appears, and the backend rejects escalating or reopening it.
- [ ] After either escalation path, the ticket is `open`, has no assignee, and shows the Escalated badge.
- [ ] In every queue view, an escalated ticket appears above every non-escalated open ticket, including older ones.
- [ ] Two escalated tickets order by original `created_at`.
- [ ] Every staff member working the queue sees the flag and note, and any of them can claim it.
- [ ] The staff member who claims an escalated ticket sees each earlier TA, the time already waited, and every escalation note.
- [ ] A second escalation of the same ticket shows "Escalated ×2" and keeps both notes in the history.
- [ ] Students cannot read escalation notes or write escalation fields through the API.
- [ ] Non-escalated tickets keep their current order and the existing claim and release behavior.

## Open questions and risks

- Resolve changes meaning for staff: it now gives the student a check-in instead of being final. TAs need to know End ticket is the new "done for good".
- Staff overload: if most tickets come back escalated, the queue becomes a second line. Watch the share of tickets with `escalation_count > 1`, and revisit a cap if it climbs.
- Fairness: escalated tickets push everyone else back. The fairness check above tracks this.
- Students with real gaps may answer Yes to avoid feeling like a burden. Wording of the check-in matters; test it with students.

## Links

- Interview notes and synthesis: TODO
- Final PRD: TODO
- Clickable prototype (mock data): https://claude.ai/artifact/7ZB62gNYXo3iJywFkV163K
- Migration: `supabase/migrations/20261029120000_help_request_escalation.sql`
