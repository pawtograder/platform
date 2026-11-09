-- Proof harness for 20261109130000_gradebook_topics.sql.
--
-- Needs a local stack with both column-groups and topics migrations applied and the cs4535
-- template seeded. Ends in ROLLBACK:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/gradebook_topics.sql
--
-- The Suggest checks build a gradebook shaped like CS 2100 Spring 2026 (topics with two attempts
-- read by a `topic_*` max column, a third attempt whose slug the glob misses, and a duplicated
-- "Attempt 2"), so they need no production data.
\set ON_ERROR_STOP on
\timing off
\pset pager off

BEGIN;

\echo '=== down path, then up again ==='
\i supabase/migrations/20261109130000_gradebook_topics.down.sql.txt
DO $$ BEGIN
  IF to_regclass('public.gradebook_topics') IS NOT NULL THEN RAISE EXCEPTION 'down left the table'; END IF;
END $$;
\i supabase/migrations/20261109130000_gradebook_topics.sql

CREATE TEMP TABLE t AS
SELECT c.id AS class_id, c.gradebook_id,
  (SELECT user_id FROM user_roles WHERE class_id = c.id AND role = 'instructor' ORDER BY id LIMIT 1) AS instructor,
  (SELECT user_id FROM user_roles WHERE class_id = c.id AND role = 'grader' ORDER BY id LIMIT 1) AS grader,
  (SELECT user_id FROM user_roles WHERE class_id = c.id AND role = 'student' ORDER BY id LIMIT 1) AS student
