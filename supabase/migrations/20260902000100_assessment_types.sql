-- Assessment types: turn the paper-exam subsystem into a unified assessment builder.
--
-- This builds on 20260605000000_exam_grading.sql. The exam_questions + exam_question_regions
-- tree is now the single definition behind three assignment kinds:
--   * exam   — printed/scanned + OCR (the existing flow)
--   * quiz   — the same definition delivered IN-APP; objective answers auto-graded
--   * survey — a required SurveyJS survey whose completion earns credit
--
-- It adds:
--   1) assignments.assignment_type (code | quiz | exam | survey), default 'code'
--   2) exams.delivery_mode (paper | in_app) and a 'generated' template_source_type
--      (a PDF we render ourselves, so every answer region is known exactly)
--   3) exam_questions.correct_answer / grading_tolerance (the objective answer key)
--   4) quiz_submit / quiz_autograde / quiz_get_for_student RPCs
--   5) a survey-completion -> grade trigger
--
-- RPC conventions mirror the exam migration: security definer, inline user_privileges
-- checks (no helper indirection), revoke-from-public + grant-to-authenticated/service_role.

-- ---------------------------------------------------------------------------
-- 1) assignment_type discriminator
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'assignment_type') then
    create type public.assignment_type as enum ('code', 'quiz', 'exam', 'survey');
  end if;
end$$;

-- default 'code' backfills every existing row at add-column time, so the existing
-- GitHub/autograder flow is unchanged. Intentionally NO check constraint coupling
-- assignment_type to other columns (the create form sets has_autograder/has_handgrader
-- unconditionally today; a coupling constraint would break it).
alter table public.assignments
  add column if not exists assignment_type public.assignment_type not null default 'code';

-- ---------------------------------------------------------------------------
-- 2) Generalize exams: a 'generated' source (we render the PDF) + delivery mode
-- ---------------------------------------------------------------------------
alter table public.exams drop constraint if exists exams_template_source_type_check;
alter table public.exams
  add constraint exams_template_source_type_check
  check (template_source_type in ('pdf', 'markdown', 'generated'));

alter table public.exams
  add column if not exists delivery_mode text not null default 'paper'
  check (delivery_mode in ('paper', 'in_app'));

-- ---------------------------------------------------------------------------
-- 3) Objective answer key on exam_questions
-- ---------------------------------------------------------------------------
-- correct_answer shapes by answer_type:
--   multiple_choice : {"choice": "<key>"}  or  {"choices": ["a","b"]} (multi-select)
--   true_false      : {"value": true}
--   numeric         : {"value": 42}        (correct within grading_tolerance; null = exact)
--   free_text / short_answer : left NULL -> routed to manual rubric grading
alter table public.exam_questions add column if not exists correct_answer jsonb;
alter table public.exam_questions add column if not exists grading_tolerance numeric;

-- ---------------------------------------------------------------------------
-- 4) exam_create: accept delivery_mode (default 'paper' keeps existing callers working)
-- ---------------------------------------------------------------------------
drop function if exists public.exam_create(bigint, text, integer, text, text);
create or replace function public.exam_create(
  p_assignment_id bigint,
  p_source_type text default 'pdf',
  p_num_pages integer default 0,
  p_template_pdf_path text default null,
  p_template_markdown text default null,
  p_delivery_mode text default 'paper'
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id bigint;
  v_exam_id bigint;
begin
  select class_id into v_class_id from public.assignments where id = p_assignment_id;
  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid() and up.class_id = v_class_id and up.role = 'instructor'
  ) then
    raise exception 'Access denied: instructors only';
  end if;

  insert into public.exams (class_id, assignment_id, template_source_type, num_pages,
                            template_pdf_path, template_markdown, delivery_mode)
  values (v_class_id, p_assignment_id, p_source_type, coalesce(p_num_pages, 0),
          p_template_pdf_path, p_template_markdown, coalesce(p_delivery_mode, 'paper'))
  on conflict (assignment_id) do update
    set template_source_type = excluded.template_source_type,
        num_pages = excluded.num_pages,
        template_pdf_path = coalesce(excluded.template_pdf_path, exams.template_pdf_path),
        template_markdown = coalesce(excluded.template_markdown, exams.template_markdown),
        delivery_mode = excluded.delivery_mode
  returning id into v_exam_id;

  return v_exam_id;
