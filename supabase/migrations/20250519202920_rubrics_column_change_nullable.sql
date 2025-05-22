UPDATE public.rubrics set assignment_id=assignments.id FROM assignments where assignments.grading_rubric_id=rubrics.id;

alter table "public"."rubrics" alter column "assignment_id" set not null;


