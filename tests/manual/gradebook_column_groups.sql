-- Proof harness for 20261109120000_gradebook_column_groups.sql.
--
-- Needs a local stack with the migration applied and the cs4535 template seeded
-- (`npm run seed -- --template cs4535`). Everything runs in one transaction that ends in
-- ROLLBACK:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/gradebook_column_groups.sql
--
-- Each check raises on failure, so a clean run ends with "ALL CHECKS PASSED".
\set ON_ERROR_STOP on
\timing off
\pset pager off

BEGIN;

\echo '=== down path, then up again (also re-runs the feature-flag backfill on existing classes) ==='
-- Topics build on groups, so their down path runs first when they are applied.
SELECT to_regclass('public.gradebook_topics') IS NOT NULL AS has_topics \gset
\if :has_topics
\i supabase/migrations/20261109130000_gradebook_topics.down.sql.txt
\endif
\i supabase/migrations/20261109120000_gradebook_column_groups.down.sql.txt
DO $$ BEGIN
  IF to_regclass('public.gradebook_column_groups') IS NOT NULL THEN RAISE EXCEPTION 'down left the table'; END IF;
  IF to_regprocedure('public.gradebook_columns_reorder(bigint[])') IS NULL THEN RAISE EXCEPTION 'down lost reorder'; END IF;
END $$;
\i supabase/migrations/20261109120000_gradebook_column_groups.sql

CREATE TEMP TABLE t AS
SELECT c.id AS class_id, c.gradebook_id,
  (SELECT user_id FROM user_roles WHERE class_id = c.id AND role = 'instructor' ORDER BY id LIMIT 1) AS instructor,
  (SELECT user_id FROM user_roles WHERE class_id = c.id AND role = 'grader' ORDER BY id LIMIT 1) AS grader,
  (SELECT user_id FROM user_roles WHERE class_id = c.id AND role = 'student' ORDER BY id LIMIT 1) AS student
FROM classes c WHERE c.name LIKE 'CS 4535%' ORDER BY c.id DESC LIMIT 1;
GRANT SELECT ON t TO authenticated;

-- Pin the seeded layout this file expects, whatever earlier use did to it: sort_order 0..n-1 in
-- display order, with the hole the seed leaves where quiz-3 was deleted (after quiz-2).
DO $$
DECLARE v_gb bigint := (SELECT gradebook_id FROM t);
BEGIN
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gb, 'true', true);
  WITH o AS (
    SELECT id, slug, (row_number() OVER (ORDER BY sort_order NULLS LAST, id) - 1)::integer AS rn
    FROM gradebook_columns WHERE gradebook_id = v_gb
  )
  UPDATE gradebook_columns gc
  SET sort_order = o.rn + CASE WHEN o.rn > (SELECT rn FROM o WHERE slug = 'quiz-2') THEN 1 ELSE 0 END
  FROM o WHERE gc.id = o.id;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gb, 'false', true);
END $$;

-- A second class with its own gradebook and columns, for the cross-course checks.
CREATE TEMP TABLE t_other AS SELECT NULL::bigint AS class_id, NULL::bigint AS gradebook_id, NULL::bigint AS col_a, NULL::bigint AS col_b;
GRANT SELECT ON t_other TO authenticated;
DO $$
DECLARE v_class bigint; v_gb bigint; v_a bigint; v_b bigint;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO classes (name) VALUES ('gcg other class') RETURNING id INTO v_class;
  INSERT INTO gradebooks (class_id, name) VALUES (v_class, 'other') RETURNING id INTO v_gb;
  UPDATE classes SET gradebook_id = v_gb WHERE id = v_class;
  INSERT INTO gradebook_columns (class_id, gradebook_id, slug, name, sort_order, max_score)
  VALUES (v_class, v_gb, 'hw-1', 'HW 1', 0, 10) RETURNING id INTO v_a;
  INSERT INTO gradebook_columns (class_id, gradebook_id, slug, name, sort_order, max_score)
  VALUES (v_class, v_gb, 'hw-2', 'HW 2', 1, 10) RETURNING id INTO v_b;
  SET LOCAL session_replication_role = origin;
  UPDATE t_other SET class_id = v_class, gradebook_id = v_gb, col_a = v_a, col_b = v_b;
