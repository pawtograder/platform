# Reproducing eight high-impact bugs

Eight bugs found by reading the code, chosen because an ordinary user hits them on an
ordinary path. Each one was traced end to end in the source; none needs an exotic
configuration. File references point at the offending expression.

## Baseline setup

Do this once. Every repro starts from here.

```bash
npx supabase stop --no-backup            # never restore the old volume
npx supabase start
npx supabase status -o env               # copy keys into .env.local
```

`.env.local` needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `ENABLE_SIGNUPS=true`, and
`NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3000`.

Seed with predictable logins instead of the random faker addresses:

```bash
FIXED_INSTRUCTOR_EMAIL=instructor@test.local \
FIXED_GRADER_EMAIL=grader@test.local \
FIXED_STUDENT_EMAIL=student@test.local \
npm run seed
```

Then `npm run dev` and sign in at http://localhost:3000. The password is `change-it`.
The seeder prints the class id; every path below writes it as `<id>`.

### What the default seed gives you

The default `micro` template creates "Micro Test Class" with 30 students, 1 grader,
1 instructor, 2 assignments, 1 group assignment, 1 lab assignment, 5 help requests
(a mix of public and private), 3 surveys, and discussion topics with a few posts each.
The gradebook uses the specification scheme: twelve columns slugged `skill-1` through
`skill-12`, plus the aggregates `meets-expectations`, `approaching-expectations`,
`does-not-meet-expectations`, `total-labs`, and `average.hw`.

Polls and flashcards are **not** seeded. Nothing below needs them.

---

## 1. Survey answers are lost on refresh

**Role:** student. **Prereq:** any seeded survey, unmodified.

Autosave is gated on the wrong flag, and that flag defaults to off, so the typical
survey never persists a draft.

1. Sign in as the instructor. Go to `/course/<id>/manage/surveys` and confirm a
   published survey exists with "allow response editing" **off** (this is the default).
2. Sign in as the student in another browser. Open `/course/<id>/surveys` and click
   that survey.
3. Answer three or four questions. Do **not** press Complete.
4. Press F5.

**Expected:** the answers come back and the survey list shows "In Progress".
**Actual:** every answer is gone and the list still shows "Not Started".

Turning "allow response editing" on makes the same flow restore the draft correctly,
which is what makes this a gate on the wrong flag rather than a missing feature.

`app/course/[course_id]/surveys/[survey_id]/page.tsx:238` —
`if (!private_profile_id || !surveyId || !allowResponseEditing) return;`.
`allow_response_editing` governs editing an already-submitted response, not draft
persistence. The loader, the `in_progress` status, and the RLS policy in
`20260817120000_tighten_survey_and_poll_rls.sql:36` all expect drafts to exist.

---

## 2. A private help request disappears from the student's own screen

**Role:** student plus instructor. **Prereq:** none beyond the seed.

1. Sign in as the student. Go to `/course/<id>/office-hours`, pick a queue, and click
   **New Request**.
2. Tick **Private request**, write anything, submit. Stay on the request page.
3. In a second browser, sign in as the instructor and open the same request.
4. Perform any staff action that updates the row — assign it to yourself, start a
   video call, or resolve it.
5. Look back at the student's tab. Do not reload.

**Expected:** the student sees the request update to "assigned".
**Actual:** the request vanishes from the student's client — the queue panel empties,
the floating active-request widget disappears, and the detail page falls back to its
spinner. A reload brings it back.

If the student is the one writing (for example resolving from the floating widget),
they also get a failure toast for a write that actually succeeded, because
`TableController.update()` then throws `Error("Row not found")`.

The trigger sends an id-only payload for private rows —
`data := jsonb_build_object('id', row_id)`, with no `class_id`
(`20251001193829_fix-office-hours-queue-realtime.sql:28`). The controller is built with
`realtimeFilter: { class_id: this.classId }` (`hooks/useOfficeHoursRealtime.tsx:119`),
so the filter check reads `undefined`, and `TableController.ts:2518` takes the eviction
branch: `if (existingRow && !matchesFilter) { this._removeRow(data.id); return; }`.

---

## 3. The office-hours queue freezes permanently after a tab switch

**Role:** student plus instructor. **Prereq:** none beyond the seed.

