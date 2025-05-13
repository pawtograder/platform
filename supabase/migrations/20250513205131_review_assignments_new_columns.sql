drop policy "Assignees can view their own review assignments" on "public"."review_assignments";

alter table "public"."review_assignments" add column "max_allowable_late_tokens" integer not null default 0;

alter table "public"."review_assignments" add column "release_date" timestamp with time zone;

alter table "public"."review_assignments" add constraint "review_assignments_max_allowable_late_tokens_check" CHECK ((max_allowable_late_tokens >= 0)) not valid;

alter table "public"."review_assignments" validate constraint "review_assignments_max_allowable_late_tokens_check";

alter table "public"."review_assignments" add constraint "review_assignments_release_before_due_check" CHECK (((release_date IS NULL) OR (release_date <= due_date))) not valid;

alter table "public"."review_assignments" validate constraint "review_assignments_release_before_due_check";

create policy "Assignees can view their own review assignments"
on "public"."review_assignments"
as permissive
for select
to authenticated
using (((assignee_profile_id = ( SELECT user_roles.private_profile_id
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.class_id = review_assignments.class_id)))) AND ((release_date IS NULL) OR (timezone('utc'::text, now()) >= release_date))));



