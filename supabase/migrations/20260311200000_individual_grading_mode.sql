-- Add individual_grading_mode to rubric_parts
-- When true, the rubric part is graded per-student in a group submission
alter table "public"."rubric_parts" add column "is_individual_grading" boolean not null default false;

-- Add individual_scores JSONB to submission_reviews
-- Stores per-student score breakdown: {"profile_id": score, ...}
alter table "public"."submission_reviews" add column "individual_scores" jsonb;

-- Add target_student_profile_id to submission_comments
-- For individual grading: which student this comment/check applies to
alter table "public"."submission_comments" add column "target_student_profile_id" uuid;
alter table "public"."submission_comments" add constraint "submission_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) not valid;
alter table "public"."submission_comments" validate constraint "submission_comments_target_student_profile_id_fkey";

-- Add target_student_profile_id to submission_file_comments
alter table "public"."submission_file_comments" add column "target_student_profile_id" uuid;
alter table "public"."submission_file_comments" add constraint "submission_file_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) not valid;
alter table "public"."submission_file_comments" validate constraint "submission_file_comments_target_student_profile_id_fkey";

-- Add target_student_profile_id to submission_artifact_comments
alter table "public"."submission_artifact_comments" add column "target_student_profile_id" uuid;
alter table "public"."submission_artifact_comments" add constraint "submission_artifact_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) not valid;
alter table "public"."submission_artifact_comments" validate constraint "submission_artifact_comments_target_student_profile_id_fkey";

-- Update the submissionreviewrecompute trigger to also compute individual_scores
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  calculated_score int;
  individual_scores_result jsonb;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
begin
  -- Avoid re-entrant work when our own UPDATEs fire triggers (lost-update races)
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  if 'rubric_check_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    if  NEW.rubric_check_id is null and (OLD is null OR OLD.rubric_check_id is null) then 
     return NEW;
    end if;
  end if;

  if 'submission_review_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    if NEW.submission_review_id is null then
      return NEW;
    end if;
    existing_submission_review_id = NEW.submission_review_id;
  else
    select * into the_submission from public.submissions where id=NEW.submission_id;
    if the_submission.submission_review_id is null then
      INSERT INTO submission_reviews (total_score,tweak, class_id, submission_id, name) VALUES(0,0, the_submission.class_id, the_submission.id, 'Grading') RETURNING id into existing_submission_review_id;
      UPDATE public.submissions set submission_review_id=existing_submission_review_id where id=the_submission.id;
    else
      existing_submission_review_id = the_submission.submission_review_id;
    end if;
  end if;

  -- Calculate total score (existing logic)
  select sum(score) into calculated_score from (select c.id,c.name,
  case
    when c.is_additive then LEAST(sum(sfc.points),c.total_points)
    else GREATEST(c.total_points - sum(sfc.points), 0)
  end as score
  from public.submission_file_comments sfc
  inner join public.rubric_checks ch on ch.id=sfc.rubric_check_id
  inner join public.rubric_criteria c on c.id=ch.rubric_criteria_id
  where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null group by c.id

  union
  select -1 as id, 'autograder' as name, r.score from grader_results r where r.submission_id=NEW.submission_id
  union
  select c.id,c.name,
  case
    when c.is_additive then LEAST(sum(sfc.points),c.total_points)
    else GREATEST(c.total_points - sum(sfc.points), 0)
    end as score
  from public.submission_comments sfc
  inner join public.rubric_checks ch on ch.id=sfc.rubric_check_id
  inner join public.rubric_criteria c on c.id=ch.rubric_criteria_id
  where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null group by c.id
  ) as combo;

  UPDATE public.submission_reviews SET total_score=calculated_score WHERE id=existing_submission_review_id;

  -- Calculate individual scores for individual grading parts
  -- Get all distinct target_student_profile_ids from comments for this review
  WITH student_scores AS (
    SELECT
      target_student_profile_id,
      sum(score) as student_score
    FROM (
      -- File comments for individual grading parts
      SELECT sfc.target_student_profile_id, 
        CASE
          WHEN c.is_additive THEN LEAST(sum(sfc.points), c.total_points)
          ELSE GREATEST(c.total_points - sum(sfc.points), 0)
        END as score
      FROM public.submission_file_comments sfc
      INNER JOIN public.rubric_checks ch ON ch.id = sfc.rubric_check_id
      INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
      INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
      WHERE sfc.submission_review_id = existing_submission_review_id
        AND sfc.deleted_at IS NULL
        AND sfc.target_student_profile_id IS NOT NULL
        AND rp.is_individual_grading = true
      GROUP BY sfc.target_student_profile_id, c.id, c.is_additive, c.total_points

      UNION ALL

      -- Submission comments for individual grading parts
      SELECT sc.target_student_profile_id,
        CASE
          WHEN c.is_additive THEN LEAST(sum(sc.points), c.total_points)
          ELSE GREATEST(c.total_points - sum(sc.points), 0)
        END as score
      FROM public.submission_comments sc
      INNER JOIN public.rubric_checks ch ON ch.id = sc.rubric_check_id
      INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
      INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
      WHERE sc.submission_review_id = existing_submission_review_id
        AND sc.deleted_at IS NULL
        AND sc.target_student_profile_id IS NOT NULL
        AND rp.is_individual_grading = true
      GROUP BY sc.target_student_profile_id, c.id, c.is_additive, c.total_points
    ) AS individual_combo
    GROUP BY target_student_profile_id
  )
  SELECT jsonb_object_agg(target_student_profile_id, student_score)
  INTO individual_scores_result
  FROM student_scores;

  -- Only set individual_scores if there are any individual grading results
  IF individual_scores_result IS NOT NULL THEN
    UPDATE public.submission_reviews 
    SET individual_scores = individual_scores_result 
    WHERE id = existing_submission_review_id;
  END IF;

  return NEW;
