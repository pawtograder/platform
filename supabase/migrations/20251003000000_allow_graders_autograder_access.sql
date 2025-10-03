-- Allow graders to view autograder records
-- Change policy from authorizeforclassinstructor (instructors only) to authorizeforclassgrader (instructors + graders)

-- Drop the existing policy
DROP POLICY IF EXISTS "instructors rw" ON "public"."autograder";

-- Create new policy that allows both instructors and graders to read/write
CREATE POLICY "instructors and graders rw" ON "public"."autograder" 
USING (
  "public"."authorizeforclassgrader"(
    ( SELECT "assignments"."class_id"
      FROM "public"."assignments"
      WHERE ("assignments"."id" = "autograder"."id")
    )
  )
);
