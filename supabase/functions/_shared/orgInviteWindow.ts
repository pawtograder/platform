/**
 * When may automation invite (or RE-invite) a user to a class's GitHub org?
 *
 * Background: a GitHub org invitation expires after 7 days. Nothing on GitHub's side tells us when
 * that happens — there is no "invitation expired" webhook — so the only evidence is a membership
 * lookup returning 404 for a user we believe we invited. Until the membership reconciler existed,
 * every automated invite path was gated on `invitation_date IS NULL`, which made the first invite
 * the ONLY invite: a student who let it lapse stayed outside the org (and therefore outside the
 * team, and therefore without repo permissions) until they happened to log in or press "Sync GitHub
 * Account".
 *
 * Re-inviting is safe to do repeatedly, but only while the class is actually running. A course
 * shell created months ahead of its term, or one that finished last spring, must not be mailing its
 * roster fresh GitHub invitations — the invite is worthless to the recipient and looks like a
 * phishing attempt. Hence the window, which is deliberately CONSERVATIVE about missing dates:
 *
 *   - No `start_date` or no `end_date` -> the window is CLOSED. We cannot know whether the class is
 *     in session, and guessing "yes" is the guess that mails strangers. The membership reconciler
 *     alerts on classes that have stuck students but no term dates, so a class configured this way
 *     is visible rather than silently skipped.
 *   - Archived -> closed. Someone retired the class.
 *
 * The lead/trail grace exists because the term dates bound *instruction*, not *setup*:
 *   - {@link INVITE_WINDOW_LEAD_DAYS} before `start_date`, because students enroll and link GitHub
 *     the week before classes begin, and an invitation sent then can expire before day one — the
 *     exact case that must be repaired BEFORE the first assignment, not after it.
 *   - {@link INVITE_WINDOW_TRAIL_DAYS} after `end_date`, matching the grace in the existing
 *     `is_class_active()` SQL predicate, which keeps automation running through the grading and
 *     grade-appeal windows that outlive the last class meeting.
 *
 * `classes.start_date` / `classes.end_date` are `date` columns, so they are compared as calendar
 * days in UTC. Classes have a `time_zone`, but a window with ±(7, 30) days of grace cannot be
 * changed by a few hours of offset, and pretending otherwise would only add a failure mode.
 *
 * This module mirrors `public.github_org_invite_window_open(archived, start_date, end_date)` in
 * SQL. Both exist because the reconciler selects candidates in the database while the async worker
 * makes the final call in TypeScript; if you change one, change the other, and keep the constants
 * below in sync with the migration.
 */

/** Days before `start_date` that automated invitations may begin. */
export const INVITE_WINDOW_LEAD_DAYS = 7;
/** Days after `end_date` that automated invitations may continue. Matches `is_class_active()`. */
export const INVITE_WINDOW_TRAIL_DAYS = 30;
/**
 * How old an invitation must be before automation treats it as lapsed and sends another.
 *
 * GitHub expires invitations at 7 days, so anything older is either accepted (in which case the
 * user is org-confirmed and never reaches this check) or gone. Kept at exactly 7 rather than
 * shorter so we never race a still-valid invitation and mail a student twice for one enrollment.
 */
export const INVITE_STALE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The subset of `classes` this decision needs. */
export type ClassInviteWindow = {
  archived?: boolean | null;
  start_date?: string | null;
  end_date?: string | null;
};

/**
 * Midnight UTC of a `date` column's calendar day, or null if absent/unparseable.
 *
 * Parsed by pattern rather than handed to `new Date()`, which would accept a timestamp, a
 * time-zone-shifted string, or garbage that silently becomes NaN — all of which would widen a
 * window whose entire job is to stay narrow.
 */
function dateOnlyToUtcMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  // Round-trip guard: Date.UTC happily normalizes 2026-13-45 into a real date.
  const roundTrip = new Date(ms);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

/**
 * May automation invite users to this class's GitHub org right now?
 *
 * Returns false for a missing or malformed term date — see the module comment for why that is the
 * safe direction.
 */
