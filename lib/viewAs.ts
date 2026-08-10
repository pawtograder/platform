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
  /**
   * The browser tab that opened a self-preview, so a later mount can tell "the preview I started,
   * which I have now navigated away from" apart from "a preview another tab is still using".
   * `null` for course-wide targets, and for scoped cookies written before this was recorded.
   */
  previewTabId: string | null;
};

export function viewAsCookieName(courseId: number | string): string {
  return `view_as_${courseId}`;
}

/**
 * Cookie payload: `<profileId>` for an enrolled student, `<profileId>~<assignmentId>~<tabId>` for a
 * staff self-preview. A profile id is a UUID, so `~` cannot collide with one.
 *
 * `~` rather than a more obvious `:` because `encodeURIComponent` leaves it alone. The client reads
 * this value back through `decodeURIComponent` while the server reads it from `cookies()`, and a
 * delimiter that survives neither, one, nor both of those unchanged is a decoding bug waiting to
 * split the two apart — with the server silently deciding every path is out of scope.
 */
const VIEW_AS_DELIMITER = "~";

export function parseViewAsCookieValue(value: string | null | undefined): ViewAsTarget | null {
  if (!value) return null;
  const parts = value.split(VIEW_AS_DELIMITER);
  const [profileId, assignmentPart, tabPart] = parts;
  if (!profileId) return null;
  if (parts.length === 1) {
    return { profileId, previewAssignmentId: null, previewTabId: null };
  }
  // Reject anything else this function did not write. Salvaging a prefix out of an unexpected shape
  // is how a scoped preview would quietly widen into a course-wide target.
  if (parts.length > 3 || !/^\d+$/.test(assignmentPart ?? "")) return null;
  // A two-part value predates tab tracking: treat it as owned by no tab, so any mount may clean it
  // up rather than leaving it to resume later.
  return {
    profileId,
    previewAssignmentId: Number(assignmentPart),
    previewTabId: parts.length === 3 ? tabPart || null : null
  };
}

const TAB_ID_KEY = "pawtograder_tab_id";

/**
 * A per-tab identifier from `sessionStorage`, which is scoped to the tab and survives navigation
 * within it — exactly the lifetime a self-preview should have.
 */
export function getTabId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.sessionStorage.getItem(TAB_ID_KEY);
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 10);
    window.sessionStorage.setItem(TAB_ID_KEY, created);
    return created;
  } catch {
    // Private modes and blocked storage: fall back to no tab id, which makes previews cleanable by
    // any mount rather than sticky.
    return null;
  }
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
  const value =
    previewAssignmentId == null
      ? profileId
      : [profileId, previewAssignmentId, getTabId() ?? ""].join(VIEW_AS_DELIMITER);
  // Secure only on https, so the cookie is withheld from plaintext requests in deployed
  // environments without breaking local development, which is served over http.
  const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${viewAsCookieName(courseId)}=${encodeURIComponent(value)}; path=/; SameSite=Lax${secure}`;
}

/** Client-only: clear the view-as target for a course. */
export function clearViewAsCookie(courseId: number | string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${viewAsCookieName(courseId)}=; path=/; SameSite=Lax; max-age=0`;
}

/**
 * Client-only: end self-previews that this tab started in *other* courses, and report which courses
 * were cleared.
 *
 * A full-document navigation to another course destroys the provider that was tracking the preview,
 * so nothing in memory survives to clean up after it and the originating cookie would otherwise sit
 * there — silently resuming the preview if the viewer ever returned to that assignment, contrary to
 * the banner. A fresh mount can only recognise those cookies by reading them back.
 *
 * Restricted to previews carrying *this* tab's id (or none) so that a preview another tab is still
 * using survives: cookies are shared across tabs, so an unconditional sweep would end a colleague
 * tab's preview the moment any other tab opened a different course.
 *
 * Course-wide enrolled-student targets are never touched — they are meant to persist per course.
 */
export function clearStalePreviewCookies(currentCourseId: number | string | undefined): string[] {
  if (typeof document === "undefined") return [];
  const thisTab = getTabId();
  const cleared: string[] = [];
  for (const row of document.cookie.split("; ")) {
    const eq = row.indexOf("=");
    if (eq <= 0) continue;
    const name = row.slice(0, eq);
    const match = /^view_as_(.+)$/.exec(name);
    if (!match) continue;
    const cookieCourseId = match[1];
    if (currentCourseId !== undefined && cookieCourseId === String(currentCourseId)) {
      // The course being rendered is handled by the provider's own scope check, which knows whether
      // the current path is inside the preview.
      continue;
    }
    const target = parseViewAsCookieValue(decodeURIComponent(row.slice(eq + 1)));
    if (!target || target.previewAssignmentId == null) continue;
    if (target.previewTabId !== null && target.previewTabId !== thisTab) continue;
    clearViewAsCookie(cookieCourseId);
    cleared.push(cookieCourseId);
  }
  return cleared;
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
