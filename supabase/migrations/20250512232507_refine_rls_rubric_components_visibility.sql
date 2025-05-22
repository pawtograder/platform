drop policy "authorizeforclass" on "public"."rubric_checks";

drop policy "instructors CRUD" on "public"."rubric_checks";

drop policy "authorizeforclass" on "public"."rubric_parts";

drop policy "instructors CRUD" on "public"."rubric_parts";

drop policy "authorizeforclass" on "public"."rubrics";

create policy "authorizeforclass"
on "public"."rubric_checks"
as permissive
for select
to public
using ((EXISTS ( SELECT 1
   FROM (rubric_criteria rc
     JOIN rubrics r ON ((rc.rubric_id = r.id)))
  WHERE ((rc.id = rubric_checks.rubric_criteria_id) AND authorizeforclass(r.class_id) AND (authorizeforclassgrader(r.class_id) OR (r.is_private = false))))));


create policy "instructors CRUD"
on "public"."rubric_checks"
as permissive
for all
to public
using ((EXISTS ( SELECT 1
   FROM (rubric_criteria rc
     JOIN rubrics r ON ((rc.rubric_id = r.id)))
  WHERE ((rc.id = rubric_checks.rubric_criteria_id) AND authorizeforclassgrader(r.class_id)))));


create policy "authorizeforclass"
on "public"."rubric_parts"
as permissive
for select
to public
using ((EXISTS ( SELECT 1
   FROM rubrics r
  WHERE ((r.id = rubric_parts.rubric_id) AND authorizeforclass(r.class_id) AND (authorizeforclassgrader(r.class_id) OR (r.is_private = false))))));


create policy "instructors CRUD"
on "public"."rubric_parts"
as permissive
for all
to public
using ((EXISTS ( SELECT 1
   FROM rubrics r
  WHERE ((r.id = rubric_parts.rubric_id) AND authorizeforclassgrader(r.class_id)))));


create policy "authorizeforclass"
on "public"."rubrics"
as permissive
for select
to public
using ((authorizeforclass(class_id) AND (authorizeforclassgrader(class_id) OR (is_private = false))));