end;
$$;
revoke all on function public.exam_create(bigint, text, integer, text, text, text) from public;
grant execute on function public.exam_create(bigint, text, integer, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) exam_upsert_questions_and_regions: persist the answer key + keep ids stable
-- ---------------------------------------------------------------------------
-- Two changes over 20260605000000's definition:
--   * the exam_questions write now also carries correct_answer + grading_tolerance
--     (both NULL when absent, so the exam-grading.spec.ts fixtures are unaffected);
--   * questions are UPSERTed by id (delete-missing) instead of delete+reinserted, so
--     exam_questions.id survives a re-save and exam_sync_rubric_from_questions's rubric
--     back-references keep matching (no duplicate rubric scaffolding on draft re-saves).
-- The payload may carry an "id" per question (null/absent = new); existing callers that
-- omit it still work (every question is treated as new -> same as the old behaviour).
create or replace function public.exam_upsert_questions_and_regions(
  p_exam_id bigint,
  p_questions jsonb,
  p_regions jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id bigint;
  q jsonb;
  r jsonb;
  v_lvl int;
  v_qid bigint;
  v_new_id bigint;
  v_parent_id bigint;
begin
  select class_id into v_class_id from public.exams where id = p_exam_id;
  if v_class_id is null then
    raise exception 'Exam % not found', p_exam_id;
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid() and up.class_id = v_class_id and up.role = 'instructor'
  ) then
    raise exception 'Access denied: instructors only';
  end if;

  -- STABLE IDS: preserve exam_questions.id across saves so the {exam_question_id} back-
  -- references in rubric_parts/criteria/checks (written by exam_sync_rubric_from_questions)
  -- keep matching. A delete+reinsert would mint new ids every save, so the rubric sync could
  -- never re-match and re-scaffolded a duplicate generation on every draft re-save (and
  -- orphaned students' answer back-references). Detach the tree first so the prune below
  -- can't cascade-delete a row we mean to keep (exam_questions.parent_id is ON DELETE CASCADE).
  update public.exam_questions set parent_id = null where exam_id = p_exam_id;

  -- Drop questions no longer present in the payload. The nullif guard keeps NULL ids out of
  -- the set so `not in` stays well-defined; an all-new payload (no ids) gives an empty set,
  -- so every existing row is pruned -> identical to the first-save behaviour.
  delete from public.exam_questions
  where exam_id = p_exam_id
    and id not in (
      select (value->>'id')::bigint
      from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb))
      where nullif(value->>'id', '') is not null
    );

  -- Regions are not rubric-referenced, so wipe + reinsert them from the payload.
  delete from public.exam_question_regions where exam_id = p_exam_id;

  create temporary table pg_temp._exam_qmap (client_id text primary key, new_id bigint) on commit drop;

  for v_lvl in 1..3 loop
    for q in select value from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb))
             where (value->>'level')::int = v_lvl
             order by coalesce((value->>'ordinal')::numeric, 0)
    loop
      v_parent_id := null;
      if q->>'parent_client_id' is not null then
        select new_id into v_parent_id from pg_temp._exam_qmap where client_id = q->>'parent_client_id';
      end if;
      v_qid := nullif(q->>'id', '')::bigint;
      -- UPDATE in place when the payload carries an id this exam owns (the exam_id guard
      -- stops a caller from hijacking another exam's question by id); else INSERT a fresh row.
      if v_qid is not null and exists (
        select 1 from public.exam_questions where id = v_qid and exam_id = p_exam_id
      ) then
        update public.exam_questions set
          parent_id = v_parent_id, level = v_lvl,
          ordinal = coalesce((q->>'ordinal')::numeric, 0),
          label = q->>'label', prompt = q->>'prompt',
          answer_type = q->>'answer_type', choices = q->'choices',
          points = nullif(q->>'points','')::numeric,
          correct_answer = q->'correct_answer',
          grading_tolerance = nullif(q->>'grading_tolerance','')::numeric
        where id = v_qid;
        v_new_id := v_qid;
      else
        insert into public.exam_questions
          (class_id, exam_id, parent_id, level, ordinal, label, prompt, answer_type, choices, points,
           correct_answer, grading_tolerance)
        values
          (v_class_id, p_exam_id, v_parent_id, v_lvl,
           coalesce((q->>'ordinal')::numeric, 0), q->>'label', q->>'prompt',
           q->>'answer_type', q->'choices',
           nullif(q->>'points','')::numeric,
           q->'correct_answer',
           nullif(q->>'grading_tolerance','')::numeric)
        returning id into v_new_id;
      end if;
      insert into pg_temp._exam_qmap(client_id, new_id) values (q->>'client_id', v_new_id);
    end loop;
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_regions, '[]'::jsonb))
  loop
    v_new_id := null;
    if r->>'question_client_id' is not null then
      select new_id into v_new_id from pg_temp._exam_qmap where client_id = r->>'question_client_id';
    end if;
    insert into public.exam_question_regions
      (class_id, exam_id, exam_question_id, kind, page_number, x, y, width, height)
    values
      (v_class_id, p_exam_id, v_new_id, coalesce(r->>'kind','answer'),
       (r->>'page_number')::int, (r->>'x')::numeric, (r->>'y')::numeric,
       (r->>'width')::numeric, (r->>'height')::numeric);
  end loop;
