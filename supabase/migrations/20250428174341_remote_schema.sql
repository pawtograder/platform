alter table "public"."submission_artifacts" add column "autograder_regression_test_id" bigint;

alter table "public"."submission_artifacts" add constraint "submission_artifacts_autograder_regression_test_id_fkey" FOREIGN KEY (autograder_regression_test_id) REFERENCES autograder_regression_test(id) not valid;

alter table "public"."submission_artifacts" validate constraint "submission_artifacts_autograder_regression_test_id_fkey";


