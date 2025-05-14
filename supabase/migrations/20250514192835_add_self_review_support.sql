alter table "public"."assignments" add column "self_rubric_id" bigint;

alter table "public"."assignments" add constraint "assignments_self_rubric_id_fkey" FOREIGN KEY (self_rubric_id) REFERENCES rubrics(id) not valid;

alter table "public"."assignments" validate constraint "assignments_self_rubric_id_fkey";

-- add column to checks for submission comment regex

alter table "public"."rubric_checks" add column "comment_regex" text;