END $$;

\echo '=== feature flag written disabled on every existing class ==='
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM classes c
    WHERE NOT (c.features @> '[{"name":"gradebook-column-groups","enabled":false}]'
           AND c.features @> '[{"name":"gradebook-topics","enabled":false}]')
      AND c.id <> (SELECT class_id FROM t_other)
  ) THEN RAISE EXCEPTION 'a class is missing the disabled flags'; END IF;
END $$;

-- Impersonation helpers.
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_postgres() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
-- true when f raised
CREATE OR REPLACE FUNCTION pg_temp.raises(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.raises(text), pg_temp.as_user(uuid), pg_temp.as_postgres() TO authenticated;

\echo '=== preview: the cs4535 expectations ==='
DO $$
DECLARE v_plan jsonb; v_names text;
BEGIN
  v_plan := gradebook_columns_auto_group_plan((SELECT gradebook_id FROM t));
  SELECT string_agg(g->>'name' || ':' || jsonb_array_length(g->'column_ids'), ', ') INTO v_names
  FROM jsonb_array_elements(v_plan->'groups') g;
  IF v_names IS DISTINCT FROM 'Labs:4, Assignments:4, Exams:3, Quizzes:4, Skills:12, AI Usage Logs:2' THEN
    RAISE EXCEPTION 'unexpected groups: %', v_names;
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_plan->'changes') c WHERE c->>'reason' = 'membership') <> 4
     OR (SELECT count(*) FROM jsonb_array_elements(v_plan->'changes') c WHERE c->>'reason' = 'name') <> 2
     OR jsonb_array_length(v_plan->'changes') <> 6 THEN
    RAISE EXCEPTION 'unexpected changes: %', v_plan->'changes';
  END IF;
  RAISE NOTICE 'groups: %', v_names;
END $$;

\echo '=== naming helpers ==='
DO $$ BEGIN
  IF gradebook_pluralize('Quiz') <> 'Quizzes' OR gradebook_pluralize('Lab') <> 'Labs'
     OR gradebook_pluralize('AI Usage Log') <> 'AI Usage Logs' OR gradebook_pluralize('Activity') <> 'Activities'
     OR gradebook_pluralize('Labs') <> 'Labs' OR gradebook_pluralize('Status') <> 'Statuses'
     OR gradebook_pluralize('Homework') <> 'Homework' OR gradebook_pluralize('Other') <> 'Others' THEN
    RAISE EXCEPTION 'pluralize regression';
  END IF;
  IF gradebook_common_name_prefix(ARRAY['AI Usage Log 1', 'AI Usage Log 2']) <> 'AI Usage Log'
     OR gradebook_common_name_prefix(ARRAY['Lab 1 -- Setup', 'Lab 2 -- Fractions']) <> 'Lab'
     OR gradebook_common_name_prefix(ARRAY['HW1: x', 'HW2: y']) IS NOT NULL THEN
    RAISE EXCEPTION 'common prefix regression';
  END IF;
END $$;

\echo '=== students and graders cannot write ==='
SELECT pg_temp.as_user((SELECT student FROM t));
DO $$ BEGIN
  IF NOT pg_temp.raises(format('SELECT gradebook_columns_auto_group(%s)', (SELECT gradebook_id FROM t))) THEN
    RAISE EXCEPTION 'student ran auto_group'; END IF;
  IF NOT pg_temp.raises(format('SELECT gradebook_columns_auto_group_preview(%s)', (SELECT gradebook_id FROM t))) THEN
    RAISE EXCEPTION 'student ran preview'; END IF;
  IF NOT pg_temp.raises(format($q$INSERT INTO gradebook_column_groups (class_id, gradebook_id, name) VALUES (%s, %s, 'x')$q$,
    (SELECT class_id FROM t), (SELECT gradebook_id FROM t))) THEN
    RAISE EXCEPTION 'student inserted a group'; END IF;
  IF NOT pg_temp.raises(format('SELECT gradebook_enable_column_groups(%s)', (SELECT class_id FROM t))) THEN
    RAISE EXCEPTION 'student enabled groups'; END IF;