FROM classes c WHERE c.name LIKE 'CS 4535%' ORDER BY c.id DESC LIMIT 1;
GRANT SELECT ON t TO authenticated;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
END $$;
CREATE OR REPLACE FUNCTION pg_temp.raises(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.raises(text), pg_temp.as_user(uuid), pg_temp.as_service() TO authenticated;
CREATE OR REPLACE FUNCTION pg_temp.col(p_slug text) RETURNS bigint LANGUAGE sql AS $$
  SELECT id FROM gradebook_columns WHERE gradebook_id = (SELECT gradebook_id FROM t) AND slug = p_slug
$$;
GRANT EXECUTE ON FUNCTION pg_temp.col(text) TO authenticated;

\echo '=== instructor builds a topic; constraints hold ==='
SELECT pg_temp.as_user((SELECT instructor FROM t));
DO $$
DECLARE v_topic bigint; v_other bigint; v_standing bigint; v_expr text;
BEGIN
  v_topic := gradebook_topic_create((SELECT gradebook_id FROM t), 'Quizzes topic');
  PERFORM gradebook_columns_set_topic(pg_temp.col('quiz-1'), v_topic, NULL);   -- attempt 1
  PERFORM gradebook_columns_set_topic(pg_temp.col('quiz-2'), v_topic, NULL);   -- attempt 2
  PERFORM gradebook_columns_set_topic(pg_temp.col('quiz-4'), v_topic, 3);
  IF (SELECT array_agg(attempt_number ORDER BY attempt_number) FROM gradebook_columns WHERE topic_id = v_topic) <> ARRAY[1, 2, 3] THEN
    RAISE EXCEPTION 'attempt numbering wrong'; END IF;

  IF NOT pg_temp.raises(format('SELECT gradebook_columns_set_topic(%s, %s, 2)', pg_temp.col('quiz-5'), v_topic)) THEN
    RAISE EXCEPTION 'a second attempt 2 was accepted'; END IF;
  IF NOT pg_temp.raises(format('UPDATE gradebook_columns SET topic_id = %s WHERE id = %s', v_topic, pg_temp.col('quiz-5'))) THEN
    RAISE EXCEPTION 'topic without attempt number accepted'; END IF;
  IF NOT pg_temp.raises(format('SELECT gradebook_columns_set_topic(%s, %s, 0)', pg_temp.col('quiz-5'), v_topic)) THEN
    RAISE EXCEPTION 'attempt 0 accepted'; END IF;
  IF NOT pg_temp.raises(format($q$SELECT gradebook_topic_create(%s, 'quizzes TOPIC')$q$, (SELECT gradebook_id FROM t))) THEN
    RAISE EXCEPTION 'case-insensitive duplicate topic name accepted'; END IF;

  -- best: a new standing column with a generated expression over all three attempts, in order.
  v_standing := gradebook_topic_set_standing(v_topic, NULL, 'best');
  SELECT score_expression INTO v_expr FROM gradebook_columns WHERE id = v_standing;
  IF v_expr <> 'max(map([gradebook_columns("quiz-1"), gradebook_columns("quiz-2"), gradebook_columns("quiz-4")], f(x) = x.is_excused ? null : x.score))' THEN
    RAISE EXCEPTION 'unexpected best expression: %', v_expr; END IF;
  IF (SELECT dependencies FROM gradebook_columns WHERE id = v_standing)
     <> jsonb_build_object('gradebook_columns', jsonb_build_array(pg_temp.col('quiz-1'), pg_temp.col('quiz-2'), pg_temp.col('quiz-4'))) THEN
    RAISE EXCEPTION 'unexpected dependencies'; END IF;

  -- The standing cannot become an attempt, nor an attempt a standing.
  IF NOT pg_temp.raises(format('SELECT gradebook_columns_set_topic(%s, %s, NULL)', v_standing, v_topic)) THEN
    RAISE EXCEPTION 'standing joined its own topic as an attempt'; END IF;
  IF NOT pg_temp.raises(format($q$SELECT gradebook_topic_set_standing(%s, %s, 'best')$q$, v_topic, pg_temp.col('quiz-1'))) THEN
    RAISE EXCEPTION 'attempt became the standing'; END IF;

  -- Regeneration: a new attempt is picked up; switching rule rewrites the expression.
  PERFORM gradebook_columns_set_topic(pg_temp.col('quiz-5'), v_topic, NULL);
  SELECT score_expression INTO v_expr FROM gradebook_columns WHERE id = v_standing;
  IF v_expr NOT LIKE '%gradebook_columns("quiz-5")%' THEN RAISE EXCEPTION 'new attempt not in expression: %', v_expr; END IF;
  PERFORM gradebook_topic_set_standing(v_topic, v_standing, 'latest');
  SELECT score_expression INTO v_expr FROM gradebook_columns WHERE id = v_standing;
  IF v_expr NOT LIKE '(gradebook_columns("quiz-5").score != null and not gradebook_columns("quiz-5").is_excused) ? gradebook_columns("quiz-5").score : (%' THEN
    RAISE EXCEPTION 'latest must check the last attempt first: %', v_expr; END IF;

  -- Removing an attempt regenerates; deleting the topic clears its attempts and keeps the column.
  PERFORM gradebook_columns_set_topic(pg_temp.col('quiz-5'), NULL, NULL);
  SELECT score_expression INTO v_expr FROM gradebook_columns WHERE id = v_standing;
  IF v_expr LIKE '%quiz-5%' THEN RAISE EXCEPTION 'removed attempt still in expression'; END IF;
  DELETE FROM gradebook_topics WHERE id = v_topic;
  IF EXISTS (SELECT 1 FROM gradebook_columns WHERE topic_id = v_topic OR (topic_id IS NULL AND attempt_number IS NOT NULL)) THEN
    RAISE EXCEPTION 'attempts not cleared on topic delete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM gradebook_columns WHERE id = v_standing) THEN RAISE EXCEPTION 'standing column deleted'; END IF;
END $$;

\echo '=== RLS: students, graders, other courses ==='
DO $$
DECLARE v_hidden bigint; v_visible bigint;
BEGIN
  v_hidden := gradebook_topic_create((SELECT gradebook_id FROM t), 'Hidden topic');
  PERFORM gradebook_columns_set_topic(pg_temp.col('curve-adjustment'), v_hidden, NULL);   -- instructor-only
  v_visible := gradebook_topic_create((SELECT gradebook_id FROM t), 'Exam topic');
  PERFORM gradebook_columns_set_topic(pg_temp.col('exam-1'), v_visible, NULL);
  PERFORM set_config('gcg.hidden', v_hidden::text, true);
  PERFORM set_config('gcg.visible', v_visible::text, true);
END $$;
SELECT pg_temp.as_user((SELECT student FROM t));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM gradebook_topics WHERE id = current_setting('gcg.hidden')::bigint) THEN
    RAISE EXCEPTION 'student sees a topic of hidden columns'; END IF;
  IF NOT EXISTS (SELECT 1 FROM gradebook_topics WHERE id = current_setting('gcg.visible')::bigint) THEN
    RAISE EXCEPTION 'student cannot see a visible topic'; END IF;
  IF NOT pg_temp.raises(format($q$SELECT gradebook_topic_create(%s, 'x')$q$, (SELECT gradebook_id FROM t))) THEN
    RAISE EXCEPTION 'student created a topic'; END IF;
  IF NOT pg_temp.raises(format('SELECT gradebook_topics_suggest(%s)', (SELECT gradebook_id FROM t))) THEN
    RAISE EXCEPTION 'student ran suggest'; END IF;
  DELETE FROM gradebook_topics;
