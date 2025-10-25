# Survey Implementation Backend Components Analysis

This document outlines all the database tables, relationships, functions, and other backend components that the current survey implementation depends on, along with critical issues that need to be fixed.

## Database Tables

### 1. `surveys` Table ✅ **CORRECTLY IMPLEMENTED**

**Purpose:** Stores survey definitions and metadata

**Schema:**

```sql
CREATE TABLE surveys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id UUID NOT NULL DEFAULT gen_random_uuid(),
    class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    class_section_id BIGINT REFERENCES class_sections(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    json TEXT NOT NULL DEFAULT '',
    status survey_status NOT NULL DEFAULT 'draft',
    allow_response_editing BOOLEAN NOT NULL DEFAULT FALSE,
    due_date TIMESTAMPTZ DEFAULT NULL,
    validation_errors TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    version INTEGER NOT NULL DEFAULT 1
);
```

**Columns:**

- `id` (UUID, Primary Key) - Default: gen_random_uuid()
- `survey_id` (UUID, NOT NULL) - Default: gen_random_uuid() - Groups survey versions together
- `class_id` (BIGINT, NOT NULL) - Foreign Key to classes(id) ON DELETE CASCADE
- `class_section_id` (BIGINT, NULLABLE) - Foreign Key to class_sections(id) ON DELETE CASCADE
- `created_by` (UUID, NOT NULL) - Foreign Key to profiles(id) ON DELETE CASCADE
- `title` (TEXT, NOT NULL) - Survey title
- `description` (TEXT, NULLABLE) - Survey description
- `json` (TEXT, NOT NULL) - Default: '' - SurveyJS configuration/definition
- `status` (survey_status ENUM, NOT NULL) - Default: 'draft' - Survey status
- `allow_response_editing` (BOOLEAN, NOT NULL) - Default: FALSE - Whether students can edit responses
- `due_date` (TIMESTAMPTZ, NULLABLE) - Survey due date
- `validation_errors` (TEXT, NULLABLE) - JSON validation error messages
- `created_at` (TIMESTAMPTZ, NOT NULL) - Default: NOW()
- `updated_at` (TIMESTAMPTZ, NOT NULL) - Default: NOW()
- `deleted_at` (TIMESTAMPTZ, NULLABLE) - Soft delete timestamp
- `version` (INTEGER, NOT NULL) - Default: 1 - Survey version number

**Indexes:**

- Primary key on `id`
- Unique constraint on `(survey_id, is_latest_version)` where `is_latest_version = true`

### 2. `survey_responses` Table ❌ **CRITICAL ISSUES**

**Purpose:** Stores individual student responses to surveys

**Current Schema (PROBLEMATIC):**

```sql
CREATE TABLE survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,  -- ❌ WRONG COLUMN NAME
  response JSONB NOT NULL DEFAULT '{}'::jsonb,                          -- ❌ WRONG COLUMN NAME
  submitted_at TIMESTAMPTZ DEFAULT NULL,
  is_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Expected Schema (REQUIRED):**

```sql
CREATE TABLE survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,   -- ✅ CORRECT
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,                           -- ✅ CORRECT
  submitted_at TIMESTAMPTZ DEFAULT NULL,
  is_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ DEFAULT NULL                                   -- ✅ MISSING
);
```

**Issues:**

1. **Column Name Mismatch:** Database has `profile_id` but frontend expects `student_id`
2. **Response Data Mismatch:** Database has `response` but frontend expects `answers`
3. **Missing Soft Delete:** No `deleted_at` column for soft delete functionality
4. **Wrong Unique Constraint:** Database has `(survey_id, profile_id)` but frontend expects `(survey_id, student_id)`

### 3. `survey_templates` Table ✅ **CORRECTLY IMPLEMENTED**

**Purpose:** Stores reusable survey templates

**Schema:**

```sql
CREATE TABLE survey_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    template JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Database Functions and Triggers

### 1. `update_updated_at_survey_column()` Function ✅ **WORKING**

**Purpose:** Automatically updates the `updated_at` timestamp

```sql
CREATE OR REPLACE FUNCTION update_updated_at_survey_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Triggers:**

- `update_surveys_updated_at` - Updates `surveys.updated_at`
- `update_survey_responses_updated_at` - Updates `survey_responses.updated_at`
- `update_survey_templates_updated_at` - Updates `survey_templates.updated_at`

### 2. `set_survey_submitted_at()` Function ✅ **WORKING**

**Purpose:** Automatically sets `submitted_at` when survey is submitted

```sql
CREATE OR REPLACE FUNCTION set_survey_submitted_at()
RETURNS TRIGGER AS $$
BEGIN
  -- Only set submitted_at when is_submitted changes from false to true
  IF NEW.is_submitted = TRUE AND (OLD.is_submitted = FALSE OR OLD.is_submitted IS NULL) THEN
    NEW.submitted_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Trigger:**

