ALTER TABLE "public"."tags" ADD COLUMN "creator_id" uuid NOT NULL default auth.uid();

DROP POLICY  "graders and instructors can view all class tags" ON "public"."tags";

DROP POLICY  "graders and instructors can update all class tags" ON "public"."tags";

DROP POLICY  "graders and instructors can delete all class tags" ON "public"."tags";

DROP POLICY  "graders and instructors can insert to class tags" ON "public"."tags";

DROP POLICY "users can view their visible tags for class" ON "public"."tags";

CREATE POLICY "graders and instructors can view class tags"
ON "public"."tags"
AS PERMISSIVE
FOR SELECT
USING (
   (authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id))
    AND (visible OR (auth.uid() = creator_id))
);

CREATE POLICY "graders and instructors can update class tags"
ON "public"."tags"
AS PERMISSIVE
FOR UPDATE
USING (
   (authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id))
    AND (visible OR (auth.uid() = creator_id))
);

CREATE POLICY "graders and instructors can delete class tags"
ON "public"."tags"
AS PERMISSIVE
FOR DELETE
USING (
   (authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id))
    AND (visible OR (auth.uid() = creator_id))
);

CREATE POLICY "graders and instructors can insert to class tags"
ON "public"."tags"
AS PERMISSIVE
FOR INSERT
WITH CHECK (
   (authorizeforclassgrader(class_id)
    OR authorizeforclassinstructor(class_id))
    AND (visible OR (auth.uid() = creator_id))
);

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_creator_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id");
