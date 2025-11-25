# Survey System Implementation - Frontend Code Changes

## Overview

This commit implements the frontend components for a comprehensive survey system within the course management platform. The implementation covers instructor survey management and student survey viewing (empty state).

## Current Database Schema Requirements

### Surveys Table

The frontend expects the following columns in the `surveys` table:

- `id` (UUID) - Primary key for Supabase
- `survey_id` (UUID) - Groups survey versions together
- `version` (INTEGER) - Version number for the survey
- `class_id` (BIGINT) - Foreign key to classes table
- `created_by` (UUID) - Foreign key to profiles table
- `title` (TEXT) - Survey title
- `description` (TEXT) - Optional survey description
- `json` (JSONB) - SurveyJS configuration
- `status` (ENUM: 'draft', 'published', 'closed') - Survey status
- `created_at` (TIMESTAMPTZ) - Creation timestamp
- `updated_at` (TIMESTAMPTZ) - Last update timestamp
- `allow_response_editing` (BOOLEAN) - Whether students can edit responses
- `due_date` (TIMESTAMPTZ) - Optional due date
- `validation_errors` (TEXT) - JSON validation errors
- `deleted_at` (TIMESTAMPTZ) - Soft delete timestamp

### Survey Responses Table

The frontend expects the following columns in the `survey_responses` table:

- `id` (UUID) - Primary key
- `survey_id` (UUID) - Foreign key to surveys.id
- `profile_id` (UUID) - Foreign key to profiles.id
- `response` (JSONB) - Student response data
- `submitted_at` (TIMESTAMPTZ) - Submission timestamp
- `updated_at` (TIMESTAMPTZ) - Last update timestamp
- `is_submitted` (BOOLEAN) - Whether response is submitted
- `deleted_at` (TIMESTAMPTZ) - Soft delete timestamp

### Survey Templates Table

The frontend expects the following columns in the `survey_templates` table:

- `id` (UUID) - Primary key
- `title` (TEXT) - Template title
- `description` (TEXT) - Template description
- `template` (JSONB) - SurveyJS template configuration
- `created_at` (TIMESTAMPTZ) - Creation timestamp
- `updated_at` (TIMESTAMPTZ) - Last update timestamp
- `created_by` (UUID) - Foreign key to profiles table
- `version` (INTEGER) - Template version

## Story Implementation Status

### Phase 1: Setup and Foundation

#### Story 1.1 (Frontend): Surveys routing structure ✅ **COMPLETED**

**Implementation:**

- Added `/course/[course_id]/surveys` route for student view
- Added `/course/[course_id]/manage/surveys` route for instructor view
- Added `/course/[course_id]/manage/surveys/new` route for survey creation
- Added `/course/[course_id]/manage/surveys/[survey_id]/responses` route for viewing responses

**Files Created/Modified:**

- `app/course/[course_id]/surveys/page.tsx` - Student surveys page
- `app/course/[course_id]/manage/surveys/page.tsx` - Instructor manage surveys page
- `app/course/[course_id]/manage/surveys/new/page.tsx` - Survey creation page
- `app/course/[course_id]/manage/surveys/[survey_id]/responses/page.tsx` - Survey responses page

#### Story 1.2 (Database): Create tables in Supabase ⚠️ **PARTIALLY COMPLETED**

**Status:** Database tables created but frontend expects additional columns not in original spec:

- Added `validation_errors` column for JSON validation error storage
- Added `deleted_at` column for soft delete functionality
- Added `due_date` column for survey deadlines

#### Story 1.4 (Frontend): Fetch and render survey (read-only) ❌ **NOT IMPLEMENTED**

**Status:** SurveyJS integration not yet implemented

### Phase 2: Instructor Functionality

#### Story 2.1 (Instructor): Create survey page **PARTIALLY COMPLETED**

**Implementation:**

- Complete survey creation form with JSON input, title, description, status, due date, and response editing options
- JSON validation with error handling
- Draft auto-save functionality
- Status-based routing (draft vs published)
- Still need to implement Preview functionality

**Files Created:**

- `app/course/[course_id]/manage/surveys/new/form.tsx` - Survey creation form
- `app/course/[course_id]/manage/surveys/new/page.tsx` - Survey creation page wrapper

**Key Features:**

- **Form Fields:**
  - Title (required)
  - Description (optional)
  - JSON configuration (required for publishing)
  - Status selection (Draft/Published)
  - Due date (optional)
  - Allow response editing checkbox (custom styled with light/dark mode support)
- **Validation:**
  - JSON parsing validation for published surveys
  - Draft saves bypass validation
  - Error handling with fallback to draft creation
