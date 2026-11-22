# Capabilities and class roles

Status: **In progress** (#1010) · Migrations: `20261027120000_class_roles_and_capabilities.sql`, `20261030120000_protect_class_roles.sql`, `20261106120000_role_capabilities_broadcast.sql`, `20261106140000_assignments_save_by_capability.sql`, `20261108120000_review_assignments_by_capability.sql`, `20261119120000_custom_roles_copy_grader_role.sql`, `20261121160200_repository_status_by_capability.sql`, `20261122110000_gradebook_by_capability.sql`, `20261122110100_gradebook_view_by_capability.sql`, `20261122200000_flashcards_manage_by_capability.sql`, `20261122200100_surveys_polls_by_capability.sql`, `20261122200200_office_hours_by_capability.sql`

A **capability** is one action, such as `manage_review_assignments`. A **class role** is a bundle
of capabilities in one class. Every class has four default roles (instructor, grader, student,
admin) and may have custom grader roles such as "Head TA". The UI and RLS both decide from these
tables, so a control is shown exactly when the database allows the action.

## What a user holds

In each class, a user holds the capabilities of their own class role (`user_roles.class_role_id`),
and nothing else.

- **Instructors, students and admins** are on their app role's default role.
- **Graders** are on the default grader role, or on a custom role such as "Head TA".
- **A new custom role starts as a copy of the default grader role.** The copy leaves out any
  capability its creator doesn't hold in the class (the service role and migrations copy
  everything). The instructor then turns capabilities on or off. After that the two lists are
  separate: changing the default grader role doesn't change roles made earlier. So a custom role
  can hold more than a plain grader (a Head TA) or less (a course coordinator who doesn't grade).
- **Instructors can edit the default grader role.** The instructor, student and admin roles are fixed.
  The default grader role can't be renamed or deleted.
- Only graders can be on a custom role, and `manage_roles` is never on the grader role or a custom role.

`public.user_class_capabilities()` is the one place that applies this rule. It returns
`(class_id, capability)` for the signed-in user.

Every capability is on the default instructor role, so instructors can do everything and nobody
can be given more than an instructor. A role manager can only add or remove a capability they hold
in that class, on the default grader role or a custom role.

`manage_roles` lets someone create custom roles and choose their capabilities. It does **not**
let them put people on a role: changing `user_roles.class_role_id` still goes through the
instructor-only `user_roles` UPDATE policy. Changing someone's app role or class resets their
class role to the new default, and an update that also sets `class_role_id` is refused, so do it
in two updates.

## Checking a capability in a policy

A policy checks capability X only as

```sql
<the row's class_id> IN (SELECT public.user_class_ids_with_capability('X'))
```

in a policy `TO authenticated`. The helpers can't be run by `anon`, so a policy without
`TO authenticated` also applies to anonymous requests, which then fail with 42501
(`npm run check:function-grants` flags it).

Because every capability is on the default instructor role, this check **replaces**
`authorizeforclassinstructor(...)`; don't OR the two together.

If the table has no `class_id`, find the row's class inside the subquery. For example,
`role_capabilities` reaches it through `class_roles`:

```sql
CREATE POLICY "..." ON public.role_capabilities
  FOR DELETE TO authenticated
  USING (
    role_id IN (
      SELECT cr.id FROM public.class_roles cr
      WHERE cr.class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
    )
  );
```

Don't look the capability up yourself by combining `user_privileges` with `role_capabilities` (a
SQL join) inside the policy:

- **The rule should live in one place.** `user_class_capabilities()` decides what a user holds. A
  policy that joins the tables itself has its own copy of that rule, which drifts the next time the
  rule changes (it already changed once: custom roles used to add to the default grader role).
- **It can fail outright.** On the capability tables themselves, the policy reads tables whose own
  policies read back, and Postgres stops with "infinite recursion detected in policy".

It isn't slow. The function takes no per-row argument, so Postgres runs it once per statement
(a hashed subplan), not once per row.

## Checking a capability in an edge function

```ts
await assertUserHasCapabilityOrServiceRole(class_id, "manage_assignments", req.headers.get("Authorization"));
```

