# User-Facing Errors

What a user sees when the database refuses or rejects a request, what reaches Sentry, and how to
work out why a given message appeared. This is the #983 work.

Before #983, many error toasts said "Unknown error". Supabase and refine reject with plain PostgREST
objects (`{ code, message, details, hint }`), not `Error` instances, so the common
`error instanceof Error ? error.message : "Unknown error"` threw the real reason away. Separately,
an UPDATE or DELETE that RLS refused looked like a success, because RLS makes the statement match 0
rows instead of failing it.

## What is live and what is not

| PR    | Status                            | What it changes                                                                                                                                          |
| ----- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1159 | merged                            | The refine data provider reports an `update` or `deleteOne` that RLS refused                                                                             |
| #1296 | merged (`454de927`)               | `TableController` does the same for `update`, `delete` and `hardDelete`, and puts the row back in its cache                                              |
| #1246 | merged (`3a9bbfe4`)               | One mapper for every role (`getUserFacingErrorMessage`), and `reportUnexpectedError` with its list of expected codes                                     |
| #1247 | open                              | Toasts across the app use the mapper, staff screens pass the viewer's role, and two ESLint rules ban the old fallbacks                                   |
| #1297 | open (migration `20261123150000`) | `publish_assignment_group_changes` refuses with 42501, the mapper keeps a function's own 42501 message, and Publish Changes needs an instructor or admin |

Staging has #1246: the mapper takes a role, and `reportUnexpectedError` is there with its list of
expected codes. No screen passes a role until #1247 merges, so everyone on staging still gets the
student wording ("contact your instructor"), and the regrade requests fetch is the only caller of
`reportUnexpectedError`. Until #1297 merges, every 42501 gets the generic permission sentence, and
the publish function still raises P0001. The rest of this page describes the code with all five
merged and says where staging differs today.

## Refused write requests

RLS doesn't fail an UPDATE or DELETE it refuses. The statement matches 0 rows and PostgREST answers
`200` with no rows. Both client paths that change data check for this:

- **refine data provider** (`lib/refineDataProvider.ts`): `update` when no row comes back, and
  `deleteOne` when nothing changed and a follow-up select still finds the row. `updateMany` and
  `deleteMany` are not wrapped.
- **`TableController`** (`lib/TableController.ts`): `update` when `.single()` returns PGRST116, and
  `delete` (a soft delete that sets `deleted_at`) or `hardDelete` when the exact count is 0 and a
  follow-up select still finds the row. The controller puts the row back in its cache before it
  throws.

Both throw `refusedWriteError` from `lib/refusedWriteError.ts`, an `Error` with `statusCode: 403`
and `refusedWrite: true`. Its message names no table or id:

- update: "You don't have permission to change this, or it no longer exists. Nothing was changed."
- delete: "You don't have permission to delete this. Nothing was changed."

One case still reports success. When the session can no longer read the row (a capability removed
while the page was open), the follow-up select finds nothing, and the delete request is treated as
one for a row that is already gone.

## What users see

`getUserFacingErrorMessage(error, context)` in `lib/studentFacingErrorMessages.ts` picks the
message. `getErrorMessage` (`lib/errorMessage.ts`) and `getStudentFacingErrorMessage` call it, so
all three give the same text.

| Error                                                                                                                                   | Message                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Refused write request                                                                                                                   | Its own message, above                                                                                  |
| 42501 raised by one of our functions                                                                                                    | The function's message, then who to ask                                                                 |
| 42501 written by Postgres ("permission denied for …", "… row-level security policy …", "must be owner of …"), or a bare "Access denied" | "You don't have permission to do that.", then who to ask                                                |
| PGRST301                                                                                                                                | "Your session expired or is invalid. Refresh the page and sign in again."                               |
| PGRST116                                                                                                                                | "Nothing was found for this request. It may have been removed or you may not have access."              |
| 23505                                                                                                                                   | "This was already saved or conflicts with existing data. Refresh the page and try again."               |
| 23503                                                                                                                                   | "Something this action depends on is missing or was deleted. Refresh the page and try again."           |
| 23514                                                                                                                                   | "Some entered values are not allowed for this form." and a hint to check the input                      |
| 57014                                                                                                                                   | "The request took too long and was canceled. Try again in a moment."                                    |
| P0001                                                                                                                                   | The function's message, or "This action is not allowed right now." when it has none                     |
| Anything else                                                                                                                           | The message, unless it looks internal; then `details` and `hint`, filtered the same way; then see below |

