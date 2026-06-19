/**
 * Tracks whether a global admin entered a course via "Manage as instructor" (acting-as) rather
 * than through a genuine enrollment.
 *
 * Without this flag, the AdminViewingBanner would render for *any* admin viewing a course's
 * manage area — including an admin who is also a real instructor of that course, who'd then see
 * a misleading "viewing as a platform admin" banner on their own course. The flag is set as a
 * per-course session cookie when entering via "Manage as instructor" and read by the banner.
 */

export function actingAsAdminCookieName(courseId: number | string): string {
  return `acting_as_admin_${courseId}`;
}

/** Client-only: set the acting-as-admin flag for a course (session cookie). */
export function setActingAsAdminCookie(courseId: number | string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${actingAsAdminCookieName(courseId)}=1; path=/; SameSite=Lax`;
}

/** Client-only: whether the current user entered this course as an acting-as admin. */
export function getActingAsAdminCookie(courseId: number | string): boolean {
  if (typeof document === "undefined") return false;
  const name = actingAsAdminCookieName(courseId);
  return document.cookie.split("; ").some((row) => row === `${name}=1`);
}

/** Client-only: clear the acting-as-admin flag for a course. */
export function clearActingAsAdminCookie(courseId: number | string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${actingAsAdminCookieName(courseId)}=; path=/; SameSite=Lax; max-age=0`;
}
