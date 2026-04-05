/**
 * Central definitions for Next.js `unstable_cache` / `revalidateTag` keys.
 * Keep in sync with `lib/course-dashboard-cache.ts`, `lib/server-route-cache.ts`,
 * and PostgreSQL `invalidate_*` trigger functions (see migrations).
 */
export function courseAssignmentsOverviewTag(classId: number) {
  return `course:${classId}:assignments-overview`;
}

export function courseInstructorDashboardTag(classId: number) {
  return `course:${classId}:instructor-dashboard`;
}

export function courseStudentDashboardTag(classId: number) {
  return `course:${classId}:student-dashboard`;
}

export function userCoursesTag(userId: string) {
  return `user:${userId}:courses`;
}

export function courseFlashcardDecksTag(classId: number) {
  return `course:${classId}:flashcard-decks`;
}

export function adminDashboardStatsTag() {
  return "admin:dashboard-stats";
}

/** All `unstable_cache` tags derived from class-scoped data (assignments, roster, etc.). */
export function courseDerivedDataTags(classId: number): string[] {
  return [
    courseAssignmentsOverviewTag(classId),
    courseInstructorDashboardTag(classId),
    courseStudentDashboardTag(classId),
    courseFlashcardDecksTag(classId)
  ];
}