END $$;
SELECT pg_temp.as_user((SELECT grader FROM t));
DO $$ BEGIN
  IF NOT pg_temp.raises(format('SELECT gradebook_columns_auto_group(%s)', (SELECT gradebook_id FROM t))) THEN
    RAISE EXCEPTION 'grader ran auto_group'; END IF;
END $$;

\echo '=== instructor enables groups: auto-group + flag in one call ==='
SELECT pg_temp.as_user((SELECT instructor FROM t));
DO $$
DECLARE v_n integer;
BEGIN
  v_n := gradebook_enable_column_groups((SELECT class_id FROM t));
  IF v_n <> 6 THEN RAISE EXCEPTION 'expected 6 groups created, got %', v_n; END IF;
  IF NOT (SELECT features @> '[{"name":"gradebook-column-groups","enabled":true}]' FROM classes WHERE id = (SELECT class_id FROM t)) THEN
    RAISE EXCEPTION 'flag not enabled'; END IF;
  -- Second enable is a no-op for grouping.
  v_n := gradebook_enable_column_groups((SELECT class_id FROM t));
  IF v_n <> 0 THEN RAISE EXCEPTION 're-enable regrouped (% groups)', v_n; END IF;
END $$;

-- Contiguity: for every group, its members' positions form one run.
CREATE OR REPLACE FUNCTION pg_temp.assert_contiguous(p_gradebook_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(DISTINCT group_id::text, ',') INTO v_bad FROM (
    SELECT group_id, pos, pos - row_number() OVER (PARTITION BY group_id ORDER BY pos) AS run
    FROM (SELECT group_id, row_number() OVER (ORDER BY sort_order NULLS LAST, id) AS pos
          FROM gradebook_columns WHERE gradebook_id = p_gradebook_id) x
    WHERE group_id IS NOT NULL
  ) y GROUP BY group_id HAVING count(DISTINCT run) > 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'torn groups: %', v_bad; END IF;
  IF EXISTS (SELECT sort_order FROM gradebook_columns WHERE gradebook_id = p_gradebook_id GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'duplicate sort_order'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_contiguous(bigint) TO authenticated;
SELECT pg_temp.assert_contiguous((SELECT gradebook_id FROM t));

\echo '=== RLS: hidden-only group invisible to students, visible to staff ==='
DO $$
DECLARE v_curve bigint; v_gid bigint;
BEGIN
  SELECT id INTO v_curve FROM gradebook_columns WHERE gradebook_id = (SELECT gradebook_id FROM t) AND slug = 'curve-adjustment';
  v_gid := gradebook_column_group_create((SELECT gradebook_id FROM t), 'Hidden stuff', ARRAY[v_curve]);
  PERFORM set_config('gcg.hidden_group', v_gid::text, true);
END $$;
SELECT pg_temp.as_user((SELECT student FROM t));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM gradebook_column_groups WHERE id = current_setting('gcg.hidden_group')::bigint) THEN
    RAISE EXCEPTION 'student sees the hidden-only group'; END IF;
  IF (SELECT count(*) FROM gradebook_column_groups) <> 6 THEN
    RAISE EXCEPTION 'student should see the 6 visible groups, sees %', (SELECT count(*) FROM gradebook_column_groups); END IF;
  -- A student's UPDATE/DELETE matches nothing.
  UPDATE gradebook_column_groups SET name = 'pwned';
  DELETE FROM gradebook_column_groups;
END $$;
SELECT pg_temp.as_user((SELECT grader FROM t));
DO $$ BEGIN
  IF (SELECT count(*) FROM gradebook_column_groups) <> 7 THEN
    RAISE EXCEPTION 'grader should see 7 groups, sees %', (SELECT count(*) FROM gradebook_column_groups); END IF;
  UPDATE gradebook_column_groups SET name = 'grader rename';
  IF EXISTS (SELECT 1 FROM gradebook_column_groups WHERE name = 'grader rename') THEN
    RAISE EXCEPTION 'grader renamed a group'; END IF;
END $$;

\echo '=== RLS: nobody sees another course''s groups ==='
SELECT pg_temp.as_postgres();
INSERT INTO gradebook_column_groups (class_id, gradebook_id, name)
SELECT class_id, gradebook_id, 'Other course group' FROM t_other;
UPDATE gradebook_columns SET group_id = (SELECT id FROM gradebook_column_groups WHERE name = 'Other course group')
WHERE id IN (SELECT col_a FROM t_other UNION SELECT col_b FROM t_other);
SELECT pg_temp.as_user((SELECT instructor FROM t));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM gradebook_column_groups WHERE name = 'Other course group') THEN
    RAISE EXCEPTION 'instructor sees another course''s group'; END IF;
  IF NOT pg_temp.raises(format('SELECT gradebook_columns_auto_group(%s)', (SELECT gradebook_id FROM t_other))) THEN
    RAISE EXCEPTION 'instructor auto-grouped another course'; END IF;