`assertUserHasCapabilityOrServiceRole` (in `supabase/functions/_shared/HandlerUtils.ts`) asks the same
`user_class_ids_with_capability()` as the policies, so an edge function and the tables it writes agree.
Like `assertUserIsInstructorOrServiceRole`, which it replaces for an action a capability covers, it
also lets through the service role and an admin of any course. Load the row's class from the database
and filter by it, so a capability in one class can't reach another class's rows.

CLI handlers that gate on a capability use `assertUserHasClassCapability` the same way: call
`user_class_ids_with_capability()` on the caller-scoped client from `ctx.supabase` (the JWT minted
for the token owner). Do not join `user_roles` to `role_capabilities` by hand, and do not ask the
service-role client; without the caller's JWT the RPC has no `auth.uid()` and fails closed.

## Adding a capability

Write one migration that:

1. Inserts it into `public.capabilities` with a short description.
2. Adds it to the default **instructor** role in every existing class, and to any other default role
   that should have it. New classes give the instructor role every capability on their own (the
   `CROSS JOIN` in `seed_default_class_roles()`), but existing classes don't, so without this
   instructors in existing classes would be refused.

   **If graders can do the action today, also add it to every custom role.** A custom role is a copy
   of the default grader role made when it was created, so it doesn't pick up a capability added to
   the default grader role later. Without this, a Head TA would lose something every plain grader
   can do. For a capability graders have today:

   ```sql
   INSERT INTO public.role_capabilities (role_id, capability)
   SELECT cr.id, 'my_capability' FROM public.class_roles cr
   WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
   ON CONFLICT DO NOTHING;
   ```

   For an instructor-only capability, use `WHERE cr.default_for = 'instructor'`.

3. Updates `public.seed_default_class_roles()` if a default role other than instructor should get
   it in new classes too. It sets up the default roles when a class is created.

Only migrations add capabilities. The app can't write `capabilities`, and of the default roles it can
only change the grader role's capabilities.

## A capability that also decides who can see something

Most capabilities are actions, and any staff member can still see what they saw before. One
exception: **`manage_gradebook` covers the whole staff gradebook**, seeing it as well as changing it.
Without it, a staff member can't open the gradebook page, read other students' gradebook cells,
override a score or use Convert Missing to 0, and the private grades on a student's profile page are
hidden. It is instructor-only by default, so graders on the default grader role don't have the
gradebook until an instructor gives it to their role. Students still see their own released grades.

## For the UI: useCapability

```tsx
const canPublish = useCapability("publish_groups");
```

`useCapability` (in `hooks/useClassProfiles.tsx`) reads the same `user_class_capabilities()`, so a
page hides a control exactly when the policy would refuse the action. It returns `false` while
loading and while an instructor is viewing as a student.

Every course page shares one fetch, made by `ClassCapabilitiesProvider` in the course layout. It asks
again when the staff channel says the viewer's own role changed or a role's capabilities changed
(a burst of changes gives one re-ask). Other people's role changes are ignored.

## manage_flashcards

`manage_flashcards` covers creating, editing, deleting and copying flashcard decks and cards
(area 13). Day one, the default instructor role, the default grader role and every existing custom
role hold it, so instructors and default graders keep the management access graders already had. An
instructor can then turn it off for the default grader role or a custom role. Before this capability,
the person who created a deck could still update and delete it and manage its cards without the
staff check; that creator path is gone so the capability is the only rule for those writes. The
create / edit / delete controls follow `useCapability("manage_flashcards")`. The Course Settings
"Flashcard Decks" entry and deck pages remain available to all staff for viewing. Left as views: class members reading decks and cards, students
writing their own progress and interaction logs, and staff reading class-wide progress and logs for
analytics.

CLI `flashcards.copy` requires active instructor or grader access in the source class to read its
decks. It requires `manage_flashcards` only in the target class. The target check asks
`user_class_ids_with_capability('manage_flashcards')` through the caller-scoped client
(`ctx.supabase`), using the same capability lookup as RLS. Source read policies do not require
`manage_flashcards`.

## manage_surveys and run_polls

`manage_surveys` covers creating, editing, publishing, closing, deleting and assigning surveys,
plus survey templates (insert/update), survey series writes, and the
`create_survey_assignments` / `soft_delete_survey` / `reorder_surveys_in_series` RPCs (area 11).
Day one, only the default instructor role holds it. Create / publish / close / delete / series
controls follow `useCapability("manage_surveys")`. Left as views or student actions: staff and
student SELECT on surveys, assignments and responses; student response writes; template SELECT;
series SELECT; analytics RPCs. Exception: deleting a survey template stays creator-only, so
`manage_surveys` does not let you delete someone else's template.

