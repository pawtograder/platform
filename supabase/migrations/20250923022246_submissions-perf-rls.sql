-- Performance optimizations for slow rubric/submission query
-- Addresses 21+ second query execution time by adding critical indices and optimizing RLS

-- 1. Critical composite index for rubric_checks with submission visibility filtering
-- This addresses the main bottleneck: rubric_checks scan taking 903ms × 24 loops = 21.7s
CREATE INDEX IF NOT EXISTS idx_rubric_checks_criteria_visibility_covering 
ON rubric_checks (rubric_criteria_id, student_visibility) 
INCLUDE (id, name, description, "group", ordinal, file, is_annotation, max_annotations, class_id);

-- Precise support index for authorize_for_submission group membership path
-- Speeds up lookups: assignment_groups_members.assignment_group_id + profile_id
CREATE INDEX IF NOT EXISTS idx_assignment_groups_members_group_profile
ON public.assignment_groups_members (assignment_group_id, profile_id);

-- Support the set-based rubric "if_released" semi-join
CREATE INDEX IF NOT EXISTS idx_submissions_assignment_profile
ON public.submissions (assignment_id, profile_id)
INCLUDE (id, assignment_group_id);

CREATE INDEX IF NOT EXISTS idx_submissions_assignment_group
ON public.submissions (assignment_id, assignment_group_id)
INCLUDE (id);


-- Replace submissions SELECT RLS with set-based, user_privileges-only policy
ALTER POLICY "Instructors and graders can view all submissions in class, stud" ON public.submissions
USING (
  (
    profile_id IN (
      SELECT up.private_profile_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
    )
  )
  OR (
    class_id IN (
      SELECT up.class_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
    )
  )
  OR (
    assignment_group_id IS NOT NULL AND assignment_group_id IN (
      SELECT DISTINCT agm.assignment_group_id
      FROM public.assignment_groups_members agm
      JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
      WHERE upg.user_id = auth.uid()
    )
  )
);

-- Switch inlined comment policies to user_privileges for ownership/group checks
ALTER POLICY "students view own, instructors and graders view all" ON public.submission_comments
USING ((
  (class_id IN (
    SELECT up.class_id FROM public.user_privileges up
    WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
  ))
  OR (
    released AND EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = submission_comments.submission_id
        AND (
          s.profile_id IN (
            SELECT up.private_profile_id FROM public.user_privileges up
            WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
          )
          OR (
            s.assignment_group_id IS NOT NULL AND s.assignment_group_id IN (
              SELECT DISTINCT agm.assignment_group_id
              FROM public.assignment_groups_members agm
              JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
              WHERE upg.user_id = auth.uid()
            )
          )
        )
    )
  )
  OR (
    submission_review_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM public.submission_reviews sr
        JOIN public.submissions s ON s.id = sr.submission_id
        WHERE sr.id = submission_comments.submission_review_id
          AND sr.released = true
          AND (
            s.profile_id IN (
              SELECT up.private_profile_id FROM public.user_privileges up
              WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
            )
            OR (
              s.assignment_group_id IS NOT NULL AND s.assignment_group_id IN (
                SELECT DISTINCT agm.assignment_group_id
                FROM public.assignment_groups_members agm
                JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
                WHERE upg.user_id = auth.uid()
              )
            )
          )
      )
      OR EXISTS (
        SELECT 1 FROM public.review_assignments ra
        JOIN public.user_privileges up ON up.private_profile_id = ra.assignee_profile_id
        WHERE ra.submission_review_id = submission_comments.submission_review_id
          AND up.user_id = auth.uid()
      )
    )
  )
));