end;
$$;
revoke all on function public.exam_upsert_questions_and_regions(bigint, jsonb, jsonb) from public;
grant execute on function public.exam_upsert_questions_and_regions(bigint, jsonb, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) quiz_get_for_student: deliver the question tree WITHOUT the answer key
-- ---------------------------------------------------------------------------
-- The exam_* tables are staff-only in RLS. This RPC lets an enrolled student read the
-- question tree (labels/prompts/choices) for an in-app quiz, with correct_answer and
-- grading_tolerance stripped server-side, so the answer key never reaches the client.
create or replace function public.quiz_get_for_student(p_assignment_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id bigint;
  v_exam_id bigint;
  v_delivery text;
  v_release timestamptz;
  v_questions jsonb;
begin
  select a.class_id, e.id, e.delivery_mode, a.release_date
    into v_class_id, v_exam_id, v_delivery, v_release
  from public.assignments a
  join public.exams e on e.assignment_id = a.id
  where a.id = p_assignment_id;

  if v_exam_id is null then
    raise exception 'No assessment defined for assignment %', p_assignment_id;
  end if;
  if v_delivery <> 'in_app' then
    raise exception 'Assignment % is not an in-app quiz', p_assignment_id;
  end if;

  -- caller must be enrolled in the class (any role); staff may always read
  if not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid() and up.class_id = v_class_id
  ) then
    raise exception 'Access denied';
  end if;
  -- students may only read once released; staff bypass the release gate
  if (v_release is null or v_release > now()) and not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid() and up.class_id = v_class_id and up.role in ('instructor','grader')
  ) then
    raise exception 'Assignment % is not yet released', p_assignment_id;
  end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.level, q.ordinal), '[]'::jsonb)
    into v_questions
  from (
    select id, parent_id, level, ordinal, label, prompt, answer_type, choices
    from public.exam_questions
    where exam_id = v_exam_id
  ) q;

  return jsonb_build_object('exam_id', v_exam_id, 'questions', v_questions);