- `set_survey_submitted_at_trigger` - Updates `survey_responses.submitted_at`

## Frontend Code Usage Analysis

### ✅ **Working Components:**

1. **Survey Creation** (`app/course/[course_id]/manage/surveys/new/page.tsx`):

   - Uses `surveys` table correctly
   - All columns match: `survey_id`, `class_id`, `created_by`, `title`, `description`, `json`, `status`, `allow_response_editing`, `due_date`, `validation_errors`

2. **Survey Management** (`app/course/[course_id]/manage/surveys/page.tsx`):

   - Queries `surveys` table correctly
   - Uses `deleted_at` for soft delete filtering ✅

3. **Survey Display** (`app/course/[course_id]/surveys/page.tsx`):
   - Queries `surveys` table correctly
   - **BUT** queries `survey_responses` with wrong column names ❌

### ❌ **Broken Components:**

1. **Survey Response Submission** (`app/course/[course_id]/surveys/[survey_id]/submit.ts`):

   ```typescript
   // ❌ WRONG - Database has 'profile_id', not 'student_id'
   student_id: studentId,

   // ❌ WRONG - Database has 'response', not 'answers'
   response: responseData,

   // ❌ WRONG - Constraint is on 'profile_id', not 'student_id'
   onConflict: "survey_id,student_id"
   ```

2. **Survey Response Viewing** (`app/course/[course_id]/manage/surveys/[survey_id]/responses/page.tsx`):

   ```typescript
   // ✅ CORRECT - This join works
   profiles!profile_id (name)

   // ❌ WRONG - Expects 'student_id' in response data
   .eq("student_id", user.id)
   ```

3. **Survey Response Display** (`app/course/[course_id]/manage/surveys/[survey_id]/responses/SurveyResponsesView.tsx`):

   ```typescript
   // ❌ WRONG - Database has 'response', not 'answers'
   answers: {
     satisfaction?: string;
     helpful_aspects?: string;
     comments?: string;
   };

   // ❌ WRONG - Accessing 'answers' property that doesn't exist
   {response.answers?.satisfaction || "—"}
   ```

## Required Fixes

### **Option 1: Update Database Schema (Recommended)**

```sql
-- Add missing columns to survey_responses
ALTER TABLE survey_responses
ADD COLUMN student_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
ADD COLUMN answers JSONB DEFAULT '{}'::jsonb,
ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Update existing data
UPDATE survey_responses SET
  student_id = profile_id,
  answers = response;

-- Drop old columns
ALTER TABLE survey_responses
DROP COLUMN profile_id,
DROP COLUMN response;

-- Update unique constraint
DROP INDEX idx_responses_survey_user;
CREATE UNIQUE INDEX idx_responses_survey_user ON survey_responses(survey_id, student_id);
```

### **Option 2: Update Frontend Code**

Update all frontend code to use:

- `profile_id` instead of `student_id`
- `response` instead of `answers`
- Remove references to `deleted_at` in `survey_responses`

## Summary

The **`surveys` table is correctly implemented** and matches the frontend expectations perfectly. However, the **`survey_responses` table has critical mismatches** that prevent the survey response functionality from working. The frontend code was written expecting different column names than what exists in the database, causing the "Error loading survey responses" issue.

The most straightforward fix is to update the database schema to match the frontend expectations, as this requires fewer code changes and maintains consistency with the existing frontend implementation.

## Files Affected by Issues

### Database Schema Issues:

- `supabase/migrations/20251018223435_update_survey.sql` - Contains the problematic schema

### Frontend Files with Mismatched Column Names:

- `app/course/[course_id]/surveys/[survey_id]/submit.ts` - Uses `student_id` and `answers`
- `app/course/[course_id]/surveys/page.tsx` - Queries with `student_id`
- `app/course/[course_id]/manage/surveys/[survey_id]/responses/SurveyResponsesView.tsx` - Expects `answers` property
- `app/course/[course_id]/manage/surveys/[survey_id]/responses/page.tsx` - Has debugging comments about missing columns

### Working Frontend Files:

- `app/course/[course_id]/manage/surveys/new/page.tsx` - Correctly uses `surveys` table
- `app/course/[course_id]/manage/surveys/page.tsx` - Correctly queries `surveys` table
- `app/course/[course_id]/manage/surveys/SurveysTable.tsx` - Correctly uses `surveys` table