ALTER POLICY "students view own, instructors and graders view all" ON public.submission_file_comments
USING ((
  (class_id IN (
    SELECT up.class_id FROM public.user_privileges up
    WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
  ))
  OR (
    released AND EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = submission_file_comments.submission_id
        AND (
          s.profile_id IN (
            SELECT up.private_profile_id FROM public.user_privileges up
            WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
          )
          OR (
            s.assignment_group_id IS NOT NULL AND s.assignment_group_id IN (
              SELECT DISTINCT agm.assignment_group_id
              FROM public.assignment_groups_members agm
              JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
              WHERE upg.user_id = auth.uid()
            )
          )
        )
    )
  )
  OR (
    submission_review_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM public.submission_reviews sr
        JOIN public.submissions s ON s.id = sr.submission_id
        WHERE sr.id = submission_file_comments.submission_review_id
          AND sr.released = true
          AND (
            s.profile_id IN (
              SELECT up.private_profile_id FROM public.user_privileges up
              WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
            )
            OR (
              s.assignment_group_id IS NOT NULL AND s.assignment_group_id IN (
                SELECT DISTINCT agm.assignment_group_id
                FROM public.assignment_groups_members agm
                JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
                WHERE upg.user_id = auth.uid()
              )
            )
          )
      )
      OR EXISTS (
        SELECT 1 FROM public.review_assignments ra
        JOIN public.user_privileges up ON up.private_profile_id = ra.assignee_profile_id
        WHERE ra.submission_review_id = submission_file_comments.submission_review_id
          AND up.user_id = auth.uid()
      )
    )
  )
));

ALTER POLICY "students view own, instructors and graders view all" ON public.submission_artifact_comments
USING ((
  (class_id IN (
    SELECT up.class_id FROM public.user_privileges up
    WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
  ))
  OR (
    released AND EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = submission_artifact_comments.submission_id
        AND (
          s.profile_id IN (
            SELECT up.private_profile_id FROM public.user_privileges up
            WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
          )
          OR (
            s.assignment_group_id IS NOT NULL AND s.assignment_group_id IN (
              SELECT DISTINCT agm.assignment_group_id
              FROM public.assignment_groups_members agm
              JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
              WHERE upg.user_id = auth.uid()
            )
          )
        )
    )
  )
  OR (
    submission_review_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM public.submission_reviews sr
        JOIN public.submissions s ON s.id = sr.submission_id
        WHERE sr.id = submission_artifact_comments.submission_review_id
          AND sr.released = true
          AND (
            s.profile_id IN (
              SELECT up.private_profile_id FROM public.user_privileges up
              WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
            )
            OR (
              s.assignment_group_id IS NOT NULL AND s.assignment_group_id IN (
                SELECT DISTINCT agm.assignment_group_id
                FROM public.assignment_groups_members agm
                JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
                WHERE upg.user_id = auth.uid()
              )
            )
          )
      )
      OR EXISTS (
        SELECT 1 FROM public.review_assignments ra
        JOIN public.user_privileges up ON up.private_profile_id = ra.assignee_profile_id
        WHERE ra.submission_review_id = submission_artifact_comments.submission_review_id
          AND up.user_id = auth.uid()
      )
    )
  )
));
-- Inline SELECT-based RLS: remove function calls from rubric_checks student policy
ALTER POLICY "students see only based on visibility" ON "public"."rubric_checks"
USING (
  EXISTS (
    SELECT 1
    FROM "public"."rubric_criteria" rc
    JOIN "public"."rubrics" r ON r.id = rc.rubric_id
    WHERE rc.id = rubric_checks.rubric_criteria_id
      AND EXISTS (
        SELECT 1 FROM "public"."user_privileges" up
        WHERE up.user_id = auth.uid()
          AND up.class_id = r.class_id
      )
      AND r.is_private = false
      AND (
        rubric_checks.student_visibility = 'always'
        OR (
          rubric_checks.student_visibility = 'if_released'
          AND EXISTS (
            SELECT 1
            FROM "public"."submissions" s
            JOIN "public"."submission_reviews" sr ON sr.submission_id = s.id
            WHERE s.assignment_id = r.assignment_id
              AND sr.released = true
              AND (
                EXISTS (
                  SELECT 1 FROM "public"."user_privileges" ur
                  WHERE ur.user_id = auth.uid()
                    AND ur.private_profile_id = s.profile_id
                    AND COALESCE(ur.disabled, false) = false
                )
                OR (
                  s.assignment_group_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM "public"."assignment_groups_members" mem
                    JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
                    WHERE mem.assignment_group_id = s.assignment_group_id
                      AND ur.user_id = auth.uid()
                      AND COALESCE(ur.disabled, false) = false
                  )
                )
              )
          )
        )
        OR (
          rubric_checks.student_visibility = 'if_applied'
          AND (
            EXISTS (
              SELECT 1
              FROM "public"."submission_comments" sc
              JOIN "public"."submissions" s ON s.id = sc.submission_id
              WHERE sc.rubric_check_id = rubric_checks.id
                AND sc.released = true
                AND (
                  EXISTS (
                    SELECT 1 FROM "public"."user_privileges" ur
                    WHERE ur.user_id = auth.uid()
                      AND ur.private_profile_id = s.profile_id
                      AND COALESCE(ur.disabled, false) = false
                  )
                  OR (
                    s.assignment_group_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM "public"."assignment_groups_members" mem
                      JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
                      WHERE mem.assignment_group_id = s.assignment_group_id
                        AND ur.user_id = auth.uid()
                        AND COALESCE(ur.disabled, false) = false
                    )
                  )
                )
            )
            OR EXISTS (
              SELECT 1
              FROM "public"."submission_file_comments" sfc
              JOIN "public"."submissions" s ON s.id = sfc.submission_id
              WHERE sfc.rubric_check_id = rubric_checks.id
                AND sfc.released = true
                AND (
                  EXISTS (
                    SELECT 1 FROM "public"."user_privileges" ur
                    WHERE ur.user_id = auth.uid()
                      AND ur.private_profile_id = s.profile_id
                      AND COALESCE(ur.disabled, false) = false
                  )
                  OR (
                    s.assignment_group_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM "public"."assignment_groups_members" mem
                      JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
                      WHERE mem.assignment_group_id = s.assignment_group_id
                        AND ur.user_id = auth.uid()
                        AND COALESCE(ur.disabled, false) = false
                    )
                  )
                )
            )
            OR EXISTS (
              SELECT 1
              FROM "public"."submission_artifact_comments" sac
              JOIN "public"."submissions" s ON s.id = sac.submission_id
              JOIN "public"."submission_reviews" sr ON sr.submission_id = s.id
              WHERE sac.rubric_check_id = rubric_checks.id
                AND sac.released = true
                AND (
                  EXISTS (
                    SELECT 1 FROM "public"."user_privileges" ur
                    WHERE ur.user_id = auth.uid()
                      AND ur.private_profile_id = s.profile_id
                      AND COALESCE(ur.disabled, false) = false
                  )
                  OR (
                    s.assignment_group_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM "public"."assignment_groups_members" mem
                      JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
                      WHERE mem.assignment_group_id = s.assignment_group_id
                        AND ur.user_id = auth.uid()
                        AND COALESCE(ur.disabled, false) = false
                    )
                  )
                )
            )
          )
        )
      )
  )
);

