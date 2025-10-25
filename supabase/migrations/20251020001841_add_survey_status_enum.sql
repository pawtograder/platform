alter table "public"."survey_templates" add column "class_id" bigint;

alter table "public"."survey_templates" add column "created_by" uuid;

alter table "public"."survey_templates" add column "description" text;

alter table "public"."survey_templates" add column "questions" jsonb;

alter table "public"."survey_templates" add column "version" integer default 1;

alter table "public"."surveys" add column "allow_response_editing" boolean default false;

alter table "public"."surveys" add column "created_by" text;

alter table "public"."surveys" add column "due_date" timestamp with time zone;

alter table "public"."surveys" add column "is_latest_version" boolean default true;

alter table "public"."surveys" add column "json" jsonb;

alter table "public"."surveys" add column "survey_id" uuid;

alter table "public"."surveys" add column "validation_errors" text;

alter table "public"."surveys" alter column "assigned_by" drop not null;

alter table "public"."surveys" alter column "class_section_id" drop not null;

CREATE INDEX idx_surveys_latest_version ON public.surveys USING btree (survey_id, is_latest_version) WHERE (is_latest_version = true);

CREATE INDEX idx_surveys_survey_id ON public.surveys USING btree (survey_id);

alter table "public"."survey_templates" add constraint "survey_templates_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE not valid;

alter table "public"."survey_templates" validate constraint "survey_templates_class_id_fkey";

alter table "public"."survey_templates" add constraint "survey_templates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) not valid;

alter table "public"."survey_templates" validate constraint "survey_templates_created_by_fkey";

-- The survey_status enum is already created in the previous migration
-- No additional enum creation needed


