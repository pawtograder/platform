-- Drop and recreate submissions_agg view to include review_graded status
DROP VIEW IF EXISTS "public"."submissions_agg";

CREATE OR REPLACE VIEW "public"."submissions_agg" WITH ("security_invoker"='true') AS
 SELECT "c"."profile_id",
    "p"."name",
    "p"."sortable_name",
    "p"."avatar_url",
    "groups"."name" AS "groupname",
    "c"."submissioncount",
    "c"."latestsubmissionid",
    "s"."id",
    "s"."created_at",
    "s"."assignment_id",
    "s"."profile_id" AS "user_id",
    "s"."released",
    "s"."sha",
    "s"."repository",
    "s"."run_attempt",
    "s"."run_number",
    "g"."score",
    "g"."ret_code",
    "g"."execution_time",
    CASE 
      WHEN "sr"."completed_at" IS NOT NULL AND "sr"."completed_by" IS NOT NULL THEN true
      ELSE false
    END AS "is_review_graded"
   FROM (((((( SELECT "count"("submissions"."id") AS "submissioncount",
            "max"("submissions"."id") AS "latestsubmissionid",
            "r"."private_profile_id" AS "profile_id"
           FROM (("public"."user_roles" "r"
             LEFT JOIN "public"."assignment_groups_members" "m" ON (("m"."profile_id" = "r"."private_profile_id")))
             LEFT JOIN "public"."submissions" ON ((("submissions"."profile_id" = "r"."private_profile_id") OR ("submissions"."assignment_group_id" = "m"."assignment_group_id"))))
          WHERE ("r"."disabled" = false)
          GROUP BY "submissions"."assignment_id", "r"."private_profile_id") "c"
     LEFT JOIN "public"."submissions" "s" ON (("s"."id" = "c"."latestsubmissionid")))
     LEFT JOIN "public"."assignment_groups" "groups" ON (("groups"."id" = "s"."assignment_group_id")))
     LEFT JOIN "public"."grader_results" "g" ON (("g"."submission_id" = "s"."id")))
     LEFT JOIN "public"."submission_reviews" "sr" ON (("sr"."id" = "s"."grading_review_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "c"."profile_id")));

ALTER VIEW "public"."submissions_agg" OWNER TO "postgres";
