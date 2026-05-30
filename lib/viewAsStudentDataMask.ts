/**
 * Client-side data masking for instructor "view as student".
 *
 * Auth/RLS still runs as the real instructor, so PostgREST may return rows the
 * masqueraded student cannot see. These helpers mirror the student-facing RLS
 * rules so the read-only preview matches what the student actually gets.
 */

export type StudentProfileIds = ReadonlySet<string>;

export function studentProfileIdSet(privateProfileId: string, publicProfileId: string): StudentProfileIds {
  return new Set([privateProfileId, publicProfileId].filter(Boolean));
}

function isStudentProfile(profileId: string | null | undefined, studentIds: StudentProfileIds): boolean {
  return profileId != null && studentIds.has(profileId);
}

/** Whether a discussion root teaser is visible in the student feed. */
export function isDiscussionTeaserVisibleToStudent(
  thread: { instructors_only?: boolean | null; author?: string | null },
  studentIds: StudentProfileIds
): boolean {
  if (!thread.instructors_only) {
    return true;
  }
  return isStudentProfile(thread.author, studentIds);
}

/** Whether a row in a thread tree is visible (includes private-thread participation). */
export function isDiscussionThreadRowVisibleToStudent(
  thread: { instructors_only?: boolean | null; author?: string | null },
  studentIds: StudentProfileIds,
  allRowsInThread?: ReadonlyArray<{ author?: string | null }>
): boolean {
  if (!thread.instructors_only) {
    return true;
  }
  if (isStudentProfile(thread.author, studentIds)) {
    return true;
  }
  return allRowsInThread?.some((row) => isStudentProfile(row.author, studentIds)) ?? false;
}

/** Whether a help request is visible to the student (public queue vs private involvement). */
export function isHelpRequestVisibleToStudent(
  request: { is_private?: boolean | null; created_by?: string | null; assignee?: string | null },
  studentIds: StudentProfileIds,
  memberProfileIds?: ReadonlyArray<string>
): boolean {
  if (!request.is_private) {
    return true;
  }
  if (isStudentProfile(request.created_by, studentIds)) {
    return true;
  }
  if (isStudentProfile(request.assignee, studentIds)) {
    return true;
  }
  return memberProfileIds?.some((id) => studentIds.has(id)) ?? false;
}

export function buildHelpRequestMembersMap(
  rows: ReadonlyArray<{ help_request_id: number; profile_id: string }>
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const row of rows) {
    const list = map.get(row.help_request_id);
    if (list) {
      list.push(row.profile_id);
    } else {
      map.set(row.help_request_id, [row.profile_id]);
    }
  }
  return map;
}

export function filterHelpRequestsForStudentView<
  T extends { id: number; is_private?: boolean | null; created_by?: string | null; assignee?: string | null }
>(requests: T[], studentIds: StudentProfileIds, membersByRequestId: Map<number, string[]>): T[] {
  return requests.filter((request) =>
    isHelpRequestVisibleToStudent(request, studentIds, membersByRequestId.get(request.id))
  );
}

/** Gradebook cell row visible to the current caller (staff: private; student: public only). */
export function isGradebookEntryVisibleToCaller(
  entry: { is_private: boolean },
  isInstructorOrGrader: boolean
): boolean {
  return isInstructorOrGrader ? entry.is_private : !entry.is_private;
}

export type GradebookEntryLike = { gc_id: number; is_private: boolean };

/** Pick the gradebook cell row for a column, matching staff vs student RLS semantics. */
export function pickGradebookEntryForCaller<T extends GradebookEntryLike>(
  entries: ReadonlyArray<T>,
  columnId: number,
  isInstructorOrGrader: boolean
): T | undefined {
  if (isInstructorOrGrader) {
    return (
      entries.find((e) => e.gc_id === columnId && e.is_private) ??
      entries.find((e) => e.gc_id === columnId && !e.is_private)
    );
  }
  return entries.find((e) => e.gc_id === columnId && !e.is_private);
}

export function filterGradebookEntriesForCaller<T extends { is_private: boolean }>(
  entries: ReadonlyArray<T>,
  isInstructorOrGrader: boolean
): T[] {
  return entries.filter((entry) => isGradebookEntryVisibleToCaller(entry, isInstructorOrGrader));
}

/** Mirrors gradebook_columns RLS: students see normal columns or instructor-only columns after release. */
export function isGradebookColumnVisibleToStudent(column: {
  instructor_only?: boolean | null;
  released?: boolean | null;
}): boolean {
  return !column.instructor_only || column.released === true;
}

export function filterGradebookColumnsForStudentView<
  T extends { instructor_only?: boolean | null; released?: boolean | null }
>(columns: ReadonlyArray<T>): T[] {
  return columns.filter(isGradebookColumnVisibleToStudent);
}
