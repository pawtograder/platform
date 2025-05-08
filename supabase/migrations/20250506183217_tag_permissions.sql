CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" NOT NULL,
    "visible" boolean NOT NULL,
    "class_id" bigint NOT NULL 
);


CREATE POLICY "graders and instructors CRUD on tags"
on "public"."tags"
as permissive
for all 
to public
using (
    authorizeforclassgrader(class_id) OR authorizeforclassinstructor(class_id)
);

ALTER TABLE "public"."user_roles"
ADD COLUMN "tag_ids" bigint[];

CREATE POLICY "users can view their visible tags"
ON "public"."user_roles"
AS PERMISSIVE
FOR SELECT
USING (
    authorizeForProfile(user_id) AND 
    (EXISTS (
        SELECT 1 FROM "public"."tags" 
        WHERE "public"."tags".id = ANY("public"."user_roles".tag_ids) 
        AND "public"."tags".visible = true
    ))
);