end;
$function$;

-- Update submissions_with_grades_for_assignment view to include individual_scores
-- Preserves structure from 20250907011252_students-move-sections (disabled filter, class_id, assignment_id in extensions, sections, assignment_slug)
-- Adds rev.individual_scores and uses DISTINCT ON for grader_results to avoid duplicate rows from reruns
DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment;

CREATE OR REPLACE VIEW "public"."submissions_with_grades_for_assignment" WITH ("security_invoker"='true') AS
 WITH "assignment_students" AS (
         SELECT DISTINCT "ur"."id" AS "user_role_id",
            "ur"."private_profile_id",
            "a"."class_id",
            "a"."id" AS "assignment_id",
            "a"."due_date",
            "a"."slug" AS "assignment_slug",
            "ur"."class_section_id",
            "ur"."lab_section_id"
           FROM ("public"."assignments" "a"
             JOIN "public"."user_roles" "ur" ON ((("ur"."class_id" = "a"."class_id") AND ("ur"."role" = 'student'::"public"."app_role") AND ("ur"."disabled" = false))))
        ), "individual_submissions" AS (
         SELECT "ast"."user_role_id",
            "ast"."private_profile_id",
            "ast"."class_id",
            "ast"."assignment_id",
            "s_1"."id" AS "submission_id",
            NULL::bigint AS "assignment_group_id",
            "ast"."due_date",
            "ast"."assignment_slug",
            "ast"."class_section_id",
            "ast"."lab_section_id"
           FROM ("assignment_students" "ast"
             JOIN "public"."submissions" "s_1" ON ((("s_1"."assignment_id" = "ast"."assignment_id") AND ("s_1"."profile_id" = "ast"."private_profile_id") AND ("s_1"."is_active" = true) AND ("s_1"."assignment_group_id" IS NULL))))
        ), "group_submissions" AS (
         SELECT "ast"."user_role_id",
            "ast"."private_profile_id",
            "ast"."class_id",
            "ast"."assignment_id",
            "s_1"."id" AS "submission_id",
            "agm"."assignment_group_id",
            "ast"."due_date",
            "ast"."assignment_slug",
            "ast"."class_section_id",
            "ast"."lab_section_id"
           FROM (("assignment_students" "ast"
             JOIN "public"."assignment_groups_members" "agm" ON ((("agm"."assignment_id" = "ast"."assignment_id") AND ("agm"."profile_id" = "ast"."private_profile_id"))))
             JOIN "public"."submissions" "s_1" ON ((("s_1"."assignment_id" = "ast"."assignment_id") AND ("s_1"."assignment_group_id" = "agm"."assignment_group_id") AND ("s_1"."is_active" = true))))
        ), "all_submissions" AS (
         SELECT "individual_submissions"."user_role_id",
            "individual_submissions"."private_profile_id",
            "individual_submissions"."class_id",
            "individual_submissions"."assignment_id",
            "individual_submissions"."submission_id",
            "individual_submissions"."assignment_group_id",
            "individual_submissions"."due_date",
            "individual_submissions"."assignment_slug",
            "individual_submissions"."class_section_id",
            "individual_submissions"."lab_section_id"
           FROM "individual_submissions"
        UNION ALL
         SELECT "group_submissions"."user_role_id",
            "group_submissions"."private_profile_id",
            "group_submissions"."class_id",
            "group_submissions"."assignment_id",
            "group_submissions"."submission_id",
            "group_submissions"."assignment_group_id",
            "group_submissions"."due_date",
            "group_submissions"."assignment_slug",
            "group_submissions"."class_section_id",
            "group_submissions"."lab_section_id"
           FROM "group_submissions"
        ), "due_date_extensions" AS (
         SELECT COALESCE("ade"."student_id", "ag_1"."profile_id") AS "effective_student_id",
            COALESCE("ade"."assignment_group_id", "ag_1"."assignment_group_id") AS "effective_assignment_group_id",
            "ade"."assignment_id",
            "sum"("ade"."tokens_consumed") AS "tokens_consumed",
            "sum"("ade"."hours") AS "hours"
           FROM ("public"."assignment_due_date_exceptions" "ade"
             LEFT JOIN "public"."assignment_groups_members" "ag_1" ON (("ade"."assignment_group_id" = "ag_1"."assignment_group_id")))
          GROUP BY COALESCE("ade"."student_id", "ag_1"."profile_id"), COALESCE("ade"."assignment_group_id", "ag_1"."assignment_group_id"), "ade"."assignment_id"
        ), "submissions_with_extensions" AS (
         SELECT "asub"."user_role_id",
            "asub"."private_profile_id",
            "asub"."class_id",
            "asub"."assignment_id",
            "asub"."submission_id",
            "asub"."assignment_group_id",
            "asub"."due_date",
            "asub"."assignment_slug",
            COALESCE("dde"."tokens_consumed", (0)::bigint) AS "tokens_consumed",
            COALESCE("dde"."hours", (0)::bigint) AS "hours",
            "asub"."class_section_id",
            "asub"."lab_section_id"
           FROM ("all_submissions" "asub"
             LEFT JOIN "due_date_extensions" "dde" ON ((("dde"."effective_student_id" = "asub"."private_profile_id") AND ("dde"."assignment_id" = "asub"."assignment_id") AND ((("asub"."assignment_group_id" IS NULL) AND ("dde"."effective_assignment_group_id" IS NULL)) OR ("asub"."assignment_group_id" = "dde"."effective_assignment_group_id")))))
        )
 SELECT "swe"."user_role_id" AS "id",
    "swe"."class_id",
    "swe"."assignment_id",
    "p"."id" AS "student_private_profile_id",
    "p"."name",
    "p"."sortable_name",
    "s"."id" AS "activesubmissionid",
    "s"."created_at",
    "s"."released",
    "s"."repository",
    "s"."sha",
    "rev"."total_autograde_score" AS "autograder_score",
    "rev"."grader",
    "rev"."meta_grader",
    "rev"."total_score",
    "rev"."tweak",
    "rev"."completed_by",
    "rev"."completed_at",
    "rev"."checked_at",
    "rev"."checked_by",
    "rev"."individual_scores",
    "graderprofile"."name" AS "assignedgradername",
    "metagraderprofile"."name" AS "assignedmetagradername",
    "completerprofile"."name" AS "gradername",
    "checkgraderprofile"."name" AS "checkername",
    "ag"."name" AS "groupname",
    "swe"."tokens_consumed",
    "swe"."hours",
    "swe"."due_date",
    ("swe"."due_date" + ('01:00:00'::interval * ("swe"."hours")::double precision)) AS "late_due_date",
    "ar"."grader_sha",
    "ar"."grader_action_sha",
    "swe"."assignment_slug",
    "swe"."class_section_id",
    "cs"."name" AS "class_section_name",
    "swe"."lab_section_id",
    "ls"."name" AS "lab_section_name"
   FROM ((((((((((("submissions_with_extensions" "swe"
     JOIN "public"."profiles" "p" ON (("p"."id" = "swe"."private_profile_id")))
     JOIN "public"."submissions" "s" ON (("s"."id" = "swe"."submission_id")))
     LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
     LEFT JOIN (
        SELECT DISTINCT ON ("submission_id")
            "id", "submission_id", "grader_sha", "grader_action_sha"
        FROM "public"."grader_results"
        WHERE "autograder_regression_test" IS NULL AND "rerun_for_submission_id" IS NULL
        ORDER BY "submission_id", "id" DESC
    ) "ar" ON (("ar"."submission_id" = "s"."id")))
     LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "swe"."assignment_group_id")))
     LEFT JOIN "public"."profiles" "completerprofile" ON (("completerprofile"."id" = "rev"."completed_by")))
     LEFT JOIN "public"."profiles" "graderprofile" ON (("graderprofile"."id" = "rev"."grader")))
     LEFT JOIN "public"."profiles" "metagraderprofile" ON (("metagraderprofile"."id" = "rev"."meta_grader")))
     LEFT JOIN "public"."profiles" "checkgraderprofile" ON (("checkgraderprofile"."id" = "rev"."checked_by")))
     LEFT JOIN "public"."class_sections" "cs" ON (("cs"."id" = "swe"."class_section_id")))
     LEFT JOIN "public"."lab_sections" "ls" ON (("ls"."id" = "swe"."lab_section_id")));