end;
$$;
revoke all on function public.quiz_get_for_student(bigint) from public;
grant execute on function public.quiz_get_for_student(bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) quiz_submit: record an in-app quiz attempt as a submission + exam_v1 artifact
-- ---------------------------------------------------------------------------
-- p_answers: [{ "exam_question_id": <id>, "value": <any json> }]
-- Stores answers in the same exam_v1 submission_artifacts shape the OCR finalize worker
-- produces, so the existing exam grader UI + rubric grading work unchanged. Then runs
-- quiz_autograde so objective points post to the gradebook immediately.
create or replace function public.quiz_submit(p_assignment_id bigint, p_answers jsonb)
returns bigint
language plpgsql
security definer
-- public on the path: inserting into submissions fires the trigger chain (channels,
-- metrics, after-insert hook); some triggers reference tables unqualified. Same reasoning
-- as exam_create_submission.
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
  v_exam_id bigint;
  v_delivery text;
  v_release timestamptz;
  v_profile_id uuid;
  v_submission_id bigint;
  v_run_attempt int;
  v_questions jsonb := '[]'::jsonb;
  a jsonb;
  v_qid bigint;
  v_region record;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select a2.class_id, e.id, e.delivery_mode, a2.release_date
    into v_class_id, v_exam_id, v_delivery, v_release
  from public.assignments a2
  join public.exams e on e.assignment_id = a2.id
  where a2.id = p_assignment_id;

  if v_exam_id is null then
    raise exception 'No assessment defined for assignment %', p_assignment_id;
  end if;
  if v_delivery <> 'in_app' then
    raise exception 'Assignment % is not an in-app quiz', p_assignment_id;
  end if;

  select private_profile_id into v_profile_id
  from public.user_roles
  where user_id = auth.uid() and class_id = v_class_id
  limit 1;
  if v_profile_id is null then
    raise exception 'Caller is not enrolled in this class';
  end if;

  -- Mirror quiz_get_for_student's gate on the WRITE path too: students may only submit
  -- once released; staff bypass. Without this a student could POST answers via the RPC
  -- before release (the read path blocks early reads, but nothing gated the submit).
  if (v_release is null or v_release > now()) and not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid() and up.class_id = v_class_id and up.role in ('instructor', 'grader')
  ) then
    raise exception 'Assignment % is not yet released', p_assignment_id;
  end if;

  -- Build the exam_v1 questions[] from the submitted answers, attaching the answer
  -- region (page + bbox) when one exists so the grader can see where it lives.
  for a in select value from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb))
  loop
    v_qid := nullif(a->>'exam_question_id','')::bigint;
    if v_qid is null then
      continue;
    end if;
    select page_number, x, y, width, height into v_region
    from public.exam_question_regions
    where exam_id = v_exam_id and exam_question_id = v_qid and kind = 'answer'
    order by page_number
    limit 1;

    v_questions := v_questions || jsonb_build_array(jsonb_build_object(
      'exam_question_id', v_qid,
      'page_number', coalesce(v_region.page_number, null),
      'region', case when v_region.page_number is null then null
                     else jsonb_build_object('x', v_region.x, 'y', v_region.y,
                                             'width', v_region.width, 'height', v_region.height) end,
      'ocr_text', coalesce(a->>'value', ''),
      'structured_value', a->'value'
    ));
  end loop;

  -- New attempt becomes the active submission; deactivate any prior ones for this student.
  update public.submissions
    set is_active = false
    where assignment_id = p_assignment_id and profile_id = v_profile_id and is_active;

  -- The (repository, sha, run_number, run_attempt) tuple is UNIQUE
  -- (submissions_repository_sha_run_unique). Deactivating the prior attempt does not change
  -- its tuple, so a fixed run_attempt=0 would collide on the second submit. Bump run_attempt
  -- per attempt so a resubmission inserts cleanly instead of raising unique_violation.
  select coalesce(max(run_attempt), -1) + 1 into v_run_attempt
    from public.submissions
    where assignment_id = p_assignment_id and profile_id = v_profile_id and sha = 'quiz';

  insert into public.submissions
    (assignment_id, profile_id, class_id, sha, repository, run_attempt, run_number, is_active)
  values
    (p_assignment_id, v_profile_id, v_class_id, 'quiz',
     'quiz/' || v_profile_id::text, v_run_attempt, 1, true)
  returning id into v_submission_id;

  insert into public.submission_artifacts (submission_id, class_id, profile_id, name, data)
  values (v_submission_id, v_class_id, v_profile_id, 'Quiz',
          jsonb_build_object('format', 'exam_v1', 'pages', '[]'::jsonb, 'questions', v_questions));

  perform public.quiz_autograde(v_submission_id);

  return v_submission_id;