A message looks internal when it contains "relation ", "violates foreign key" or "duplicate key
value violates unique constraint". The filter doesn't catch everything. When it rejects the message
and `details` and `hint`, or when the error has no code at all, the mapper returns `details` and
`hint`, then the message, without the filter, and the generic sentence only when all three are
empty. So text such as "duplicate key value violates unique constraint …" can still reach the user.

"Who to ask" depends on `context.role`:

| Role                  | Sentence                                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| `grader`              | "If you need access, ask an instructor for this course."                         |
| `instructor`, `admin` | "If you think you should, let the Pawtograder team know so we can look into it." |
| `student`, or none    | "If you need access, contact your instructor."                                   |

Staff screens get the role from `useStaffErrorRole` (`hooks/useStaffErrorRole.ts`), which returns
`instructor` or `grader` from the effective role. An instructor viewing as a student therefore gets
the grader wording. Screens any course member sees use `useViewerErrorRole`, which returns the
effective course role and gives the student wording outside a course. Both read the role once, when
the page loads, so a user whose role changes while the page is open still gets the old wording.

Two contexts replace the message for a 42501 or a refused write request.
`releasedReviewGraderBlocked` gives "This grading feedback has already been released to students…",
and `isStudent` with `rubricReviewRound: "self-review"` gives "The self-review due date has
passed…". The rubric sidebar passes both.

## What reaches Sentry

Showing a message and reporting to Sentry are separate steps. `reportUnexpectedError(error, extra,
options)` sends the error to Sentry unless it is expected:

- A refused write request is always expected.
- PGRST301, 23505, 23514 and P0001 are expected by default.
- 42501, PGRST116 and 23503 are not. When a page reads data they usually mean our bug, such as a
  missing GRANT, and on a change they often mean the page offered an action the database refuses. A caller that expects one passes
  `{ expected: [...] }`. With #1297, Manage Groups' publish handler expects 42501. No caller on
  staging passes `expected` yet.

The event's title is the error's message. It is tagged `error_code` (the PostgREST or Postgres code,
or `none`), carries the caller's `extra` as the `error_context` context (for example `operation` and
the ids involved), and has the raw object as `postgrest_error` when there is a code.

Only two places call `reportUnexpectedError`: the regrade requests fetch, which is on staging, and
the Manage Groups publish handler, which #1297 adds. Most toasts use the mapper and report nothing.
Separately, many pages call `Sentry.captureException` directly, which reports whatever they catch,
expected or not. So a toast with no Sentry event is normal, and a Sentry event for a refused write
request can come from one of those direct calls.

The client's `beforeSend` (`instrumentation-client.ts`) drops hydration errors on both paths. It
drops PGRST303 ("JWT expired") only when a page passes the raw PostgREST object to
`Sentry.captureException`, because the check reads `event.extra.__serialized__`, which Sentry fills
in only for a plain object. `reportUnexpectedError` wraps the object in `new Error(...)` first, and
PGRST303 isn't on its expected list, so a PGRST303 that goes through it reaches Sentry.

## What normal looks like

Permission toasts happen in ordinary use. A grader edits marks after the review was released, a
student changes a self-review after the deadline, or two tabs race on the same row. None of these is
an incident. The ones that end as refused write requests never reach Sentry through
`reportUnexpectedError`. The ones that end as a 42501 (an insert that RLS rejects, for example) do,
unless the caller expects 42501.

An event tagged `error_code:42501` is still worth reading. It usually means a page and the database
disagree about who may do something: the page showed the control, and RLS or a function refused the
request.

## Checking it by hand

Whether the publish migration from #1297 is applied, and whether the function raises 42501:

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version = '20261123150000';

