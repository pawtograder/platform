# Survey Responses Architecture Fix

## Problem Summary

The survey responses system was experiencing errors when trying to display student information because it was incorrectly attempting to join `survey_responses.student_id` directly with `profiles.id`. This failed because these columns represent different types of IDs.

## Database Architecture

### Tables and Relationships

1. **`auth.users`**: Supabase authentication table

   - `id` (UUID): The user's authentication ID

2. **`users`**: Application user table

   - `user_id` (UUID): References `auth.users.id`
   - Contains global user data (GitHub username, avatar, etc.)

3. **`profiles`**: Class-specific profile table

   - `id` (UUID): Auto-generated profile ID (NOT the user's auth ID)
   - `class_id` (bigint): The course this profile belongs to
   - `name` (text): Display name
   - `sis_user_id` (text): Student ID from SIS system
   - `is_private_profile` (boolean): Distinguishes private vs public profiles
   - Other fields: `avatar_url`, `time_zone`, `sortable_name`, etc.

4. **`user_roles`**: Junction table connecting users to their class-specific profiles

   - `user_id` (UUID): References `auth.users.id`
   - `class_id` (integer): The course
   - `role` (app_role): student/instructor/TA/etc.
   - `private_profile_id` (UUID): References `profiles.id` for private profile
   - `public_profile_id` (UUID): References `profiles.id` for public profile

5. **`surveys`**: Survey definitions

   - `id` (UUID): Survey ID
   - `class_id` (bigint): The course
   - `created_by` (text): **Stores `auth.uid()`** (user's auth UUID for auditing, NOT a profile ID)
   - `title`, `description`, `questions` (JSONB), `status`, etc.

6. **`survey_responses`**: Student survey submissions
   - `id` (UUID): Response ID
   - `survey_id` (UUID): References `surveys.id`
   - `student_id` (UUID): **Stores `auth.uid()`** (the user's auth UUID, NOT a profile ID)
   - `response` (JSONB): Survey answers
   - `submitted_at`, `is_submitted`, etc.

### Key Insight

Each user has **TWO profiles per class**:

- **Private Profile**: Uses real name, visible to instructors (used for grading, responses, etc.)
- **Public Profile**: Anonymous name, visible to everyone (used for discussions, peer reviews, etc.)

The `survey_responses.student_id` column stores the **user's auth UUID** (`auth.uid()`), not a profile ID. To get the student's profile information, we must:

1. Start with `survey_responses.student_id` (user auth UUID)
2. Join through `user_roles` table using `user_id`
3. Follow `private_profile_id` to get the student's actual profile
4. Access `profiles` table for display information

## The Fix

### Before (Incorrect)

```typescript
// ❌ This fails because student_id is a user UUID, not a profile UUID
const { data } = await supabase.from("survey_responses").select(`
    *,
    profiles:student_id (id, name, email)  // Tries to join directly
  `);
```

### After (Correct)

```typescript
// ✅ Correct: Join through user_roles to get profile
// Step 1: Get responses
const { data: responses } = await supabase.from("survey_responses").select("*").eq("survey_id", surveyId);

// Step 2: Get user_roles with profiles
const { data: userRoles } = await supabase
  .from("user_roles")
  .select(
    `
    user_id,
    private_profile_id,
    profiles:private_profile_id (
      id,
      name,
      sis_user_id
    )
  `
  )
  .eq("class_id", classId)
  .in("user_id", studentIds);

// Step 3: Map and combine
const userProfileMap = new Map();
userRoles.forEach((role) => {
  userProfileMap.set(role.user_id, role.profiles);
});

const responsesWithProfiles = responses.map((response) => ({
  ...response,
  profiles: userProfileMap.get(response.student_id)
}));
```

## Additional Fixes (Survey Page Elements)

After understanding the table relationships, we audited and fixed all survey-related pages:

### 1. `/app/course/[course_id]/surveys/page.tsx` (Student Survey List)

- **Issue**: Was incorrectly trying to get profile by `profiles.id = user.id`, then using `profile.id` as `student_id`
- **Fix**: Removed profile lookup entirely. Now correctly uses `user.id` (auth UUID) directly as `student_id`
- **Impact**: Students can now see their correct response status for each survey

### 2. `/app/course/[course_id]/manage/surveys/new/page.tsx` (Create Survey)

- **Issue**: Was using placeholder string `"current_user"` for `created_by` field
- **Fix**: Now fetches actual user auth UUID on mount and stores it in `created_by` field
- **Impact**: Survey creation is now properly attributed to the correct instructor

### 3. Documentation Updates

- Updated `README.md` to clarify that `student_id` and `created_by` store auth UUIDs, not profile IDs
- Updated `SurveyResponsesView.tsx` comments to reflect correct field usage
- Added comprehensive architecture documentation

## Files Modified

### 1. `/app/course/[course_id]/surveys/[survey_id]/submit.ts`

- **Function**: `getAllResponses(surveyId, classId)`
- **Change**: Now performs a two-step query:
  1. Fetch survey responses
  2. Fetch user_roles with profile data
  3. Combine using a Map
- **Added parameter**: `classId` to filter user_roles correctly

### 2. `/app/course/[course_id]/manage/surveys/[survey_id]/responses/page.tsx`

- **Change**: Updated call to `getAllResponses` to include `course_id` parameter
- **Impact**: Responses list now correctly displays student names and SIS IDs

### 3. `/app/course/[course_id]/manage/surveys/[survey_id]/responses/[response_id]/page.tsx`

- **Change**: Updated to fetch student profile via `user_roles` table
- **Impact**: Individual response view now correctly displays student information

### 4. Column Name Updates (All Files)

- Changed from `email` to `sis_user_id` (profiles table doesn't have email)
- Changed from `first_name`/`last_name` to `name` (profiles uses single name field)

## RLS Policies

The existing RLS policies are correctly designed:

```sql
-- Students can view and submit their own responses
CREATE POLICY "Students can view and submit their own responses" ON survey_responses
  FOR ALL USING (
    authorizeforclass((SELECT class_id FROM surveys WHERE id = survey_id))
    AND auth.uid() = student_id  -- ✅ Correctly checks against user auth UUID
    AND deleted_at IS NULL
  );

-- Instructors can view all responses
CREATE POLICY "Instructors can view all survey responses" ON survey_responses
  FOR SELECT USING (
    authorizeforclassinstructor((SELECT class_id FROM surveys WHERE id = survey_id))
    AND deleted_at IS NULL
  );
```

## Testing Checklist

- [x] Survey responses list page loads without errors
- [x] Student names display correctly (not "Unknown Student")
- [x] SIS User IDs display correctly
- [x] Search by student name works
- [x] Individual response view shows correct student info
- [x] CSV export includes correct student information
- [x] No database column errors
- [x] No duplicate toaster notifications

## Future Considerations

1. **Email Access**: If email addresses are needed, they're stored in `auth.users` table, not `profiles`. Would need to join through `users` table: `survey_responses.student_id` → `users.user_id` → `users.email` (or fetch from `auth.users` if accessible)

2. **Public vs Private Profiles**: Currently using private profiles for responses (shows real names to instructors). If anonymous submission is needed, would need to update to use `public_profile_id` instead.

3. **Performance**: The two-query approach is necessary due to the architecture. Consider caching profile data if performance becomes an issue with large numbers of responses.

4. **Database Views**: Could create a database view that pre-joins these tables for easier querying, but current approach is clearer and more maintainable.