export function isOrgInviteWindowOpen(cls: ClassInviteWindow, now: Date = new Date()): boolean {
  if (cls.archived === true) return false;
  const startMs = dateOnlyToUtcMs(cls.start_date);
  const endMs = dateOnlyToUtcMs(cls.end_date);
  if (startMs === null || endMs === null) return false;
  const nowMs = now.getTime();
  // The trailing bound covers the WHOLE of the last permitted day, hence the extra day: end_date
  // is midnight at the start of the final class day, so `+30 days` alone would close the window 24h
  // early relative to how "30 days after the class ends" reads.
  return (
    nowMs >= startMs - INVITE_WINDOW_LEAD_DAYS * MS_PER_DAY &&
    nowMs < endMs + (INVITE_WINDOW_TRAIL_DAYS + 1) * MS_PER_DAY
  );
}

/**
 * Does this class have term dates that PROVE automation should not be inviting right now?
 *
 * The inverse of {@link isOrgInviteWindowOpen} for the one caller that must not treat "we don't
 * know" as "no": github-user-sync, which a student reaches by pressing "Sync GitHub Account" and
 * which the login callback runs on their behalf. That path is the escape hatch when everything else
 * has failed, so blocking it for a class with no term dates — most of them today — would take the
 * only self-service repair away from the students who need it most.
 *
 * So this returns true only on evidence: the class is archived, or it has BOTH dates and today
 * falls outside the window. That is enough to stop the case worth stopping — a student who left an
 * old course's org, or was removed from it, being mailed a fresh invitation to rejoin a course that
 * finished months ago the next time they sign in.
 */
export function isOrgInviteWindowKnownClosed(cls: ClassInviteWindow, now: Date = new Date()): boolean {
  if (cls.archived === true) return true;
  if (dateOnlyToUtcMs(cls.start_date) === null || dateOnlyToUtcMs(cls.end_date) === null) return false;
  return !isOrgInviteWindowOpen(cls, now);
}

/**
 * Is a recorded invitation old enough that GitHub has certainly expired it?
 *
 * `null` is NOT stale: it means no invitation was ever recorded, which is the first-invite case and
 * is gated separately (the caller invites unconditionally there). An unparseable timestamp is
 * treated as stale — a row we cannot read is a row whose invitation we cannot vouch for, and the
 * cost of one extra invitation is an email, while the cost of skipping is a student locked out.
 */
export function isInvitationStale(
  invitationDate: string | null | undefined,
  now: Date = new Date(),
  staleDays: number = INVITE_STALE_DAYS
): boolean {
  if (!invitationDate) return false;
  const sentMs = new Date(invitationDate).getTime();
  if (Number.isNaN(sentMs)) return true;
  return now.getTime() - sentMs >= staleDays * MS_PER_DAY;
}

/**
 * The whole decision for one (user_role, class) pair, as the async worker asks it.
 *
 * `forceReinvite` is set only by the membership reconciler. It bypasses the staleness check —
 * without that, the reconciler's own enqueue-time `invitation_date` stamp would make the repair it
 * just queued look freshly invited, and the envelope would be a no-op.
 *
 * It does NOT bypass the term window, even though the reconciler already applied that window in SQL
 * when it chose the candidate. The two checks happen at different times: an envelope can sit in the
 * queue through a backlog, a retry ladder, or a dead-letter re-drive, and `drainQueue` permits
 * redelivery after an archive failure. Re-checking here is what makes the window a property of the
 * moment the invitation is actually sent rather than of the moment it was queued.
 */
export function shouldSendOrgInvitation(opts: {
  invitationDate: string | null | undefined;
  cls: ClassInviteWindow;
  forceReinvite?: boolean;
  now?: Date;
}): boolean {
  const now = opts.now ?? new Date();
  if (opts.forceReinvite === true) return isOrgInviteWindowOpen(opts.cls, now);
  // First invitation for this enrollment: unchanged behavior, deliberately NOT window-gated. This
  // is the enrollment path, it fires once, and gating it would break onboarding for every class
  // that has not filled in its term dates.
  if (!opts.invitationDate) return true;
  return isInvitationStale(opts.invitationDate, now) && isOrgInviteWindowOpen(opts.cls, now);
}