Students have no reconnect path at all. Staff do, which is why this survives testing.

1. Sign in as the student and sit on `/course/<id>/office-hours/<queue_id>`.
2. Switch to a different browser tab and leave it there past the inactive-tab timeout
   (the controller calls `disconnectAllChannels()`). Putting the laptop to sleep or
   dropping the network works too.
3. While the student is away, sign in as the instructor and resolve the student's
   request. Have a second student post a new public request in the same queue.
4. Return to the student's tab and wait for the channels to rejoin.

**Expected:** the queue catches up.
**Actual:** it stays frozen at its pre-disconnect state forever. The resolved request
still reads "open", the new request never appears, and the queue position never moves.
The connection indicator says connected, so nothing prompts a reload.

`ClassRealTimeController.ts:804` — `getConnectionStatus()` has branches for
`class:<id>:staff`, `class:<id>:user:<profile>` and the submission topics, then
`continue`s. There is no branch for `class:<id>:students`, which is where every
student-visible broadcast lands, so that channel is never reported and no reconnect
refetch fires. Compounding it, `TableController.ts:133` has
`help_requests: ["staff", "help_queue", "help_request"]` — no `"students"`.

---

## 4. "Staff-only column" is silently discarded, and students see the grades

**Role:** instructor. **Prereq:** none beyond the seed.

1. Go to `/course/<id>/manage/gradebook` and click **Add Column**.
2. Enter a name, slug, and max score. Leave **Score Expression** empty.
3. Tick **Staff-only column (hidden from students until you release it)**. Save.
4. Open the new column's menu and choose **Edit Column**.

**Expected:** the checkbox is still ticked and the column carries a staff-only lock.
**Actual:** the checkbox is clear and there is no lock icon. The column was written with
`instructor_only: false`, so students see it in their gradebook immediately. Ticking the
box on the Edit dialog for any manual column does not persist either.

To confirm the student side, sign in as the student and open `/course/<id>/gradebook`.
The column is listed.

`app/course/[course_id]/manage/gradebook/gradebookTable.tsx:383` —
`return Boolean(normalizeScoreExpression(scoreExpression)) && Boolean(instructorOnly);`,
used by both create and update. The checkbox renders unconditionally at `:614`, and the
database explicitly supports `score_expression IS NULL` together with
`instructor_only = true` (`20260407000000_gradebook_column_instructor_only.sql:110`).

---

## 5. Gradebook CSV import saves a different grade than the preview showed

**Role:** instructor. **Prereq:** one manual gradebook column.

Duplicate student rows are ordinary in SIS exports and in any file that had a regrade
row appended. The preview and the write disagree about which row wins.

1. Create a manual column named `HW1` (Add Column, no score expression). Give one
   student — call them Alice — a score of 80.
2. Save this as `import.csv`, using Alice's real seeded email:

   ```csv
   email,HW1
   alice@example.com,80
   alice@example.com,95
   ```

3. Go to `/course/<id>/manage/gradebook` → **Import Columns**, choose the file, map the
   `HW1` header to the existing `HW1` column, and click **Preview Import**.
4. Alice appears under "No changes to grades from this file, but in the file",
   showing `80`.
5. Click **Confirm Import**, then look at Alice's `HW1` cell.

**Expected:** the cell matches what the preview promised.
**Actual:** it reads 95. Reverse the two rows and the mirror bug happens — the preview
promises `~~80~~ 95` and the cell keeps 80.

The preview resolves one row per student with a first-match lookup
(`importGradebookColumn.tsx:742` and `:918`, both `.find()`), while `confirmImport`
emits every CSV row (`.map()` at `:156`) and the RPC keeps the last
(`DISTINCT ON ... ORDER BY ... ordinality DESC`). Nothing warns about the duplicate.

### Same dialog, two related failures

Both of these reproduce in the same import flow:

- **A malformed CSV leaves a blank, un-escapable dialog.** Import a file with a bare
  double quote in an unquoted field, such as a name cell reading `John "Jack" Smith`.
  The dialog advances to step 2 and renders an empty body with no error, no toast, and
  no Back button. `parse()` runs inside `reader.onload` with no `try/catch` and no
  `reader.onerror` (`importGradebookColumn.tsx:278`), while the file handler has already
  called `setStep(2)`.
