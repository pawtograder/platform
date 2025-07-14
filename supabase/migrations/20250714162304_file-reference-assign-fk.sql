alter table "public"."help_request_file_references" add column "assignment_id" bigint not null;

alter table "public"."help_request_file_references" add constraint "help_request_file_references_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."help_request_file_references" validate constraint "help_request_file_references_assignment_id_fkey";