- **Navigation:**
  - "Back to Surveys" - Simple navigation (no auto-save)
  - "Cancel" - Auto-saves as draft before navigation
  - "Save Survey" - Saves and redirects based on status
- **Custom Styling:**
  - Adaptive light/dark theme support using `useColorModeValue`
  - Consistent color scheme across all form elements

#### Story 2.2 (Instructor): Publish or Close a Survey

**Implementation:**

- Publish functionality in survey creation form
- Close functionality in surveys table actions menu
- Status validation and error handling

**Key Features:**

- **Publish Logic:**
  - Validates JSON configuration
  - Updates status to 'published'
  - Shows success/error toasts
  - Tracks analytics events
- **Close Logic:**
  - Updates status to 'closed'
  - Prevents further student submissions
  - Shows confirmation toast

#### Story 2.3 (Instructor): Edit an Existing Survey ❌ **NOT IMPLEMENTED**

**Status:** Versioning system not yet implemented

#### Story 2.4 (Instructor): View all surveys for a course ✅ **COMPLETED**

**Implementation:**

- Dynamic survey list with status badges
- Response count tracking
- Action menus for each survey
- Empty state handling

**Files Created:**

- `app/course/[course_id]/manage/surveys/SurveysTable.tsx` - Survey table component
- `app/course/[course_id]/manage/surveys/SurveysHeader.tsx` - Page header component
- `app/course/[course_id]/manage/surveys/EmptySurveysState.tsx` - Empty state component

**Key Features:**

- **Table Columns:**
  - Title (clickable, routes based on status)
  - Status (color-coded badges)
  - Version (badge display)
  - Response count (X/Y format)
  - Created date (timezone-aware)
  - Actions (dropdown menu)
- **Action Menu Options:**
  - **Draft surveys:** Edit, Publish, Delete
  - **Published surveys:** View Responses, Edit (New Version), Close, Delete
  - **Closed surveys:** View Responses, Re-open, Delete
- **Status-based Routing:**
  - Drafts → Edit page
  - Published → Edit page (new version)
  - Closed → Read-only view

#### Story 2.5 (Instructor): View Survey Responses ✅ **COMPLETED**

**Implementation:**

- Complete responses view with summary statistics
- Dynamic table with student responses
- Empty state handling
- Export functionality (UI only)

**Files Created:**

- `app/course/[course_id]/manage/surveys/[survey_id]/responses/SurveyResponsesView.tsx` - Responses view component

**Key Features:**

- **Summary Cards:**
  - Total Responses count
  - Response Rate percentage
  - Average Completion Time (calculated from created_at to submitted_at)
- **Responses Table:**
  - Student Name column
  - Submitted At column (timezone-aware formatting)
  - **Mock Question Columns:** Q1: SATISFACTION, Q2: HELPFUL ASPECTS, Q3: COMMENTS
  - Empty state with "Students haven't submitted any responses to this survey."
- **Navigation:**
  - "Back to Surveys" button (simple navigation)
  - "Export to CSV" button (placeholder functionality)

**Note:** Question columns are currently hardcoded as Q1, Q2, Q3 and expect specific JSON structure (`satisfaction`, `helpful_aspects`, `comments`). This will be replaced with dynamic column generation based on actual survey JSON structure.

#### Story 2.6 (Instructor): Delete existing survey ✅ **COMPLETED**

**Implementation:**

- Soft delete functionality
- Confirmation dialogs
- Response count validation
- Data preservation

**Key Features:**

- **Soft Delete Logic:**
  - Sets `deleted_at` timestamp on survey and all responses
  - Preserves all response data for record keeping
  - Updates RLS policies to filter deleted records
- **Confirmation Dialogs:**
  - Different messages for surveys with/without responses
  - Clear explanation of data preservation
- **Analytics Tracking:**
  - Tracks deletion events with response count
  - Flags soft delete for audit purposes

### Phase 3: Student Functionality

#### Story 3.1 (Student): View available surveys ✅ **COMPLETED**

**Implementation:**

- Student surveys page with empty state
- Only shows published surveys (filtered by status)
- Full color mode support with light/dark theme adaptation

**Files Created:**

- `app/course/[course_id]/surveys/page.tsx` - Student surveys page

**Key Features:**

- **Empty State:**
  - "No surveys available yet" message
  - "Your instructor hasn't posted any surveys. Check back later!" description
  - Consistent styling with instructor views
- **Color Mode Support:**
  - Adaptive light/dark theme styling using `useColorModeValue`
  - Consistent with platform design system
  - Same color scheme as manage surveys empty state

#### Story 3.2 (Student): Take and submit survey ❌ **NOT IMPLEMENTED**

**Status:** SurveyJS integration not yet implemented - only empty state available

