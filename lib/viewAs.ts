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
