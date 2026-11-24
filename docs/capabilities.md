# Capabilities and class roles

Status: **In progress** (#1010) · Migrations: `20261027120000_class_roles_and_capabilities.sql`, `20261030120000_protect_class_roles.sql`, `20261106120000_role_capabilities_broadcast.sql`, `20261106140000_assignments_save_by_capability.sql`, `20261108120000_review_assignments_by_capability.sql`, `20261119120000_custom_roles_copy_grader_role.sql`, `20261121160200_repository_status_by_capability.sql`, `20261122110000_gradebook_by_capability.sql`, `20261122110100_gradebook_view_by_capability.sql`, `20261122210300_roster_by_capability.sql`, `20261122210400_class_sections_rename_by_capability.sql`, `20261122210500_enrollments_by_capability.sql`, `20261122210600_groups_by_capability.sql`, `20261123150300_rubrics_by_capability.sql`, `20261123160000_announcements_by_capability.sql`, `20261124130000_flashcards_manage_by_capability.sql`

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

A CLI command (`supabase/functions/cli/`) has no Authorization header: it runs on the service role
with the caller's user id. Use `assertUserHasClassCapability(userId, class_id, "manage_rubrics")` from
`cli/utils/auth.ts`, which asks the same function on a client minted for that user.

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

   Use the query above only if every grader could do the action before. If the old rule was
   conditional (only in some classes, or only for some roles), add the capability only to the roles
   that met it, so no one gains access the old rule denied.

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

## Emailer: send_announcements

`send_announcements` is the Emailer (Course Settings > Emailer). There is no separate announcements
feature; "Announcements" is only a discussion topic icon. It is on the default instructor role only.

- It covers reading and creating `email_batches` and `emails` (reading too, because the Emailer
  reads a new batch back to get its id), the Emailer menu item, and the Emailer page, which sends
  people without it to the course home page.
- Changing and deleting emails and batches stay instructor-only. The Emailer only creates and
  reads, and neither table records who sent a batch.
- A new email must go to someone enrolled in its class (a `user_roles` row in the same
  class), and its batch must belong to the same class. The `email_notifications()` trigger turns
  each email into a notification for its recipient. This limits the recipient only: Cc and
  Reply-to can be any address, as the Emailer allows.
- Discussion topics are not part of it.

**Pages: hide the button, or send the person away.** A page whose only purpose is one capability's
action sends people without it somewhere useful: its server `layout.tsx` checks
`userHasClassCapability(course_id, "...")` (in `lib/ssrUtils.ts`) and calls `redirect`, as `/new` and
`/edit` do for `manage_assignments` and `/rubric` does for `manage_rubrics`. A page that also shows
things to look at stays open and only hides its action buttons with `useCapability`, as Manage
Groups does for `publish_groups`. `RequireManageReviews` is an older client-side version of the
redirect, used by Bulk Assign and Reassign.

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
decks. It requires `manage_flashcards` only in the target class, through
`assertUserHasClassCapability(userId, targetClass.id, "manage_flashcards")`, the same capability
lookup RLS uses. Source read policies do not require `manage_flashcards`.

## Groups: publish_groups and manage_groups

Manage Groups uses two capabilities. Both are on the default instructor role only.

- **`publish_groups`**: stage group changes (Create New Group, Bulk Create, Tweak a Group, Edit
  Group, Move Student) and publish them. For now only the screen checks it: a TA with
  `publish_groups` can stage changes and press Publish, but `publish_assignment_group_changes`
  still lets only instructors (and site admins) publish, until #1297 moves it to the capability.
- **`manage_groups`**: changes that save at once, without staging: set a group's mentor, rename a
  group (the `assignment_groups` UPDATE policy; the page has no Rename button), and Copy Groups
  from another assignment (`copy_groups_from_assignment`). A group can't move to another
  assignment or class, for anyone. Copy also turns off the per-row repo
  sync in `sync_repos_after_assignment_group_change` and syncs once at the end; that trigger honors
  the flag for a caller with `manage_groups`.

Anyone enrolled in a class can read that class's group memberships (`assignment_groups_members`).
Before `20261122210600` the policy compared a class to itself, so it let anyone enrolled in any
class read every class's memberships.

## Roster: manage_roster

`manage_roster` covers lab sections, class section names and students on the Enrollments page. It is
on the default instructor role only.

- **Lab sections:** creating, changing and deleting `lab_sections`, `lab_section_meetings` and
  `lab_section_leaders`, and the lab sections page (without it, the page sends you to the lab
  roster). A meeting's lab section, and a leader's profile and lab section, must be in the row's
  class, for everyone.
  A lab section's `sis_crn` stays instructor-only (`guard_lab_section_sis_crn`): SIS sync enrolls
  that SIS section's roster with their SIS roles, so whoever sets it could make people staff. The
  same trigger stops anyone moving a lab section to another class from the API.
- **Class sections:** `update_class_section_name()`. It still changes only the name.
- **Enrollments, students only:** someone with `manage_roster` who isn't an instructor of the class
  can remove a student, change a student's SIS sync override, cancel a pending student invitation,
  and add a student who isn't in the class yet (`enrollments-add`). They can never touch a grader or
  instructor row, change anyone's role or `class_role_id` (their own included), or add or invite a
  grader or instructor. The `guard_roster_manager_update` trigger limits them to `disabled` and
  `sis_sync_opt_out` on a student's `user_roles` row, and to `status` on a student invitation.
- **Instructor-only for now:** creating invitations (the auto-accept trigger can re-enable an
  existing grader or instructor), Edit role, Edit profile, CSV import, Canvas/SIS/LTI sync and admin
  import. Tags are unchanged (any staff).
