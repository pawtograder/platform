CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" uuid NOT NULL PRIMARY KEY,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" NOT NULL,
    "visible" boolean NOT NULL,
    "profile_id" uuid NOT NULL REFERENCES "public"."profiles"(id), 
    "class_id" bigint NOT NULL REFERENCES "public"."classes"(id)
);

alter table "public"."tags" enable row level security;

CREATE POLICY "graders and instructors can view all class tags"
ON "public"."tags"
AS PERMISSIVE
FOR SELECT
USING (
    authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id)
);

CREATE POLICY "graders and instructors can update all class tags"
ON "public"."tags"
AS PERMISSIVE
FOR UPDATE
USING (
    authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id)
);

CREATE POLICY "graders and instructors can delete all class tags"
ON "public"."tags"
AS PERMISSIVE
FOR DELETE
USING (
    authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id)
);

 CREATE POLICY "graders and instructors can insert to class tags"
ON "public"."tags"
AS PERMISSIVE
FOR INSERT
WITH CHECK (
    authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id)
);


CREATE POLICY "users can view their visible tags for class"
ON "public"."tags"
AS PERMISSIVE
FOR SELECT
USING (
    visible = true AND 
    authorizeforprofile("profile_id") AND
    authorizeforclass("class_id") 
);