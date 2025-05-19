alter table "public"."rubrics" add column "assignment_id" bigint;

alter table "public"."rubrics" add constraint "rubrics_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."rubrics" validate constraint "rubrics_assignment_id_fkey";


