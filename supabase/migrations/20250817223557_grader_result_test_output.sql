-- Add `extra_data` column to `grader_result_test_output` table
ALTER TABLE "public"."grader_result_test_output" 
ADD COLUMN "extra_data" jsonb DEFAULT NULL;
