ALTER TABLE "public"."self_review_settings" RENAME TO "assignment_self_review_settings";

DROP POLICY "anyone in the course can view self review settings" ON "public"."assignment_self_review_settings";

CREATE POLICY "anyone in the course can view self review settings" 
ON "public"."assignment_self_review_settings"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
    authorizeforclass(class_id)
);