-- Inline SELECT-based RLS for submission_comments (remove function calls)
ALTER POLICY "students view own, instructors and graders view all" ON "public"."submission_comments"
USING ((
  ("class_id" IN (
    SELECT up.class_id FROM "public"."user_privileges" up
    WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
  ))
  OR (
    released AND EXISTS (
      SELECT 1 FROM "public"."submissions" s
      WHERE s.id = submission_comments.submission_id
        AND (
          EXISTS (
            SELECT 1 FROM "public"."user_privileges" ur
            WHERE ur.user_id = auth.uid()
              AND ur.private_profile_id = s.profile_id
          )
          OR (
            s.assignment_group_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM "public"."assignment_groups_members" mem
              JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
              WHERE mem.assignment_group_id = s.assignment_group_id
                AND ur.user_id = auth.uid()
            )
          )
        )
    )
  )
  OR (
    submission_review_id IS NOT NULL AND (
      -- Released reviews visible if user is owner or group member
      EXISTS (
        SELECT 1 FROM "public"."submission_reviews" sr
        JOIN "public"."submissions" s ON s.id = sr.submission_id
        WHERE sr.id = submission_comments.submission_review_id
          AND sr.released = true
          AND (
            EXISTS (
              SELECT 1 FROM "public"."user_privileges" ur
              WHERE ur.user_id = auth.uid()
                AND ur.private_profile_id = s.profile_id
            )
            OR (
              s.assignment_group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."assignment_groups_members" mem
                JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
                WHERE mem.assignment_group_id = s.assignment_group_id
                  AND ur.user_id = auth.uid()
              )
            )
          )
      )
      -- Or user is assigned reviewer (can view even if not released)
      OR EXISTS (
        SELECT 1 FROM "public"."review_assignments" ra
        JOIN "public"."user_privileges" ur ON ur.private_profile_id = ra.assignee_profile_id
        WHERE ra.submission_review_id = submission_comments.submission_review_id
          AND ur.user_id = auth.uid()
      )
    )
  )
));

