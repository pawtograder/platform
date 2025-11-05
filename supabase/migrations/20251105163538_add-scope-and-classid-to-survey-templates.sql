-- Add scope column to survey_templates table
ALTER TABLE survey_templates
ADD COLUMN IF NOT EXISTS scope TEXT CHECK (scope IN ('course', 'global')) DEFAULT 'course';

-- Add class_id column to survey_templates table
ALTER TABLE survey_templates
ADD COLUMN IF NOT EXISTS class_id INTEGER;