#### Story 3.3 (Student): View submitted surveys ❌ **NOT IMPLEMENTED**

**Status:** Student response tracking not yet implemented - only empty state available

### Phase 4: Permissions & Polishing

#### Story 4.1 (Database): Strengthen RLS and validation ⚠️ **PARTIALLY COMPLETED**

**Status:** RLS policies implemented but frontend doesn't enforce all constraints

#### Story 4.2 (Frontend): Add publish and close toggles ✅ **COMPLETED**

**Implementation:**

- Publish button in survey creation form
- Close button in surveys table actions menu
- Status-based UI updates

#### Story 4.3 UI Polish and Error States **PARTIALLY COMPLETED**

**Implementation:**

- Comprehensive toast notifications
- Loading states for all async operations
- Error handling with fallback mechanisms
- Empty state components
- Color mode support throughout

**Key Features:**

- **Toast Notifications:**
  - Success: "Survey Published", "Draft Saved", "Survey Closed"
  - Warning: "Survey Saved as Draft" (validation errors)
  - Error: Detailed error messages with fallback options
- **Loading States:**
  - Form submission loading
  - Database operation loading
  - Navigation loading
- **Error Handling:**
  - JSON validation errors
  - Database connection errors
  - Network timeout handling
  - Graceful degradation

#### Story 4.4 Live updates to data in frontend ❌ **NOT IMPLEMENTED**

**Status:** Real-time updates not yet implemented

## Recent Updates and Improvements

### Checkbox Implementation and Color Mode System

**Latest Changes (Latest Version):**

- **Custom Checkbox Styling:** Implemented layered checkbox approach with separate background and control elements
- **Color Mode Integration:** Full light/dark theme support using custom `useColorModeValue` hook
- **Form Pattern Alignment:** Refactored to match assignments form pattern using `Fieldset.Root`, `Fieldset.Content`, and `Field` components
- **State Management Simplification:** Removed complex `watch` pattern in favor of direct `react-hook-form` register approach
- **Visual Consistency:** Ensured checkbox styling matches platform design system across all themes

**Technical Details:**

- **Layered Approach:** Background `Box` element with absolute positioning behind `Checkbox.Root`
- **Color Variables:** `checkboxBgColor`, `checkboxBorderColor`, `checkboxIconColor` for theme-aware styling
- **Form Integration:** Uses `register("allow_response_editing")` with `Checkbox.Root` pattern
- **Theme Support:** Automatic adaptation between light (`#FFFFFF` background, `#D2D2D2` border) and dark (`#1A1A1A` background, `#2D2D2D` border) modes

## Technical Implementation Details

### Color Mode Support

All components implement adaptive light/dark theme styling using `useColorModeValue`:

- **Dark Mode:** `#1A1A1A` backgrounds, `#2D2D2D` borders, `#FFFFFF` text
- **Light Mode:** `#E5E5E5` backgrounds, `#D2D2D2` borders, `#000000` text
- **Accent Colors:** `#22C55E` for primary actions, `#3182CE` for links
- **Checkbox Styling:** Custom layered implementation with separate background and control elements
- **Form Elements:** Consistent color scheme across inputs, buttons, and interactive components

### Form Validation

- **Draft Mode:** No validation, saves any JSON (including invalid)
- **Publish Mode:** Full JSON validation, falls back to draft on errors
- **Error Handling:** Comprehensive error messages with actionable feedback
- **Checkbox State:** Uses `react-hook-form` register pattern without custom state management

### Navigation Patterns

- **Simple Navigation:** Direct routing without side effects
- **Auto-save Navigation:** Saves current state before navigation
- **Status-based Routing:** Different routes based on survey status

### Analytics Integration

- **Event Tracking:** All major actions tracked with `useTrackEvent`
- **Event Types:** `survey_created`, `survey_published`, `survey_closed`, `survey_deleted`
- **Event Data:** Includes course_id, survey_id, status, and relevant metadata

## Current Limitations and Future Work

### Mock Data and Hardcoded Elements

1. **Survey Response Columns:** Currently hardcoded as Q1, Q2, Q3 expecting specific JSON structure
2. **Sample Templates:** "Load Sample Template" button is non-functional
3. **Export Functionality:** "Export to CSV" button is placeholder only
4. **User Authentication:** Uses placeholder "current_user" for created_by field
5. **Checkbox Implementation:** Uses custom layered approach with separate background and control elements for precise styling control

### Missing Features

1. **SurveyJS Integration:** Survey rendering and response collection not implemented
2. **Student Survey Interaction:** Only empty state implemented for student-facing survey functionality
3. **Versioning System:** Survey editing creates new versions instead of direct edits
4. **Real-time Updates:** No live data synchronization
5. **Advanced Filtering:** No sorting/filtering in responses table
6. **Template System:** Survey templates not yet implemented

