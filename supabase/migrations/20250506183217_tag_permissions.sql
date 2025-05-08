CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" uuid NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" NOT NULL,
    "visible" boolean NOT NULL,
    "user_id" uuid NOT NULL, 
    "class_id" bigint NOT NULL
);

alter table "public"."tags" enable row level security;

CREATE POLICY "graders and instructors CRUD on class tags"
on "public"."tags"
as permissive
for all 
to public
using (
    authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id)
);

CREATE POLICY "users can view their visible tags for class"
ON "public"."tags"
AS PERMISSIVE
FOR SELECT
USING (n
    visible = true AND 
    user_id = auth.uid() AND
    authorizeforclass("class_id") 
);