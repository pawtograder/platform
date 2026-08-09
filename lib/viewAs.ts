/**
 * Shared helpers for the instructor "view as student" (read-only) feature.
 *
 * The active view-as target is stored in a per-course cookie so that it can be read
 * identically on the server (role-branching pages/layouts) and on the client
 * (ClassProfileProvider). The cookie takes effect when the real user is an
 * instructor viewing an enrolled student, or when staff view their own test-assignment
 * submission through the student-facing UI.
 */

/**
 * The parsed cookie. `previewAssignmentId` is set only for the staff self-preview (Test
 * Assignment), and names the assignment the preview was entered from; viewing an enrolled student
 * is course-wide and carries none.
 */
export type ViewAsTarget = {
  profileId: string;
  previewAssignmentId: number | null;
};

export function viewAsCookieName(courseId: number | string): string {
  return `view_as_${courseId}`;
}

/**
 * Cookie payload: `<profileId>` for an enrolled student, `<profileId>:<assignmentId>` for a staff
 * self-preview. A profile id is a UUID, so `:` cannot collide with one.
 */
export function parseViewAsCookieValue(value: string | null | undefined): ViewAsTarget | null {
  if (!value) return null;
  const [profileId, assignmentPart] = value.split(":");
  if (!profileId) return null;
  if (assignmentPart === undefined) {
    return { profileId, previewAssignmentId: null };
  }
  return /^\d+$/.test(assignmentPart)
    ? { profileId, previewAssignmentId: Number(assignmentPart) }
    : // A malformed suffix must not silently widen into a course-wide target.
      null;
}

/** Client-only: read the current view-as target for a course, if any. */
export function getViewAsTarget(courseId: number | string): ViewAsTarget | null {
  if (typeof document === "undefined") return null;
  const name = viewAsCookieName(courseId);
  const match = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`));
  if (!match) return null;
  return parseViewAsCookieValue(decodeURIComponent(match.slice(name.length + 1)));
}

/**
 * Client-only: set the view-as target for a course (session cookie). Pass
 * `previewAssignmentId` for the staff self-preview so the synthetic identity can be confined to
 * that assignment.
 */
export function setViewAsCookie(
  courseId: number | string,
  profileId: string,
  previewAssignmentId?: number | null
): void {
  if (typeof document === "undefined") return;
  const value = previewAssignmentId == null ? profileId : `${profileId}:${previewAssignmentId}`;
  document.cookie = `${viewAsCookieName(courseId)}=${encodeURIComponent(value)}; path=/; SameSite=Lax`;
}

/** Client-only: clear the view-as target for a course. */
export function clearViewAsCookie(courseId: number | string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${viewAsCookieName(courseId)}=; path=/; SameSite=Lax; max-age=0`;
}

/**
 * Whether a path is within the scope where a staff *self* view-as applies — the assignment the
 * preview was entered from, and everything beneath it.
 *
 * Self view-as (the Test Assignment preview) is a synthetic student identity over the staff
 * member's own profile: the app fabricates `role: "student"` while keeping the instructor's
 * `private_profile_id`. Postgres never sees that fabrication, so any query keyed on a real
 * `user_roles` row with `role = 'student'` returns nothing for it — the student assignments
 * dashboard RPC and the `assignments_with_effective_due_dates` view both do. Navigating from a
 * test submission to the student Assignments tab therefore rendered a confidently empty list
 * (issue #892). Bounding the synthetic identity to the assignment it was created for keeps it on
 * the paths that work (they key on `profile_id` alone) and hands every other page back to the
 * real staff identity. Instructors who want a populated student view pick a real enrolled
 * student instead — that path has a real `user_roles` row and needs no scope limit.
 *
 * The match is against the *originating* assignment, not merely any assignment: accepting any
 * numeric segment would keep the preview alive through a deep link or global-search jump to a
 * different assignment, carrying its release-date exemption with it while the banner claimed the
 * preview covered only one assignment.
 *
 * A preview with no recorded assignment (a cookie written before this was tracked) is out of
 * scope everywhere, which degrades to the plain staff view rather than an unbounded preview.
 *
 * Only self view-as is scoped. Viewing as an enrolled student stays in effect course-wide.
 */
export function isSelfViewAsScope(
  pathname: string,
  courseId: number | string,
  previewAssignmentId: number | null
): boolean {
  if (previewAssignmentId == null) return false;
  const segments = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  return (
    segments[0] === "course" &&
    segments[1] === String(courseId) &&
    segments[2] === "assignments" &&
    segments[3] === String(previewAssignmentId)
  );
}
