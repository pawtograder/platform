create type "public"."rubric_check_student_visibility" as enum ('always', 'if_released', 'if_applied', 'never');

drop policy "authorizeforclass" on "public"."rubric_checks";

alter table "public"."rubric_checks" add column "student_visibility" rubric_check_student_visibility not null default 'always'::rubric_check_student_visibility;

create policy "authorizeforclass"
on "public"."rubric_checks"
as permissive
for select
to public
using ((EXISTS ( SELECT 1
   FROM (rubric_criteria rc
     JOIN rubrics r ON ((rc.rubric_id = r.id)))
  WHERE (((rc.id = rubric_checks.rubric_criteria_id) AND authorizeforclass(r.class_id) AND authorizeforclassgrader(r.class_id)) OR ((r.is_private = false) AND ((rubric_checks.student_visibility = 'always'::rubric_check_student_visibility) OR ((rubric_checks.student_visibility = 'if_released'::rubric_check_student_visibility) AND (EXISTS ( SELECT 1
           FROM (submissions s
             JOIN submission_reviews sr ON ((s.id = sr.submission_id)))
          WHERE ((s.assignment_id = r.assignment_id) AND sr.released AND ((s.profile_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
                   FROM assignment_groups_members agm
                  WHERE ((agm.assignment_group_id = s.assignment_group_id) AND (agm.profile_id = ( SELECT auth.uid() AS uid)))))))))) OR ((rubric_checks.student_visibility = 'if_applied'::rubric_check_student_visibility) AND ((EXISTS ( SELECT 1
           FROM ((submission_comments sc
             JOIN submissions s ON ((sc.submission_id = s.id)))
             JOIN submission_reviews sr ON ((s.id = sr.submission_id)))
          WHERE ((sc.rubric_check_id = rubric_checks.id) AND sr.released AND ((s.profile_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
                   FROM assignment_groups_members agm
                  WHERE ((agm.assignment_group_id = s.assignment_group_id) AND (agm.profile_id = ( SELECT auth.uid() AS uid))))))))) OR (EXISTS ( SELECT 1
           FROM ((submission_artifact_comments sac
             JOIN submissions s ON ((sac.submission_id = s.id)))
             JOIN submission_reviews sr ON ((s.id = sr.submission_id)))
          WHERE ((sac.rubric_check_id = rubric_checks.id) AND sr.released AND ((s.profile_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
                   FROM assignment_groups_members agm
                  WHERE ((agm.assignment_group_id = s.assignment_group_id) AND (agm.profile_id = ( SELECT auth.uid() AS uid)))))))))))))))));