END $$;
SELECT pg_temp.as_user((SELECT grader FROM t));
DO $$ BEGIN
  IF (SELECT count(*) FROM gradebook_topics) <> 2 THEN RAISE EXCEPTION 'grader should see both topics'; END IF;
  IF NOT pg_temp.raises(format($q$SELECT gradebook_topic_set_standing(%s, NULL, 'best')$q$, current_setting('gcg.visible'))) THEN
    RAISE EXCEPTION 'grader set a standing'; END IF;
END $$;

\echo '=== Suggest on a CS 2100-shaped gradebook ==='
SELECT pg_temp.as_service();
CREATE TEMP TABLE t2100 AS SELECT NULL::bigint AS class_id, NULL::bigint AS gradebook_id;
DO $$
DECLARE v_class bigint; v_gb bigint; r record; v_ids bigint[];
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO classes (name) VALUES ('gcg CS 2100 shape') RETURNING id INTO v_class;
  INSERT INTO gradebooks (class_id, name) VALUES (v_class, 'cs2100') RETURNING id INTO v_gb;
  UPDATE classes SET gradebook_id = v_gb WHERE id = v_class;
  INSERT INTO gradebook_columns (class_id, gradebook_id, slug, name, sort_order, max_score) VALUES
    (v_class, v_gb, 'cce_1', 'Attempt 1: Coupling, Cohesion, and Encapsulation', 0, 4),
    (v_class, v_gb, 'cce_2', 'Attempt 2: Coupling, Cohesion, and Encapsulation', 1, 4),
    (v_class, v_gb, '3cce', 'Attempt 3: Coupling', 2, 4),
    (v_class, v_gb, 'svm_1', 'Attempt 1: Stakeholder-value Matrices', 4, 4),
    (v_class, v_gb, '2svm', 'Attempt 2: Stakeholder-value Matrices', 5, 4),
    (v_class, v_gb, 'svm_2', 'Attempt 2: Stakeholder-value Matrices', 6, 4),
    (v_class, v_gb, 'hw1', 'HW1', 8, 100),
    (v_class, v_gb, 'hw2', 'HW2', 9, 100);
  INSERT INTO gradebook_columns (class_id, gradebook_id, slug, name, sort_order, max_score, score_expression, dependencies)
  SELECT v_class, v_gb, x.slug, x.name, x.so, 4, x.expr,
         jsonb_build_object('gradebook_columns', (SELECT jsonb_agg(id) FROM gradebook_columns WHERE gradebook_id = v_gb AND slug = ANY (x.deps)))
  FROM (VALUES
    ('topic_cce', 'Coupling, Cohesion, and Encapsulation Topic Max Score', 3, 'max(gradebook_columns("cce*"))', ARRAY['cce_1', 'cce_2']),
    ('topic_svm', 'Stakeholder-value Matrices Topic Max Score', 7, 'max(gradebook_columns("svm*"))', ARRAY['svm_1', 'svm_2']),
    ('avg-hw', 'Homework Average', 10, 'mean(gradebook_columns("hw*"))', ARRAY['hw1', 'hw2'])
  ) AS x(slug, name, so, expr, deps);
  -- avg-hw shares its inputs with nothing, so make it look like the real thing: a letter column reads them too.
  INSERT INTO gradebook_columns (class_id, gradebook_id, slug, name, sort_order, max_score, score_expression, dependencies)
  VALUES (v_class, v_gb, 'letter', 'Letter', 11, 11, 'gradebook_columns("hw1")',
          jsonb_build_object('gradebook_columns', (SELECT jsonb_agg(id) FROM gradebook_columns WHERE gradebook_id = v_gb AND slug IN ('hw1'))));
  SET LOCAL session_replication_role = origin;
  UPDATE t2100 SET class_id = v_class, gradebook_id = v_gb;
