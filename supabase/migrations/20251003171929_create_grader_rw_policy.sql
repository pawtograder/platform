CREATE POLICY "graders rw" ON "public"."autograder"
USING (
"public"."authorizeforclassgrader" (
    ( SELECT "assignments"."class_id"
        FROM "public"."assignments"
        WHERE ("assignments"."id" = "autograder"."id")
    )
        )
    );