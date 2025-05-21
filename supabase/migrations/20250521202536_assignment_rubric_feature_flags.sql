alter table "public"."assignments" add column "meta_grading_rubric_id" bigint;

alter table "public"."assignments" add column "self_review_rubric_id" bigint;

alter table "public"."assignments" add constraint "assignments_meta_grading_rubric_id_fkey" FOREIGN KEY (meta_grading_rubric_id) REFERENCES rubrics(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."assignments" validate constraint "assignments_meta_grading_rubric_id_fkey";

alter table "public"."assignments" add constraint "assignments_self_review_rubric_id_fkey" FOREIGN KEY (self_review_rubric_id) REFERENCES rubrics(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."assignments" validate constraint "assignments_self_review_rubric_id_fkey";


