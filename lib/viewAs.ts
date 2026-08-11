/**
 * Shared helpers for the instructor "view as student" (read-only) feature.
 *
 * Two distinct things wear this name, and they need different mechanisms:
 *
 * 1. **Viewing an enrolled student** is a real identity switch: the server fetches *that student's*
 *    data, so the target has to reach the server. It lives in a per-course cookie, read identically
 *    on the server (role-branching pages/layouts) and on the client (ClassProfileProvider).
 *
 * 2. **The Test Assignment self-preview** is not an identity switch at all. RLS still evaluates as
 *    staff, so the same rows are fetched either way; what changes is which of them the UI renders.
 *    It is therefore client state in ClassProfileProvider, not a cookie — see
 *    `isSelfViewAsScope` for the one thing that remains path-dependent.
 *
 * Conflating the two is what previously put a cross-tab-shared cookie in charge of a per-tab
 * presentation toggle, and with it assignment ids, tab ids, ownership rules and a cookie sweep.
 */

/** Profile ids are Postgres uuids; anything else did not come from this app. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function viewAsCookieName(courseId: number | string): string {
  return `view_as_${courseId}`;
}

/**
 * Validates the cookie payload: the private profile id of the enrolled student being viewed.
 * Anything that is not a uuid is rejected here rather than handed to identity resolution, and an
 * undecodable value (`decodeURIComponent` throws `URIError` on a bad percent escape) is treated the
 * same way instead of propagating.
 */
export function parseViewAsCookieValue(value: string | null | undefined): string | null {
  if (!value) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return UUID_RE.test(decoded) ? decoded : null;
}

/** Client-only: read the enrolled student currently being viewed for a course, if any. */
export function getViewAsCookie(courseId: number | string): string | null {
  if (typeof document === "undefined") return null;
  const name = viewAsCookieName(courseId);
  const match = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`));
  if (!match) return null;
  return parseViewAsCookieValue(match.slice(name.length + 1));
}

/** Client-only: set the enrolled student to view for a course (session cookie). */
export function setViewAsCookie(courseId: number | string, profileId: string): void {
  if (typeof document === "undefined") return;
  // Secure only on https, so the cookie is withheld from plaintext requests in deployed
  // environments without breaking local development, which is served over http.
  const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${viewAsCookieName(courseId)}=${encodeURIComponent(profileId)}; path=/; SameSite=Lax${secure}`;
}

/** Client-only: stop viewing as an enrolled student for a course. */
export function clearViewAsCookie(courseId: number | string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${viewAsCookieName(courseId)}=; path=/; SameSite=Lax; max-age=0`;
}

/**
 * Whether a path is still within the assignment a Test Assignment self-preview was opened from.
 *
 * The preview is client state, so leaving the page cannot strand anything — but the provider spans
 * every `/course/**` route, so without this the toggle would follow the viewer to the gradebook or
 * the assignments list. Those are the pages the preview cannot represent: it is the staff member's
 * own profile, and anything keyed on a real `role = 'student'` enrollment has nothing to show for it
 * (the student assignments dashboard RPC and `assignments_with_effective_due_dates` both do, which
 * is what made the Assignments tab render an empty list in issue #892).
 *
 * The match is against the *originating* assignment, so a deep link or global-search jump to a
 * different assignment ends the preview rather than carrying it along.
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