-- Inline SELECT-based RLS for submission_file_comments
ALTER POLICY "students view own, instructors and graders view all" ON "public"."submission_file_comments"
USING ((
  ("class_id" IN (
    SELECT up.class_id FROM "public"."user_privileges" up
    WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
  ))
  OR (
    released AND EXISTS (
      SELECT 1 FROM "public"."submissions" s
      WHERE s.id = submission_file_comments.submission_id
        AND (
          EXISTS (
            SELECT 1 FROM "public"."user_privileges" ur
            WHERE ur.user_id = auth.uid()
              AND ur.private_profile_id = s.profile_id
          )
          OR (
            s.assignment_group_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM "public"."assignment_groups_members" mem
              JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
              WHERE mem.assignment_group_id = s.assignment_group_id
                AND ur.user_id = auth.uid()
            )
          )
        )
    )
  )
  OR (
    submission_review_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM "public"."submission_reviews" sr
        JOIN "public"."submissions" s ON s.id = sr.submission_id
        WHERE sr.id = submission_file_comments.submission_review_id
          AND sr.released = true
          AND (
            EXISTS (
              SELECT 1 FROM "public"."user_privileges" ur
              WHERE ur.user_id = auth.uid()
                AND ur.private_profile_id = s.profile_id
            )
            OR (
              s.assignment_group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."assignment_groups_members" mem
                JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
                WHERE mem.assignment_group_id = s.assignment_group_id
                  AND ur.user_id = auth.uid()
              )
            )
          )
      )
      OR EXISTS (
        SELECT 1 FROM "public"."review_assignments" ra
        JOIN "public"."user_privileges" ur ON ur.private_profile_id = ra.assignee_profile_id
        WHERE ra.submission_review_id = submission_file_comments.submission_review_id
          AND ur.user_id = auth.uid()
      )
    )
  )
));

-- Inline SELECT-based RLS for submission_artifact_comments
ALTER POLICY "students view own, instructors and graders view all" ON "public"."submission_artifact_comments"
USING ((
  ("class_id" IN (
    SELECT up.class_id FROM "public"."user_privileges" up
    WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
  ))
  OR (
    released AND EXISTS (
      SELECT 1 FROM "public"."submissions" s
      WHERE s.id = submission_artifact_comments.submission_id
        AND (
          EXISTS (
            SELECT 1 FROM "public"."user_privileges" ur
            WHERE ur.user_id = auth.uid()
              AND ur.private_profile_id = s.profile_id
          )
          OR (
            s.assignment_group_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM "public"."assignment_groups_members" mem
              JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
              WHERE mem.assignment_group_id = s.assignment_group_id
                AND ur.user_id = auth.uid()
            )
          )
        )
    )
  )
  OR (
    submission_review_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM "public"."submission_reviews" sr
        JOIN "public"."submissions" s ON s.id = sr.submission_id
        WHERE sr.id = submission_artifact_comments.submission_review_id
          AND sr.released = true
          AND (
            EXISTS (
              SELECT 1 FROM "public"."user_privileges" ur
              WHERE ur.user_id = auth.uid()
                AND ur.private_profile_id = s.profile_id
            )
            OR (
              s.assignment_group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."assignment_groups_members" mem
                JOIN "public"."user_privileges" ur ON ur.private_profile_id = mem.profile_id
                WHERE mem.assignment_group_id = s.assignment_group_id
                  AND ur.user_id = auth.uid()
              )
            )
          )
      )
      OR EXISTS (
        SELECT 1 FROM "public"."review_assignments" ra
        JOIN "public"."user_privileges" ur ON ur.private_profile_id = ra.assignee_profile_id
        WHERE ra.submission_review_id = submission_artifact_comments.submission_review_id
          AND ur.user_id = auth.uid()
      )
    )
  )
));