- **Non-numeric cells are previewed as changes, dropped on save, then misreported.**
  Use values such as `85%`, `1,234`, or `EX`. They show under "Has changes", then no
  grade moves, and the toast claims the students "had no entry in the import" — they
  did (`:179` and `:190`).

---

## 6. Typing `@` swallows Enter in every message box

**Role:** any. **Prereq:** none beyond the seed.

1. Open any discussion thread under `/course/<id>/discussion` and click **Reply**.
   The office-hours chat behaves identically.
2. Type `email me at nour@` — anything ending in a bare `@`.
3. Press Enter.

**Expected:** the message sends.
**Actual:** nothing happens. No send, no newline. Tab no longer moves focus out of the
field either. Press Enter a second time and it works.

The worse variant: type `office hours @3` and press Enter. The text from the `@` onward
is silently replaced with a markdown link to whichever thread's ordinal starts with `3`
— a thread the user never chose — and the message still does not send.

`hooks/useMentions.tsx:51` matches `/@(\d*)$/`, where `\d*` matches zero digits, and
sets `isActive: true` unconditionally even when the filtered list is empty.
`components/ui/message-input.tsx:200` then runs
`case "Enter": case "Tab": e.preventDefault(); handleMentionSelect();`, and the send
path is skipped by the `if (mentionState.isActive) return;` guard.

---

## 7. A password typo permanently bricks an invitation link

**Role:** instructor plus an invited student. **Prereq:** an invitation email.

The token is consumed before the password is validated, and the retry loses it.

1. As the instructor, invite a new user from `/course/<id>/manage/course/enrollments`.
2. Open the invite mail (Inbucket at http://localhost:54324) and click the link. It
   lands on `/auth/accept-invitation?token_hash=...`.
3. Type a password shorter than six characters and click **Accept Invitation**.
4. The page returns with "Password should be at least 6 characters."
5. Type a valid password and click **Accept Invitation** again.

**Expected:** the second attempt succeeds.
**Actual:** it fails with a token error, and so does every attempt after it. The invitee
can never accept from that email; the instructor has to re-invite.

`app/actions.ts:31` — `verifyOtp` consumes the one-time token before `updateUser` runs.
On a password error it redirects to `/auth/accept-invitation` with no `token_hash`, so
the hidden input re-renders empty. The page then force-signs-out at
`app/auth/accept-invitation/page.tsx:16`, destroying the session the consumed token
created, so there is no logged-in fallback either. `setNewPasswordAction` at
`app/actions.ts:47` guards against exactly this case; the invitation path does not.

---

## 8. Subscribed calendars show every assignment deadline at the wrong time

**Role:** student. **Prereq:** the app server's timezone must differ from the course
timezone. In production the server is UTC, so this is always live. Locally the two
usually match, which cancels the error out — start the dev server with
`TZ=UTC npm run dev` to see it.

1. As the instructor, set the course timezone to `America/New_York` under
   `/course/<id>/manage/course`.
2. Edit one of the seeded assignments and set its due date to `23:59`.
3. As the student, open `/course/<id>/assignments`, use the calendar **Subscribe**
   button, and copy the `/api/calendar/<id>` URL.
4. Open that URL in a browser, or add it to Apple or Google Calendar, and look at the
   "Due: ..." event.

**Expected:** 11:59 PM.
**Actual:** 6:59 PM — five hours early, four during daylight saving.

`assignments.due_date` is `timestamp without time zone`, so PostgREST returns a naive
`"2026-03-05T23:59:00"`. `lib/ics-generator.ts:35` does `new Date(date)`, which parses
it in the server's zone, then `new TZDate(dateObj, timezone)` shifts it a second time.
Office-hours events are unaffected because `calendar_events` is `timestamptz`, and lab
meetings are unaffected because they use the explicit `new TZDate(y, m, d, h, m, tz)`
constructor.

While testing this, note that `/api/calendar/<id>` takes no token and no session. Signed
out, `curl http://localhost:3000/api/calendar/<id>` returns the full assignment list for
that course, including unreleased assignments. The handler builds a service-role client
that bypasses RLS (`app/api/calendar/[course_id]/route.ts:190`), and `middleware.ts`
only guards paths under `/course`.
