/**
 * Keys passed to `revalidateTag()` (client route + PostgreSQL `call_cache_invalidate` triggers).
 * Dashboards are not Data Cached (`unstable_cache`); tags are effectively no-ops for those paths but remain
 * defined so trigger payloads stay stable. Do not use `unstable_cache` with cookie-based `createClient()`.
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

/** Tags emitted for class-scoped data invalidation (assignments, roster, dashboards, flashcards, …). */
export function courseDerivedDataTags(classId: number): string[] {
  return [
    courseAssignmentsOverviewTag(classId),
    courseInstructorDashboardTag(classId),
    courseStudentDashboardTag(classId),
    courseFlashcardDecksTag(classId)
  ];
}