END $$;

\echo '=== set_group: cross-gradebook rejected, placement keeps groups contiguous ==='
DO $$
DECLARE
  v_gb bigint := (SELECT gradebook_id FROM t);
  v_quizzes bigint; v_labs bigint; v_final bigint; v_quiz1 bigint; v_pos integer; v_last integer;
BEGIN
  SELECT id INTO v_quizzes FROM gradebook_column_groups WHERE gradebook_id = v_gb AND name = 'Quizzes';
  SELECT id INTO v_labs FROM gradebook_column_groups WHERE gradebook_id = v_gb AND name = 'Labs';
  SELECT id INTO v_final FROM gradebook_columns WHERE gradebook_id = v_gb AND slug = 'final';
  SELECT id INTO v_quiz1 FROM gradebook_columns WHERE gradebook_id = v_gb AND slug = 'quiz-1';

  IF NOT pg_temp.raises(format('SELECT gradebook_columns_set_group(ARRAY[%s], %s)', (SELECT col_a FROM t_other), v_quizzes)) THEN
    RAISE EXCEPTION 'joined another gradebook''s column to a group'; END IF;
  IF NOT pg_temp.raises(format('SELECT gradebook_columns_set_group(ARRAY[%s, %s], NULL)', v_final, (SELECT col_a FROM t_other))) THEN
    RAISE EXCEPTION 'mixed-gradebook set_group accepted'; END IF;

  -- Final Score (last column) into Quizzes: lands right after quiz-5.
  PERFORM gradebook_columns_set_group(ARRAY[v_final], v_quizzes);
  PERFORM pg_temp.assert_contiguous(v_gb);
  SELECT max(sort_order) INTO v_last FROM gradebook_columns WHERE group_id = v_quizzes;
  IF (SELECT sort_order FROM gradebook_columns WHERE id = v_final) <> v_last THEN
    RAISE EXCEPTION 'joined column not placed at the end of its group'; END IF;

  -- quiz-1 out of Quizzes: lands right after the group's run.
  PERFORM gradebook_columns_set_group(ARRAY[v_quiz1], NULL);
  PERFORM pg_temp.assert_contiguous(v_gb);
  SELECT max(sort_order) INTO v_last FROM gradebook_columns WHERE group_id = v_quizzes;
  IF (SELECT sort_order FROM gradebook_columns WHERE id = v_quiz1) <> v_last + 1 THEN
    RAISE EXCEPTION 'ungrouped column not placed after its old run'; END IF;

  -- Move every lab out: the Labs group deletes itself, and only it.
  PERFORM gradebook_columns_set_group((SELECT array_agg(id) FROM gradebook_columns WHERE group_id = v_labs), NULL);
  IF EXISTS (SELECT 1 FROM gradebook_column_groups WHERE id = v_labs) THEN RAISE EXCEPTION 'empty group survived'; END IF;
  PERFORM pg_temp.assert_contiguous(v_gb);
END $$;
SELECT pg_temp.as_postgres();
DO $$ BEGIN
  -- The other course's group is untouched by our empty-group deletions.
  IF NOT EXISTS (SELECT 1 FROM gradebook_column_groups WHERE name = 'Other course group') THEN
    RAISE EXCEPTION 'empty-group trigger reached another course'; END IF;
END $$;

