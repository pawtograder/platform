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

/**
 * The one tag `getCourse()` reads (`lib/ssrUtils.ts`). Emitted by the `classes`
 * cache-invalidation trigger and by `/api/cache/revalidate-tags`.
 */
export function courseTag(classId: number) {
  return `course:${classId}`;
}

/**
 * Tables whose class-scoped rows are read through a *cached* SSR fetch — i.e. the tables
 * for which `<table>:<class_id>:<role>` is a tag some `createClientWithCaching()` call site
 * in `lib/ssrUtils.ts` is actually keyed under. Kept in sync with
 * `fetchCourseControllerData`; the Postgres `invalidate_class_scoped_cache()` trigger emits
 * the same strings from `TG_TABLE_NAME`.
 */
export const CLASS_SCOPED_CACHED_TABLES = [
  "profiles",
  "user_roles",
  "discussion_threads",
  "tags",
  "lab_sections",
  "lab_section_meetings",
  "class_sections",
  "student_deadline_extensions",
  "assignment_due_date_exceptions",
  "assignments",
  "assignment_groups",
  "discussion_topics",
  "repositories",
  "gradebook_columns",
  "discord_channels",
  "discord_messages",
  "surveys",
  "lab_section_leaders"
] as const;

export type ClassScopedCachedTable = (typeof CLASS_SCOPED_CACHED_TABLES)[number];

/** Both role variants of a class-scoped table tag, matching the trigger's emission. */
export function classScopedTableTags(table: ClassScopedCachedTable, classId: number): string[] {
  return [`${table}:${classId}:staff`, `${table}:${classId}:student`];
}

/**
 * Tags to revalidate after a client-side write to `tables` in `classId`.
 *
 * `courseDerivedDataTags` alone is not enough: those four strings are read by nothing (see
 * the header of this file), so a caller that emits only them believes it has busted a cache
 * and has not. The class-scoped table tags below are the ones `lib/ssrUtils.ts` keys its
 * 1-hour SSR fetches under.
 */
export function courseSsrTags(classId: number, tables: readonly ClassScopedCachedTable[]): string[] {
  return [
    courseTag(classId),
    ...tables.flatMap((table) => classScopedTableTags(table, classId)),
    ...courseDerivedDataTags(classId)
  ];
}