## Dependencies and Blockers

### Database Schema Requirements

The frontend implementation requires the following database schema to be in place:

#### Required Tables and Columns

**Surveys Table:**

- All columns as specified in the schema requirements section
- `is_latest_version` field with automatic trigger management
- Soft delete support with `deleted_at` column
- Proper foreign key relationships to `classes` and `profiles` tables

**Survey Responses Table:**

- `profile_id` column (foreign key to profiles.id)
- `response` JSONB column for response data
- Soft delete support with `deleted_at` column

**Survey Templates Table:**

- All columns as specified in schema requirements
- Foreign key relationships to `classes` and `profiles` tables

#### Required Database Functions and Triggers

1. **`manage_survey_latest_version()` Function:**

   - Automatically manages `is_latest_version` field
   - Ensures exactly one row per `survey_id` has `is_latest_version = true`
   - Trigger: `manage_survey_latest_version_trigger`

2. **RLS Policies:**

   - Instructor access policies for survey management
   - Student access policies for published surveys only
   - Response access policies based on user roles

3. **Soft Delete Support:**
   - `deleted_at` columns on all survey-related tables
   - RLS policies that filter out soft-deleted records

#### Database Setup Requirements

The following database schema must be in place for the frontend to function:

1. **Core Survey Tables:**

   - `surveys` table with all required columns (id, survey_id, version, class_id, created_by, title, description, json, status, created_at, updated_at, allow_response_editing, due_date, validation_errors, deleted_at, is_latest_version)
   - `survey_responses` table with profile_id column (foreign key to profiles.id)
   - `survey_templates` table for future template functionality

2. **Survey Status Enum:**

   - `survey_status` enum type with values: 'draft', 'published', 'closed'

3. **Soft Delete Support:**

   - `deleted_at` TIMESTAMPTZ columns on surveys and survey_responses tables
   - RLS policies that filter out records where `deleted_at IS NOT NULL`

4. **Latest Version Management:**

   - `is_latest_version` boolean column on surveys table
   - Trigger function `manage_survey_latest_version()` that automatically manages version flags
   - Database trigger `manage_survey_latest_version_trigger` on surveys table

5. **RLS Policies:**

   - Instructor policies for survey management (create, read, update, delete)
   - Student policies for published surveys only (read)
   - Response policies based on user roles and course access

6. **Indexes:**
   - Index on `(survey_id, is_latest_version)` for efficient latest version queries
   - Index on `survey_id` for response lookups
   - Index on `deleted_at` for soft delete filtering

### Authentication Dependencies

- **User Authentication:** Currently uses placeholder "current_user" - needs integration with actual auth system
- **Role-based Access:** Requires proper user role detection for instructor vs student views
- **Course Access Control:** Needs verification that users have access to the specified course

### External Dependencies

1. **SurveyJS Integration:**

   - SurveyJS library installation and configuration
   - Survey rendering components
   - Response collection and validation

2. **Export Functionality:**

   - CSV export library (e.g., `papaparse` or similar)
   - File download handling

3. **Real-time Updates:**
   - Supabase realtime subscriptions
   - Live data synchronization

### Current Blockers

1. **Preview Functionality:** Survey preview in new tab not implemented
2. **Sample Templates:** Load sample template button is non-functional
3. **Export to CSV:** Placeholder functionality only
4. **SurveyJS Integration:** Core survey rendering not implemented
5. **Student Survey Interaction:** Only empty states available
6. **Versioning System:** Survey editing creates new versions instead of direct edits

### Testing Requirements

- **Database Setup:** Local Supabase instance with all migrations applied
- **Test Data:** Sample surveys and responses for testing
- **User Roles:** Test users with different role permissions
- **Color Mode Testing:** Verification of light/dark theme switching

## File Structure

```
app/course/[course_id]/
├── surveys/
│   └── page.tsx                    # Student surveys view
└── manage/surveys/
    ├── page.tsx                    # Instructor surveys list
    ├── SurveysTable.tsx            # Survey table component
    ├── SurveysHeader.tsx           # Page header component
    ├── EmptySurveysState.tsx       # Empty state component
    ├── new/
    │   ├── page.tsx                # Survey creation page
    │   └── form.tsx                # Survey creation form
    └── [survey_id]/
        └── responses/
            ├── page.tsx            # Responses page wrapper
            └── SurveyResponsesView.tsx  # Responses view component
```

This implementation provides a solid foundation for the survey system with comprehensive instructor management capabilities and proper error handling, while leaving room for future enhancements in student interaction and real-time features.
