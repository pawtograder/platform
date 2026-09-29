/**
 * Module-level store for what a bug report needs to know about where the user is.
 *
 * It lives outside React on purpose. `app/global-error.tsx` replaces the whole root layout,
 * so the providers that knew the route, class, and role are gone by the time its form
 * submits. The store keeps the last values they published, and `submitReport` reads it.
 *
 * Identity is the role only (ADR 3). Never put a name or email here.
 */
export type ReportRole = "student" | "grader" | "instructor" | "admin";

export type ReportContext = {
  /** App-router pattern of the current route, e.g. `/course/[course_id]/assignments`. */
  route?: string;
  /** Set on course routes only; absent on admin and other non-course routes. */
  classId?: number;
  role?: ReportRole;
};

let current: ReportContext = {};
/** Identity as it was just before the last clear. See `getLastKnownReportContext`. */
let lastCleared: Pick<ReportContext, "classId" | "role"> = {};

export function getReportContext(): ReportContext {
  return current;
}

export function setReportRoute(route: string | undefined): void {
  current = { ...current, route };
}

export function setReportIdentity(identity: { classId?: number; role?: ReportRole }): void {
  current = { ...current, classId: identity.classId, role: identity.role };
}

export function clearReportIdentity(): void {
  if (current.classId !== undefined || current.role !== undefined) {
    lastCleared = { classId: current.classId, role: current.role };
  }
  current = { ...current, classId: undefined, role: undefined };
}

/**
 * For `app/global-error.tsx`. A render crash unmounts the whole tree, and the layouts that
 * published the identity clear it on unmount before the error page mounts. This returns the
 * identity from just before that, so the crash report still says who hit it.
 */
export function getLastKnownReportContext(): ReportContext {
  if (current.classId !== undefined || current.role !== undefined) return current;
  return { ...current, ...lastCleared };
}

/** Test-only reset. */
export function resetReportContextForTests(): void {
  current = {};
  lastCleared = {};
}
