# Capabilities and class roles

Status: **In progress** (#1010) · Migrations: `20261027120000_class_roles_and_capabilities.sql`, `20261030120000_protect_class_roles.sql`, `20261106120000_role_capabilities_broadcast.sql`, `20261106140000_assignments_save_by_capability.sql`, `20261108120000_review_assignments_by_capability.sql`, `20261112120000_custom_roles_copy_grader_role.sql`

A **capability** is one action, such as `manage_review_assignments`. A **class role** is a bundle
of capabilities in one class. Every class has four default roles (instructor, grader, student,
admin) and may have custom grader roles such as "Head TA". The UI and RLS both decide from these
tables, so a control is shown exactly when the database allows the action.

## What a user holds

In each class, a user holds the capabilities of their own class role (`user_roles.class_role_id`),
and nothing else.

- **Instructors, students and admins** are on their app role's default role.
- **Graders** are on the default grader role, or on a custom role such as "Head TA".
- **A new custom role starts as a copy of the default grader role.** The instructor then turns
  capabilities on or off. After that the two lists are separate: changing the default grader role
  doesn't change roles made earlier. So a custom role can hold more than a plain grader (a Head TA)
  or less (a course coordinator who doesn't grade).
- **Instructors can edit the default grader role.** The instructor, student and admin roles are fixed.
  The default grader role can't be renamed or deleted.
- Only graders can be on a custom role, and `manage_roles` is never on the grader role or a custom role.

`public.user_class_capabilities()` is the one place that applies this rule. It returns
`(class_id, capability)` for the signed-in user.

Every capability is on the default instructor role, so instructors can do everything and nobody
can be given more than an instructor. A role manager can only add a capability they hold in that
class to the default grader role or a custom role.

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