`survey_assignments` action policies call `can_manage_survey_in_class` so the parent survey must
belong to the assignment's class and the caller must hold `manage_surveys` there. The helper is
SECURITY DEFINER to avoid RLS recursion with `surveys_select_students`, and the capability check
stops an unrelated signed-in user from learning survey/class membership through `/rpc`.

A survey can reference a series from another class (CLI `surveys.copy` keeps the source
`series_id`). That predates this capability work and is left for a follow-up.

`run_polls` covers creating, editing, opening, closing and deleting live polls, and staff writes
on `live_poll_responses` (area 11). Day one, the default instructor role, the default grader role
and every existing custom role hold it. Create / open / close / delete controls follow
`useCapability("run_polls")`. Left as views or student/anon actions: live and staff SELECT on
`live_polls`, staff SELECT on responses (a grader without `run_polls` can still read responses
and cannot change them), and the anon/student insert path through `can_access_poll_response`.

CLI `surveys.copy` requires active instructor or grader access in the source class and
`manage_surveys` in the target class. The target check uses the caller-scoped capability RPC,
including for dry runs. `assignments.copy` requires instructor access in the target class.

## help_students and manage_office_hours

`help_students` covers what staff do to help in office hours (area 10): updating and deleting help
requests (status and assignee), resolving or ending tickets through `finish_help_request`,
escalating through `escalate_help_request`, and reading queue health through `office_hours_queue_health`.
It also covers staff chat messages (`instructors_only`), staff
membership updates, creating moderation records, karma note writes, work-session inserts, joining
and leaving queues (`help_queue_assignments` writes), and creating/editing/deleting help queues.
Day one, the default instructor role, the default grader role and every existing custom role hold
it. Assign / resolve / end / escalate / moderate / karma controls and queue create/edit/delete follow
`useCapability("help_students")`. Helpers and policies that used to call
`authorizeforhelprequeststaff` also keep class admins (the admin role holds no capabilities by
design, so those checks OR the same `user_privileges.role = 'admin'` test the old helper used).

`manage_office_hours` covers instructor-only office hours configuration: help request templates
(insert/update/delete), instructor CRUD on `student_help_activity`, instructor update/delete of
moderation records, deleting (or updating another TA's) work sessions, and updating
`classes.office_hours_health_thresholds`. Day one, only the
default instructor role holds it. Template create/edit/delete and the templates settings page
follow `useCapability` / `useCapabilityOnceLoaded("manage_office_hours")`. Creating a moderation
action is allowed with either capability (matching the INSERT policies), and delete/update of
moderation and work sessions follow `manage_office_hours`. Queue Health Colors inputs and Save Colors
also require it. The classes column allowlist checks each changed column: a custom role with
`manage_office_hours` can update thresholds, but cannot change other class settings. Instructors
also need the capability to update thresholds.

The escalation rules still apply to capability holders and students. An ended (`closed`) ticket
cannot reopen. Direct updates cannot change `escalation_count`, `last_escalated_at`, or
`check_in_expires_at`; only the escalation RPCs update those fields on the caller's behalf.
Students can only change status from `open` or `in_progress` to `resolved`. The student check-in
RPC keeps staging's solo-request rule and locking. The staff dashboard fetches health cards and
red-queue alerts only when the feature is enabled and the caller holds `help_students`.

Left as views or student actions: all office-hours SELECT policies; student create/update of their
own requests; student chat, watchers, receipts and feedback; `authorizeforhelprequeststaff` and
`can_access_help_request` (staff can still read private requests without `help_students`);
video meeting session SELECT and service-role participation writes;
`create_help_request_with_participants` (class membership, not staff-only).

Graders could create and edit help queues and queue assignments before this capability work, so
those writes follow `help_students` rather than `manage_office_hours` (the plan's "configure
queues" row). The team should decide whether queue configuration should move to
`manage_office_hours`, which would take it away from default graders. CLI `help-requests close`
stays instructor-only for the same reason: switching it to `help_students` would give graders a
CLI path they did not have. Starting and ending a video meeting is still authorized by role in the
edge functions, so turning `help_students` off does not stop it; moving those functions to the
capability is left for a follow-up.
