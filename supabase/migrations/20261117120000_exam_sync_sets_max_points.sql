-- #1284: "Build rubric from exam" kept the rubric in step with the questions but never touched the
-- assignment's max points, so after a points change Configure Rubric reported a mismatch and told the
-- instructor to remove points from a rubric that was correct.
--
-- This redefines exam_sync_rubric_from_questions unchanged except for one block: while the assignment
-- has no submissions (the same gate that already refreshes generated check points), a sync into the
-- assignment's GRADING rubric for a PAPER exam sets assignments.total_points to the exam total, the sum of
-- the leaf questions' points.
--
-- Left alone on purpose:
-- - Once there are submissions. The questions are frozen by then, and an instructor may have set the max
--   by hand during grading (a curve, bonus questions).
-- - Any other rubric (self-review, meta-grading). Their checks don't make up the assignment's max.
-- - In-app quizzes. Their auto-scored questions have no rubric check and nothing sets autograder_points,
--   so the max can't be derived the same way yet.
--
-- update_gradebook_column_max_score fires on the total_points change and keeps the gradebook column's
-- max_score in step.

create or replace function public.exam_sync_rubric_from_questions(
  p_exam_id bigint,
  p_rubric_id bigint
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id bigint;
  v_assignment_id bigint;
  r1 record;  -- level 1 (part)
  r2 record;  -- level 2 (criteria)
  r3 record;  -- level 3 (check)
  v_part_id bigint;
  v_crit_id bigint;
  v_check_count integer;
  v_check_points numeric;
  v_l2_count integer;
  v_l3_count integer;
  v_delivery text;
  v_in_app boolean;
begin
  select class_id, assignment_id, delivery_mode into v_class_id, v_assignment_id, v_delivery
    from public.exams where id = p_exam_id;
  -- Only an IN-APP quiz is auto-scored: quiz_autograde is reachable only from quiz_submit,
  -- which rejects anything that is not delivery_mode 'in_app'. A paper exam has no autograder
  -- at all, so its objective questions must still get a manual check to grade against.
  v_in_app := coalesce(v_delivery, 'paper') = 'in_app';
  if v_class_id is null then
    raise exception 'Exam % not found', p_exam_id;
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid() and up.class_id = v_class_id and up.role = 'instructor'
  ) then
    raise exception 'Access denied: instructors only';
  end if;

  -- The instructor check above is scoped to the EXAM's class, but every write below targets
  -- p_rubric_id, which until now was unvalidated. A caller authorized for this exam could pass
  -- any enumerable rubric id and have this security-definer function insert parts/criteria/checks
  -- into another class's rubric (stamped with this class's ids); score recomputation joins
  -- components by rubric_id, so that would alter grades in a class the caller cannot access.
  if not exists (
    select 1 from public.rubrics r
    where r.id = p_rubric_id
      and r.class_id = v_class_id
      and r.assignment_id = v_assignment_id
  ) then
    raise exception 'Rubric % does not belong to assignment %', p_rubric_id, v_assignment_id;
  end if;

  -- RECONCILE FIRST, then build. All of this used to run after the loop below, which was an
  -- ordering bug: the loop computes each rubric_criteria.total_points by summing the checks that
  -- exist at that moment, so a stale point value, an orphan, or a check that should have been
  -- deleted was still counted -- e.g. changing a draft question from 5 to 10 left the criterion
  -- total at 5 while the check itself became 10, and grading then capped the 10-point check at
  -- the criterion's 5. Reconciling up front means the totals are derived from the correct set.
  -- Refresh generated check points from the question while the assignment is still a DRAFT.
  -- Checks are INSERT-ONLY so a grader's edits survive a re-sync, but that also meant changing a
  -- draft question's points never reached rubric_checks.points: the criterion total summed stale
  -- checks, so manual grading used the old maximum while quiz autograding used the new value.
  -- Gating on "no submissions yet" keeps both properties -- a draft stays consistent, and once
  -- grading can have happened the grader's numbers are left alone. Only rows with an
  -- exam_question_id are touched, so user-authored checks are never rewritten.
  if not exists (select 1 from public.submissions where assignment_id = v_assignment_id) then
    update public.rubric_checks c
      set points = coalesce(q.points, 0)
      from public.exam_questions q
      where c.rubric_id = p_rubric_id
        and q.id = c.exam_question_id
        and q.exam_id = p_exam_id
        and c.points is distinct from coalesce(q.points, 0);

    -- #1284: keep the assignment's max points at the exam total, under the same "no submissions" gate.
    -- See the header for why quizzes and non-grading rubrics are skipped.
    if not v_in_app
      and p_rubric_id = (select a.grading_rubric_id from public.assignments a where a.id = v_assignment_id)
    then
      update public.assignments a
        set total_points = t.total
        from (
          select coalesce(sum(coalesce(q.points, 0)), 0) as total
          from public.exam_questions q
          where q.exam_id = p_exam_id
            and not exists (select 1 from public.exam_questions ch where ch.parent_id = q.id)
        ) t
        where a.id = v_assignment_id
          and a.total_points is distinct from t.total;
    end if;
  end if;

  -- Drop generated LEAF rows for questions that have since GAINED children. The leaf branches
  -- above simply stop treating such a question as a leaf; the criterion/check generated for it
  -- while it WAS a leaf survived, because on delete cascade only removes rows whose question no
  -- longer exists. Its old hidden points were then awardable alongside the new child checks.
  delete from public.rubric_checks c
  using public.exam_questions q
  where c.rubric_id = p_rubric_id
    and q.id = c.exam_question_id
    and q.exam_id = p_exam_id
    and exists (select 1 from public.exam_questions ch where ch.parent_id = q.id);
  delete from public.rubric_criteria cr
  using public.exam_questions q
  where cr.rubric_id = p_rubric_id
    and q.id = cr.exam_question_id
    and q.exam_id = p_exam_id
    and q.level = 1
    and exists (select 1 from public.exam_questions ch where ch.parent_id = q.id);

  -- Drop generated checks whose question has BECOME auto-scored. The skip-on-insert predicates
  -- above only stop a NEW manual check being created; a free-text leaf that was synced once and
  -- later given an objective type plus an answer key kept its existing check, which
  -- stays because the question still exists -- so the recompute could
  -- sum that manual check on top of quiz_autograde's score for the same question.
  if v_in_app then
    delete from public.rubric_checks c
    using public.exam_questions q
    where c.rubric_id = p_rubric_id
      and q.id = c.exam_question_id
      and q.exam_id = p_exam_id
      and q.answer_type in ('multiple_choice','true_false','numeric')
      and q.correct_answer is not null;
  end if;

  -- level 1 -> rubric_parts
  for r1 in select * from public.exam_questions where exam_id = p_exam_id and level = 1 order by ordinal loop
    select id into v_part_id from public.rubric_parts
      where rubric_id = p_rubric_id and exam_question_id = r1.id limit 1;
    if v_part_id is null then
      insert into public.rubric_parts (class_id, assignment_id, rubric_id, name, description, ordinal, exam_question_id)
      values (v_class_id, v_assignment_id, p_rubric_id, coalesce(r1.label, 'Part'), r1.prompt, r1.ordinal,
              r1.id)
      returning id into v_part_id;
    else
      update public.rubric_parts set name = coalesce(r1.label, name), description = r1.prompt, ordinal = r1.ordinal
        where id = v_part_id;
    end if;

    -- A level-1 question with no children is a LEAF, which the flat one-question-per-prompt
    -- quiz the builder permits consists entirely of. Mapping strictly by level left such a
    -- question with a rubric part and nothing else: no criterion to carry its points and no
    -- check to award them, so its points and answer key were ungradeable. Promote the leaf to
    -- its own criterion + check under its part.
    select count(*) into v_l2_count from public.exam_questions
      where exam_id = p_exam_id and level = 2 and parent_id = r1.id;
    if v_l2_count = 0 then
      select id into v_crit_id from public.rubric_criteria
        where rubric_id = p_rubric_id and exam_question_id = r1.id limit 1;
      if v_crit_id is null then
        insert into public.rubric_criteria
          (class_id, assignment_id, rubric_id, rubric_part_id, name, description, total_points, is_additive, ordinal, exam_question_id)
        values (v_class_id, v_assignment_id, p_rubric_id, v_part_id, coalesce(r1.label, 'Criteria'), r1.prompt,
                coalesce(r1.points, 0), true, r1.ordinal, r1.id)
        returning id into v_crit_id;
      else
        update public.rubric_criteria set rubric_part_id = v_part_id, name = coalesce(r1.label, name),
          description = r1.prompt, ordinal = r1.ordinal
          where id = v_crit_id;
      end if;
      -- INSERT-ONLY, matching the level-3 checks below: never overwrite a grader's edits.
      -- Skipped entirely for an auto-scored leaf: quiz_autograde already awards that question
      -- through grader_result_tests, and _submission_review_recompute_scores sums both channels
      -- -- so a grader ticking the manual check would count the points TWICE (or consume the
      -- assignment cap and displace points earned on hand-graded answers).
      if not (v_in_app and r1.answer_type in ('multiple_choice','true_false','numeric') and r1.correct_answer is not null)
         and not exists (
        select 1 from public.rubric_checks
        where rubric_criteria_id = v_crit_id and exam_question_id = r1.id
      ) then
        insert into public.rubric_checks
          (class_id, assignment_id, rubric_id, rubric_criteria_id, name, description, ordinal, points, is_annotation, is_comment_required, exam_question_id)
        values (v_class_id, v_assignment_id, p_rubric_id, v_crit_id, coalesce(r1.label, 'Check'), r1.prompt, r1.ordinal,
                coalesce(r1.points, 0), false, false, r1.id);
      end if;
      select count(*), coalesce(sum(points), 0)
        into v_check_count, v_check_points
        from public.rubric_checks
        where rubric_criteria_id = v_crit_id;
      if v_check_count > 0 then
        update public.rubric_criteria set total_points = v_check_points where id = v_crit_id;
      end if;
    end if;

    -- level 2 -> rubric_criteria (children of r1)
    for r2 in select * from public.exam_questions
              where exam_id = p_exam_id and level = 2 and parent_id = r1.id order by ordinal loop
      select id into v_crit_id from public.rubric_criteria
        where rubric_id = p_rubric_id and exam_question_id = r2.id limit 1;
      if v_crit_id is null then
        insert into public.rubric_criteria
          (class_id, assignment_id, rubric_id, rubric_part_id, name, description, total_points, is_additive, ordinal, exam_question_id)
        values (v_class_id, v_assignment_id, p_rubric_id, v_part_id, coalesce(r2.label,'Criteria'), r2.prompt,
                coalesce(r2.points, 0), true, r2.ordinal, r2.id)
        returning id into v_crit_id;
      else
        update public.rubric_criteria set rubric_part_id = v_part_id, name = coalesce(r2.label, name),
          description = r2.prompt, total_points = coalesce(r2.points, total_points), ordinal = r2.ordinal
          where id = v_crit_id;
      end if;

      -- level 3 -> rubric_checks (children of r2). Intentionally INSERT-ONLY (unlike parts
      -- and criteria above, which upsert): once a check exists we never overwrite it, so a
      -- grader's manual edits to a generated check survive re-syncing the exam structure.
      select count(*) into v_l3_count from public.exam_questions
        where exam_id = p_exam_id and level = 3 and parent_id = r2.id;
      -- Same reasoning one level down: an additive criterion with no checks has nothing to add,
      -- so a two-level tree's level-2 leaves need a check of their own.
      if v_l3_count = 0 then
        -- Same auto-scored exclusion as the level-1 leaf above.
        if not (v_in_app and r2.answer_type in ('multiple_choice','true_false','numeric') and r2.correct_answer is not null)
           and not exists (
          select 1 from public.rubric_checks
          where rubric_criteria_id = v_crit_id and exam_question_id = r2.id
        ) then
          insert into public.rubric_checks
            (class_id, assignment_id, rubric_id, rubric_criteria_id, name, description, ordinal, points, is_annotation, is_comment_required, exam_question_id)
          values (v_class_id, v_assignment_id, p_rubric_id, v_crit_id, coalesce(r2.label, 'Check'), r2.prompt, r2.ordinal,
                  coalesce(r2.points, 0), false, false, r2.id);
        end if;
      end if;

      for r3 in select * from public.exam_questions
                where exam_id = p_exam_id and level = 3 and parent_id = r2.id order by ordinal loop
        -- Same auto-scored exclusion as the leaf cases above.
        if not (v_in_app and r3.answer_type in ('multiple_choice','true_false','numeric') and r3.correct_answer is not null)
           and not exists (
          select 1 from public.rubric_checks
          where rubric_criteria_id = v_crit_id and exam_question_id = r3.id
        ) then
          insert into public.rubric_checks
            (class_id, assignment_id, rubric_id, rubric_criteria_id, name, description, ordinal, points, is_annotation, is_comment_required, exam_question_id)
          values (v_class_id, v_assignment_id, p_rubric_id, v_crit_id, coalesce(r3.label,'Check'), r3.prompt, r3.ordinal,
                  coalesce(r3.points, 0), false, false, r3.id);
        end if;
      end loop;

      -- Derive the criterion total from the checks that actually hang off it. A level-2 question
      -- becomes a non-leaf as soon as level-3 items exist, and the editor then hides its points
      -- control -- so r2.points stays 0 while the real points sit on the level-3 checks. Leaving
      -- the additive criterion at total_points = 0 makes _submission_review_recompute_scores cap
      -- those checks at 0, so a grader can never award them. Summing the persisted checks (rather
      -- than the exam_questions points) also keeps the total honest after a grader edits a check,
      -- which the INSERT-ONLY policy above deliberately preserves.
      select count(*), coalesce(sum(points), 0)
        into v_check_count, v_check_points
        from public.rubric_checks
        where rubric_criteria_id = v_crit_id;
      if v_check_count > 0 then
        update public.rubric_criteria set total_points = v_check_points where id = v_crit_id;
      end if;
    end loop;
  end loop;

end;
$$;
revoke all on function public.exam_sync_rubric_from_questions(bigint, bigint) from public;
grant execute on function public.exam_sync_rubric_from_questions(bigint, bigint) to authenticated, service_role;