SELECT prosrc LIKE '%insufficient_privilege%' AS raises_42501
FROM pg_proc
WHERE proname = 'publish_assignment_group_changes';
```

What a user may do in a class. A user holds only the capabilities of their own class role, which is
what `useCapability`, RLS and `user_class_capabilities()` all read:

```sql
SELECT up.role, up.class_role_id, rc.capability
FROM public.user_privileges up
LEFT JOIN public.role_capabilities rc ON rc.role_id = up.class_role_id
WHERE up.user_id = :'user_id' AND up.class_id = :class_id;
```

Run both as the service role or the database owner.

## Triage

**"You don't have permission to change this, or it no longer exists. Nothing was changed."** RLS
refused an update, or the row was deleted. Find the table from the page, then compare the user's
role and capabilities (query above) with that table's UPDATE policy. This never reaches Sentry
through `reportUnexpectedError`. If the user should be allowed, the policy or the role is wrong, not
the client.

**"You don't have permission to delete this. Nothing was changed."** The delete request matched no
rows and the user can still see the row. Check the table's DELETE policy. For a table that
`TableController.delete` soft-deletes, check the UPDATE policy instead, since a soft delete is an
UPDATE of `deleted_at`.

**A user deleted something, saw no error, and it came back after a reload.** The one case that still
reports success (see Refused write requests). Check whether the user lost access to the row while
the page was open.

**"Only instructors can publish group changes." followed by a "who to ask" sentence.**
`publish_assignment_group_changes` refused the user. Since #1297, Manage Groups shows Publish Changes
only to instructors and admins, so this means the user's role changed after the page loaded. A
reload hides the button. The publish handler expects 42501, so there is no Sentry event. Copy Groups
from Prior Assignment doesn't call this function: since #1401 anyone with `manage_groups` sees it.

**The same refusal with no "who to ask" sentence.** The database raised P0001. On staging, before
#1297, this is expected: Publish Changes shows for anyone with `publish_groups`, and the function
refuses anyone who isn't an instructor or admin with P0001. Once #1297 is deployed, it means the
publish migration isn't applied. Run the checks in Checking it by hand.

**The publish refusal shows only "You don't have permission to do that."** The database raised
42501, but the client is from before #1297 (for example after an app rollback), and its mapper
replaces every 42501 message with the generic sentence. Nothing is broken.

**Staff see "contact your instructor".** Either #1247 isn't deployed (staging has #1246's roles, but
no screen passes one yet), or that call site doesn't pass a role. Search the component for `getUserFacingErrorMessage(` and check for
`{ role: errorRole }`.

**Several Sentry events tagged `error_code:42501`.** A page offers an action that RLS or a function
refuses. `error_context.operation` names the call. Compare the control's capability check on the
page with the policy or function, and change whichever is wrong. #1010 is moving these checks to
capabilities, so most fixes belong there.

**A Sentry event tagged `error_code:none`.** Not a database error: a network failure or a client
bug. The mapper isn't involved.

**A toast says "Unknown error" or "[object Object]".** A call site the #1247 sweep missed. ESLint
bans `x instanceof Error ? x.message : "Unknown error"` everywhere, and `... : String(x)` in `app/`
(except `app/api/`), `components/` and `hooks/`. CI runs `next lint`, which checks `app/`,
`components/` and `lib/` but not `hooks/`, so a hook can still slip through. The `String(...)` rule
also catches a condition such as `err instanceof A || err instanceof Error`, but the
`"Unknown error"` rule doesn't. Fix the call site with
`getUserFacingErrorMessage(error)`.

## Rollback

Migrations are forward-only (see [Rollback](./rollback.md)). To go back to the P0001 refusal, add a
migration that re-creates `publish_assignment_group_changes` from
`20261118140200_forgejo_group_repos.sql`, the definition `20261123150000` copied. The client handles
both codes: P0001 shows the function's message, and 42501 shows it with the "who to ask" sentence.

Rolling the app back while the migration stays is safe. The older mapper turns every 42501 into "You
don't have permission to do that." and the "who to ask" sentence for the role the screen passes, or
"If you need access, contact your instructor." on a client from before #1247.

## Suggested alert (not shipped)

Not configured anywhere yet. If a deployment wants one, alert on new Sentry issues tagged
`error_code:42501`, at low priority. Most are a page that offered an action the database refused, and
the rest are usually a missing GRANT on a table a page reads. Both are bugs even when the user saw a clear message.
Don't alert on refused write requests. They are expected and never reach Sentry through
`reportUnexpectedError`.
