/**
 * Unit tests for the GitHub org invitation window.
 *
 * This predicate decides whether automation mails a student a GitHub invitation, so both directions
 * are contractual: a class with no term dates must NEVER be invited into (that is the whole reason
 * the reconciler alerts instead of guessing), and a class in session with a lapsed invitation must
 * ALWAYS be, or the student stays locked out of the org for the term.
 *
 * Run from supabase/functions:  deno test --allow-env _shared/orgInviteWindow.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  INVITE_STALE_DAYS,
  INVITE_WINDOW_LEAD_DAYS,
  INVITE_WINDOW_TRAIL_DAYS,
  isInvitationStale,
  isOrgInviteWindowOpen,
  shouldSendOrgInvitation
} from "./orgInviteWindow.ts";

const TERM = { start_date: "2026-09-08", end_date: "2026-12-09", archived: false };
const at = (iso: string) => new Date(iso);

Deno.test("window: open during the term", () => {
  assertEquals(isOrgInviteWindowOpen(TERM, at("2026-10-01T12:00:00Z")), true);
  assertEquals(isOrgInviteWindowOpen(TERM, at("2026-09-08T00:00:00Z")), true);
});

Deno.test("window: opens exactly LEAD days before start_date, not earlier", () => {
  const leadOpen = at(`2026-09-0${8 - INVITE_WINDOW_LEAD_DAYS}T00:00:00Z`); // 2026-09-01
  assertEquals(isOrgInviteWindowOpen(TERM, leadOpen), true);
  assertEquals(isOrgInviteWindowOpen(TERM, at("2026-08-31T23:59:59Z")), false);
  // A course shell created for next spring must not mail anyone today.
  assertEquals(isOrgInviteWindowOpen(TERM, at("2026-06-01T00:00:00Z")), false);
});

Deno.test("window: stays open through the whole TRAIL-th day after end_date, then closes", () => {
  const lastDay = new Date(Date.UTC(2026, 11, 9) + INVITE_WINDOW_TRAIL_DAYS * 24 * 60 * 60 * 1000);
  assertEquals(isOrgInviteWindowOpen(TERM, new Date(lastDay.getTime() + 23 * 60 * 60 * 1000)), true);
  assertEquals(isOrgInviteWindowOpen(TERM, new Date(lastDay.getTime() + 25 * 60 * 60 * 1000)), false);
  assertEquals(isOrgInviteWindowOpen(TERM, at("2027-03-01T00:00:00Z")), false);
});

Deno.test("window: missing or malformed term dates are CLOSED, never assumed open", () => {
  const now = at("2026-10-01T12:00:00Z");
  assertEquals(isOrgInviteWindowOpen({ ...TERM, start_date: null }, now), false);
  assertEquals(isOrgInviteWindowOpen({ ...TERM, end_date: null }, now), false);
  assertEquals(isOrgInviteWindowOpen({ start_date: null, end_date: null }, now), false);
  assertEquals(isOrgInviteWindowOpen({ ...TERM, start_date: "" }, now), false);
  assertEquals(isOrgInviteWindowOpen({ ...TERM, start_date: "not-a-date" }, now), false);
  // Date.UTC would silently roll this into 2027-02-14; the round-trip guard rejects it instead.
  assertEquals(isOrgInviteWindowOpen({ ...TERM, start_date: "2026-13-45" }, now), false);
  // A timestamp is not a date column value, and must not be coerced into one.
  assertEquals(isOrgInviteWindowOpen({ ...TERM, start_date: "2026-09-08T00:00:00Z" }, now), false);
});

Deno.test("window: archived classes are closed even mid-term", () => {
  assertEquals(isOrgInviteWindowOpen({ ...TERM, archived: true }, at("2026-10-01T12:00:00Z")), false);
});

Deno.test("staleness: null means never invited (not stale), and the boundary is INVITE_STALE_DAYS", () => {
  const now = at("2026-10-08T12:00:00Z");
  assertEquals(isInvitationStale(null, now), false);
  assertEquals(isInvitationStale(undefined, now), false);
  const dayMs = 24 * 60 * 60 * 1000;
  const exactlyStale = new Date(now.getTime() - INVITE_STALE_DAYS * dayMs).toISOString();
  const oneHourShort = new Date(now.getTime() - INVITE_STALE_DAYS * dayMs + 60 * 60 * 1000).toISOString();
  assertEquals(isInvitationStale(exactlyStale, now), true);
  assertEquals(isInvitationStale(oneHourShort, now), false);
});

Deno.test("staleness: an unreadable timestamp is treated as stale", () => {
  assertEquals(isInvitationStale("whenever", at("2026-10-08T12:00:00Z")), true);
});

Deno.test("shouldSendOrgInvitation: first invitation is sent regardless of the window", () => {
  // Enrollment onboarding must not depend on a class having filled in its term dates.
  assertEquals(
    shouldSendOrgInvitation({
      invitationDate: null,
      cls: { start_date: null, end_date: null },
      now: at("2026-10-01T12:00:00Z")
    }),
    true
  );
});

Deno.test("shouldSendOrgInvitation: a lapsed invitation is re-sent only inside the window", () => {
  const now = at("2026-10-01T12:00:00Z");
  const lapsed = "2026-09-10T12:00:00Z";
  assertEquals(shouldSendOrgInvitation({ invitationDate: lapsed, cls: TERM, now }), true);
  // Same lapsed invitation, class over since June: no mail.
  assertEquals(
    shouldSendOrgInvitation({ invitationDate: lapsed, cls: { start_date: "2026-01-06", end_date: "2026-04-20" }, now }),
    false
  );
  // Same lapsed invitation, class with no term dates: no mail, the reconciler alerts instead.
  assertEquals(
    shouldSendOrgInvitation({ invitationDate: lapsed, cls: { start_date: null, end_date: null }, now }),
    false
  );
});

Deno.test("shouldSendOrgInvitation: a still-valid invitation is not duplicated", () => {
  const now = at("2026-10-01T12:00:00Z");
  assertEquals(shouldSendOrgInvitation({ invitationDate: "2026-09-29T12:00:00Z", cls: TERM, now }), false);
});

Deno.test("shouldSendOrgInvitation: forceReinvite bypasses staleness (the reconciler stamps before enqueuing)", () => {
  const now = at("2026-10-01T12:00:00Z");
  // The reconciler sets invitation_date = now() when it enqueues, so by the time the worker runs the
  // envelope the invitation looks fresh. Without the bypass the queued repair would be a no-op.
  assertEquals(
    shouldSendOrgInvitation({ invitationDate: "2026-10-01T11:59:00Z", cls: TERM, forceReinvite: true, now }),
    true
  );
});