\echo '=== reorder and auto-layout cannot tear a group ==='
SELECT pg_temp.as_user((SELECT instructor FROM t));
DO $$
DECLARE v_gb bigint := (SELECT gradebook_id FROM t); v_order bigint[]; v_skill1 bigint;
BEGIN
  -- Move skill-1 (a Skills member) to the very front: tears Skills; compaction pulls it back.
  SELECT id INTO v_skill1 FROM gradebook_columns WHERE gradebook_id = v_gb AND slug = 'skill-1';
  SELECT ARRAY[v_skill1] || array_agg(id ORDER BY sort_order) INTO v_order
  FROM gradebook_columns WHERE gradebook_id = v_gb AND id <> v_skill1;
  PERFORM gradebook_columns_reorder(v_order);
  PERFORM pg_temp.assert_contiguous(v_gb);
  -- The group now sits where its first member was dropped: at the front.
  IF (SELECT sort_order FROM gradebook_columns WHERE id = v_skill1) <> 0 THEN
    RAISE EXCEPTION 'group did not move to its first member'; END IF;

  PERFORM gradebook_auto_layout(v_gb);
  PERFORM pg_temp.assert_contiguous(v_gb);
END $$;

\echo '=== renaming, unique names, deleting a group keeps grades ==='
DO $$
DECLARE v_gb bigint := (SELECT gradebook_id FROM t); v_skills bigint; v_before bigint; v_after bigint;
BEGIN
  SELECT id INTO v_skills FROM gradebook_column_groups WHERE gradebook_id = v_gb AND name = 'Skills';
  UPDATE gradebook_column_groups SET name = 'Skill checks' WHERE id = v_skills;
  IF NOT EXISTS (SELECT 1 FROM gradebook_column_groups WHERE id = v_skills AND name = 'Skill checks') THEN
    RAISE EXCEPTION 'instructor rename failed'; END IF;
  IF NOT pg_temp.raises(format($q$UPDATE gradebook_column_groups SET name = 'EXAMS' WHERE id = %s$q$, v_skills)) THEN
    RAISE EXCEPTION 'case-insensitive duplicate name accepted'; END IF;
  IF NOT pg_temp.raises(format($q$UPDATE gradebook_column_groups SET gradebook_id = %s WHERE id = %s$q$,
      (SELECT gradebook_id FROM t_other), v_skills)) THEN
    RAISE EXCEPTION 'group moved to another gradebook'; END IF;

  SELECT count(*) INTO v_before FROM gradebook_column_students gcs JOIN gradebook_columns gc ON gc.id = gcs.gradebook_column_id
  WHERE gc.group_id = v_skills;
  DELETE FROM gradebook_column_groups WHERE id = v_skills;
  SELECT count(*) INTO v_after FROM gradebook_column_students gcs JOIN gradebook_columns gc ON gc.id = gcs.gradebook_column_id
  WHERE gc.gradebook_id = v_gb AND gc.slug LIKE 'skill-%';
  IF v_before = 0 OR v_before <> v_after THEN RAISE EXCEPTION 'grades changed on group delete (% -> %)', v_before, v_after; END IF;
  IF EXISTS (SELECT 1 FROM gradebook_columns WHERE gradebook_id = v_gb AND slug LIKE 'skill-%' AND group_id IS NOT NULL) THEN
    RAISE EXCEPTION 'columns still reference the deleted group'; END IF;
END $$;

\echo '=== auto-group on a partly grouped gradebook never regroups grouped columns ==='
DO $$
DECLARE v_gb bigint := (SELECT gradebook_id FROM t); v_n integer; v_grouped_before text[];
BEGIN
  SELECT array_agg(id || ':' || group_id ORDER BY id) INTO v_grouped_before FROM gradebook_columns WHERE gradebook_id = v_gb AND group_id IS NOT NULL;
  v_n := gradebook_columns_auto_group(v_gb);
  IF v_n < 1 THEN RAISE EXCEPTION 'expected the ungrouped skills to regroup'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_grouped_before) x
    WHERE NOT EXISTS (SELECT 1 FROM gradebook_columns WHERE id || ':' || group_id = x)
  ) THEN RAISE EXCEPTION 'auto_group moved an already grouped column'; END IF;
  PERFORM pg_temp.assert_contiguous(v_gb);
END $$;

SELECT pg_temp.as_postgres();
\echo ''
\echo 'ALL CHECKS PASSED'
ROLLBACK;
