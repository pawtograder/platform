/**
 * Shared helpers for the instructor "view as student" (read-only) feature.
 *
 * The active view-as target is stored in a per-course cookie so that it can be read
 * identically on the server (role-branching pages/layouts) and on the client
 * (ClassProfileProvider). The cookie takes effect when the real user is an
 * instructor viewing an enrolled student, or when staff view their own test-assignment
 * submission through the student-facing UI.
 */

export function viewAsCookieName(courseId: number | string): string {
  return `view_as_${courseId}`;
}

/** Client-only: read the current view-as target profile id for a course, if any. */
export function getViewAsCookie(courseId: number | string): string | null {
  if (typeof document === "undefined") return null;
  const name = viewAsCookieName(courseId);
  const match = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`));
  if (!match) return null;
  const value = decodeURIComponent(match.slice(name.length + 1));
  return value || null;
}

/** Client-only: set the view-as target profile id for a course (session cookie). */
export function setViewAsCookie(courseId: number | string, profileId: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${viewAsCookieName(courseId)}=${encodeURIComponent(profileId)}; path=/; SameSite=Lax`;
}

/** Client-only: clear the view-as target for a course. */
export function clearViewAsCookie(courseId: number | string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${viewAsCookieName(courseId)}=; path=/; SameSite=Lax; max-age=0`;
}

/**
 * Whether a path is within the scope where staff *self* view-as applies — one assignment and
 * everything beneath it (`/course/<id>/assignments/<assignment_id>/...`).
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
 * Only self view-as is scoped. Viewing as an enrolled student stays in effect course-wide.
 */
export function isSelfViewAsScope(pathname: string, courseId: number | string): boolean {
  const segments = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  return (
    segments[0] === "course" &&
    segments[1] === String(courseId) &&
    segments[2] === "assignments" &&
    /^\d+$/.test(segments[3] ?? "")
  );
}
