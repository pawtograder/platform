-- Drop deprecated poll tables from legacy
DROP TABLE IF EXISTS public.poll_question_results CASCADE;
DROP TABLE IF EXISTS public.poll_question_answers CASCADE;
DROP TABLE IF EXISTS public.poll_response_answers CASCADE;
DROP TABLE IF EXISTS public.poll_responses CASCADE;
DROP TABLE IF EXISTS public.poll_questions CASCADE;
DROP TABLE IF EXISTS public.polls CASCADE;
