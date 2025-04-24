alter table "public"."grader_results" drop constraint "grader_results_submission_id_key";

CREATE INDEX grader_result_output_grader_result_id_idx ON public.grader_result_output USING btree (grader_result_id);

CREATE UNIQUE INDEX grader_results_submission_id_key_uniq ON public.grader_results USING btree (submission_id);

CREATE UNIQUE INDEX unique_repo_name ON public.repositories USING btree (repository);

alter table "public"."grader_results" add constraint "grader_results_submission_id_key_uniq" UNIQUE using index "grader_results_submission_id_key_uniq";

alter table "public"."repositories" add constraint "unique_repo_name" UNIQUE using index "unique_repo_name";