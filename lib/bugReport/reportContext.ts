/**
 * Module-level store for what a bug report needs to know about where the user is.
 *
 * It lives outside React on purpose. `app/global-error.tsx` replaces the whole root layout,
 * so the providers that knew the route, class, and role are gone by the time its form
 * submits. The store keeps the last values they published, and `submitReport` reads it.
 *
 * Identity is the user ID and role only (ADR 3). Never put a name or email here.
 */
export type ReportRole = "student" | "grader" | "instructor" | "admin";

export type ReportContext = {
  /** App-router pattern of the current route, e.g. `/course/[course_id]/assignments`. */
  route?: string;
  /** Set on course routes only; absent on admin and other non-course routes. */
  classId?: number;
  role?: ReportRole;
  /**
   * Supabase auth user ID, the same ID `Sentry.setUser` uses in the middleware and
   * `AuthStateProvider`. The admin layout has no `AuthStateProvider`, so without this its
   * reports would carry no user.
   */
  userId?: string;
};

let current: ReportContext = {};
/** Identity as it was just before the last clear, and the route it was cleared on. See `getLastKnownReportContext`. */
let lastCleared: Pick<ReportContext, "route" | "classId" | "role" | "userId"> = {};

export function getReportContext(): ReportContext {
  return current;
}

export function setReportRoute(route: string | undefined): void {
  current = { ...current, route };
}

export function setReportIdentity(identity: { classId?: number; role?: ReportRole; userId?: string }): void {
  current = { ...current, classId: identity.classId, role: identity.role, userId: identity.userId };
}

function hasIdentity(ctx: ReportContext): boolean {
  return ctx.classId !== undefined || ctx.role !== undefined || ctx.userId !== undefined;
}

export function clearReportIdentity(): void {
  if (hasIdentity(current)) {
    lastCleared = { route: current.route, classId: current.classId, role: current.role, userId: current.userId };
  }
  current = { ...current, classId: undefined, role: undefined, userId: undefined };
}

/**
 * For `app/global-error.tsx`. A render crash unmounts the whole tree, and the layouts that
 * published the identity clear it on unmount before the error page mounts. This returns the
 * identity from just before that, so the crash report still says who hit it.
 *
 * Only for a crash on the route the identity was cleared on. A navigation also clears it (from a
 * course page to the course list, or to sign-in after signing out), and the route it leads to
 * never publishes one. A crash there must not be filed under the earlier page's class and role:
 * the retention purge deletes reports by class_id.
 */
export function getLastKnownReportContext(): ReportContext {
  if (hasIdentity(current)) return current;
  if (lastCleared.route !== current.route) return current;
  return { ...current, classId: lastCleared.classId, role: lastCleared.role, userId: lastCleared.userId };
}

/** Test-only reset. */
export function resetReportContextForTests(): void {
  current = {};
  lastCleared = {};
}