end;
$$;
revoke all on function public.quiz_submit(bigint, jsonb) from public;
grant execute on function public.quiz_submit(bigint, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8) quiz_autograde: score objective answers into the autograder channel
-- ---------------------------------------------------------------------------
-- Objective questions (multiple_choice, true_false, numeric) are scored against the
-- answer key and written as grader_result_tests under one grader_results row. That is
-- the autograder channel _submission_review_recompute_scores already folds into
-- total_score, so it composes with manual free-text rubric grading (the hand channel)
-- and posts to the gradebook via the standard recompute. free_text/short_answer earn 0
-- here and are graded by hand.
create or replace function public.quiz_autograde(p_submission_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
  v_assignment_id bigint;
  v_exam_id bigint;
  v_review_id bigint;
  v_artifact jsonb;
  v_grader_result_id bigint;
  v_total numeric := 0;
  v_max numeric := 0;
  rec record;
  v_qentry jsonb;
  v_student jsonb;
  v_correct boolean;
  v_earned numeric;
begin
  select s.class_id, s.assignment_id, s.grading_review_id
    into v_class_id, v_assignment_id, v_review_id
  from public.submissions s where s.id = p_submission_id;
  if v_class_id is null then
    raise exception 'Submission % not found', p_submission_id;
  end if;

  select e.id into v_exam_id from public.exams e where e.assignment_id = v_assignment_id;
  if v_exam_id is null then
    return; -- nothing to grade
  end if;

  select sa.data into v_artifact
  from public.submission_artifacts sa
  where sa.submission_id = p_submission_id and sa.data->>'format' = 'exam_v1'
  limit 1;
  if v_artifact is null then
    return;
  end if;

  -- recompute is idempotent: clear any prior auto-grade results for this submission
  delete from public.grader_results where submission_id = p_submission_id;

  insert into public.grader_results
    (submission_id, class_id, score, max_score, lint_passed, lint_output, lint_output_format)
  values (p_submission_id, v_class_id, 0, 0, true, '', 'text')
  returning id into v_grader_result_id;

  for rec in
    select id, label, answer_type, points, correct_answer, grading_tolerance
    from public.exam_questions
    where exam_id = v_exam_id
      and answer_type in ('multiple_choice', 'true_false', 'numeric')
      and correct_answer is not null
  loop
    -- pull the student's answer for this question out of the artifact
    select value into v_qentry
    from jsonb_array_elements(coalesce(v_artifact->'questions', '[]'::jsonb)) value
    where (value->>'exam_question_id')::bigint = rec.id
    limit 1;
    v_student := v_qentry->'structured_value';

    v_correct := false;
    if v_student is not null then
      if rec.answer_type = 'numeric' then
        begin
          v_correct := abs((v_student#>>'{}')::numeric - (rec.correct_answer->>'value')::numeric)
                       <= coalesce(rec.grading_tolerance, 0);
        exception when others then
          v_correct := false;
        end;
      elsif rec.answer_type = 'true_false' then
        v_correct := lower(v_student#>>'{}') = lower(rec.correct_answer->>'value');
      elsif rec.answer_type = 'multiple_choice' then
        if rec.correct_answer ? 'choices' then
          -- multi-select: set equality between the student array and the key array
          v_correct := (jsonb_typeof(v_student) = 'array')
                       and (v_student @> (rec.correct_answer->'choices'))
                       and ((rec.correct_answer->'choices') @> v_student);
        else
          v_correct := (v_student#>>'{}') = (rec.correct_answer->>'choice');
        end if;
      end if;
    end if;

    v_earned := case when v_correct then coalesce(rec.points, 0) else 0 end;
    v_total := v_total + v_earned;
    v_max := v_max + coalesce(rec.points, 0);

    insert into public.grader_result_tests
      (grader_result_id, class_id, name, score, max_score, output, output_format)
    values (v_grader_result_id, v_class_id, coalesce(rec.label, 'Question'),
            v_earned, coalesce(rec.points, 0),
            case when v_correct then 'Correct' else 'Incorrect' end, 'text');
  end loop;

  update public.grader_results
    set score = least(greatest(round(v_total), 0), 32767), max_score = least(greatest(round(v_max), 0), 32767)
    where id = v_grader_result_id;

  -- fold the autograde score into the grading review's total (and gradebook).
  if v_review_id is not null then
    perform public._submission_review_recompute_scores(v_review_id);
  end if;
end;
$$;
-- SECURITY: do NOT grant to `authenticated`. quiz_autograde performs NO caller
-- authorization — granted to authenticated it would let any logged-in user wipe and
-- recompute grader_results for ANY submission id (and re-enter the otherwise non-PUBLIC
-- _submission_review_recompute_scores). It is only ever invoked internally by quiz_submit,
-- which runs SECURITY DEFINER and retains execute on this function via ownership.
revoke all on function public.quiz_autograde(bigint) from public;
grant execute on function public.quiz_autograde(bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 9) Survey completion -> assignment credit
-- ---------------------------------------------------------------------------
-- When a survey linked to an assignment is submitted, ensure a submission exists for the
-- student and award full points. Completion is binary and non-sensitive, so the grading
-- review is released immediately. Routes through the standard submission + review path so
-- the gradebook column recalculates like every other assignment type.
create or replace function public.survey_completion_post_grade()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment_id bigint;
  v_class_id bigint;
  v_total_points numeric;
  v_submission_id bigint;
  v_review_id bigint;
begin
  if not new.is_submitted or (tg_op = 'UPDATE' and coalesce(old.is_submitted, false)) then
    return new;
  end if;

  select s.assignment_id, s.class_id into v_assignment_id, v_class_id
  from public.surveys s where s.id = new.survey_id;
  if v_assignment_id is null then
    return new; -- survey not linked to an assignment: nothing to grade
  end if;

  -- Only auto-credit survey-TYPE assignments. surveys.assignment_id can reference ANY
  -- assignment, so without this guard a survey linked (or mis-linked) to a code/quiz/exam
  -- assignment would overwrite that submission's review total_score and force released=true,
  -- silently clobbering its real grade.
  select total_points into v_total_points from public.assignments
    where id = v_assignment_id and assignment_type = 'survey';
  if not found then
    return new;
  end if;

  select id, grading_review_id into v_submission_id, v_review_id
  from public.submissions
  where assignment_id = v_assignment_id and profile_id = new.profile_id and is_active
  limit 1;

  if v_submission_id is null then
    insert into public.submissions
      (assignment_id, profile_id, class_id, sha, repository, run_attempt, run_number, is_active)
    values
      (v_assignment_id, new.profile_id, v_class_id, 'survey',
       'survey/' || new.profile_id::text, 0, 1, true)
    returning id into v_submission_id;
    -- grading_review_id is set by submissions_after_insert_hook (an AFTER INSERT
    -- trigger), so it is not yet visible in the RETURNING row above — re-read it.
    select grading_review_id into v_review_id from public.submissions where id = v_submission_id;
  end if;

  if v_review_id is not null then
    update public.submission_reviews
      set total_score = coalesce(v_total_points, 0), released = true
      where id = v_review_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_survey_completion_post_grade on public.survey_responses;
create trigger trg_survey_completion_post_grade
  after insert or update of is_submitted on public.survey_responses
  for each row execute function public.survey_completion_post_grade();

-- ---------------------------------------------------------------------------
-- 10) Index the per-submission scan-page lookups
-- ---------------------------------------------------------------------------
-- exam-async-worker finalize() and doMatch's page-assignment update both filter
-- exam_scan_pages by scanned_submission_id; the only index from 20260605000000 is on
-- (batch_id, page_index), so those were sequential scans over the whole batch's pages.
create index if not exists exam_scan_pages_scanned_submission_idx
  on public.exam_scan_pages (scanned_submission_id);