END $$;
DO $$
DECLARE v_s jsonb; v_names text; v_cce jsonb; v_n integer; v_expr text;
BEGIN
  v_s := gradebook_topics_suggest((SELECT gradebook_id FROM t2100));
  SELECT string_agg(x->>'name', ' | ' ORDER BY x->>'name') INTO v_names FROM jsonb_array_elements(v_s->'topics') x;
  IF v_names <> 'Coupling, Cohesion, and Encapsulation | Stakeholder-value Matrices' THEN
    RAISE EXCEPTION 'unexpected topics: %', v_names; END IF;
  SELECT x INTO v_cce FROM jsonb_array_elements(v_s->'topics') x WHERE x->>'name' LIKE 'Coupling%';
  IF (SELECT string_agg((SELECT slug FROM gradebook_columns WHERE id = (a->>'column_id')::bigint) || '#' || (a->>'attempt_number'), ',')
      FROM jsonb_array_elements(v_cce->'attempts') a) <> 'cce_1#1,cce_2#2,3cce#3' THEN
    RAISE EXCEPTION 'the glob-missed third attempt was not recovered: %', v_cce; END IF;
  IF jsonb_array_length(v_s->'conflicts') <> 1 OR (v_s->'conflicts'->0->>'attempt_number')::int <> 2 THEN
    RAISE EXCEPTION 'duplicate attempt 2 not reported: %', v_s->'conflicts'; END IF;

  -- Applying it as-is fails as a whole on the duplicate...
  IF NOT pg_temp.raises(format('SELECT gradebook_topics_apply_suggestion(%s, %L::jsonb)', (SELECT gradebook_id FROM t2100), v_s)) THEN
    RAISE EXCEPTION 'conflicting suggestion applied'; END IF;
  IF EXISTS (SELECT 1 FROM gradebook_topics WHERE gradebook_id = (SELECT gradebook_id FROM t2100)) THEN
    RAISE EXCEPTION 'partial apply left topics behind'; END IF;

  -- ...and once the instructor drops the duplicate, applies without touching any expression.
  v_s := jsonb_set(v_s, '{topics}', (
    SELECT jsonb_agg(CASE WHEN x->>'name' LIKE 'Stakeholder%'
      THEN jsonb_set(x, '{attempts}', (SELECT jsonb_agg(a) FROM jsonb_array_elements(x->'attempts') a
                                        WHERE (a->>'column_id')::bigint <> (SELECT id FROM gradebook_columns WHERE gradebook_id = (SELECT gradebook_id FROM t2100) AND slug = '2svm')))
      ELSE x END)
    FROM jsonb_array_elements(v_s->'topics') x));
  SELECT score_expression INTO v_expr FROM gradebook_columns WHERE gradebook_id = (SELECT gradebook_id FROM t2100) AND slug = 'topic_cce';
  v_n := gradebook_topics_apply_suggestion((SELECT gradebook_id FROM t2100), v_s);
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected 2 topics, got %', v_n; END IF;
  IF (SELECT score_expression FROM gradebook_columns WHERE gradebook_id = (SELECT gradebook_id FROM t2100) AND slug = 'topic_cce') <> v_expr THEN
    RAISE EXCEPTION 'applying a suggestion rewrote an instructor expression'; END IF;
  IF (SELECT standing_rule FROM gradebook_topics WHERE gradebook_id = (SELECT gradebook_id FROM t2100) AND name LIKE 'Coupling%') IS NOT NULL THEN
    RAISE EXCEPTION 'suggested topic got a generated rule'; END IF;

  -- Opting into 'best' now fixes the glob: the third attempt is in the expression.
  PERFORM gradebook_topic_set_standing(
    (SELECT id FROM gradebook_topics WHERE gradebook_id = (SELECT gradebook_id FROM t2100) AND name LIKE 'Coupling%'),
    (SELECT id FROM gradebook_columns WHERE gradebook_id = (SELECT gradebook_id FROM t2100) AND slug = 'topic_cce'),
    'best');
  IF (SELECT score_expression FROM gradebook_columns WHERE gradebook_id = (SELECT gradebook_id FROM t2100) AND slug = 'topic_cce')
     NOT LIKE '%gradebook_columns("3cce")%' THEN
    RAISE EXCEPTION 'best standing misses the third attempt'; END IF;
END $$;

\echo ''
\echo 'ALL CHECKS PASSED'
ROLLBACK;
