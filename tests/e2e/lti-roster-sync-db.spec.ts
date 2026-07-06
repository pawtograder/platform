/**
 * DB-level coverage for the LTI roster-sync email-link guard in
 * public.sis_sync_enrollment (migration 20260528130000). The LTI roster path
 * stamps a roster member's surrogate sis_user_id onto a pre-existing Pawtograder
 * account matched by email, so a member who already signed in is adopted instead
 * of duplicated. A max-effort review found that matching on email ALONE could
 * adopt the WRONG account (a recycled alias, or an attacker self-signup with the
 * victim's email). The fix gates adoption on the target account's email being
 * CONFIRMED. These tests pin both directions against the real RPC.
 *
 * Runs in the default per-PR Playwright lane (no Canvas) — it lives at tests/e2e/
 * root, NOT under lti/, so playwright.config.ts's testIgnore does not skip it.
 */
import { test, expect } from "../global-setup";
import { createClass, createClassWithSISSections, simulateSISSync, getEnrollmentState, supabase } from "./TestingUtils";

/** Create a bare auth user (and, via the auth trigger, a public.users row with a
 *  NULL sis_user_id). `confirmed` controls auth.users.email_confirmed_at. */
async function createBareAuthUser(email: string, confirmed: boolean): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: confirmed,
    password: `change-it-${Math.random().toString(36).slice(2)}`
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

async function readSisUserId(userId: string): Promise<number | null> {
  const { data } = await supabase.from("users").select("sis_user_id").eq("user_id", userId).single();
  return (data?.sis_user_id as number | null) ?? null;
}

const surrogate = () => Math.floor(1_500_000_000 + Math.random() * 400_000_000);
const uniqueEmail = (tag: string) => `lti-${tag}-${Math.random().toString(36).slice(2, 10)}@school.edu`;

test.describe("LTI roster sync — email-link adoption is gated on a confirmed email", () => {
  test.describe.configure({ mode: "serial" });

  test("adopts a pre-existing account whose email is CONFIRMED", async () => {
    const course = await createClass({ name: "E2E LTI Email Link - Confirmed" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [31111], lab_section_crns: [32222] });

    const email = uniqueEmail("confirmed");
    const userId = await createBareAuthUser(email, true);
    expect(await readSisUserId(userId)).toBeNull(); // not yet linked

    const sis_user_id = surrogate();
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Confirmed Member", role: "student", email }],
      drop_missing: false
    });

    // The confirmed account is adopted: its surrogate sis_user_id is stamped and it
    // is enrolled (not left as a dangling invitation / duplicate).
    expect(await readSisUserId(userId)).toBe(sis_user_id);
    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user?.user_id).toBe(userId);
    expect(state.user_role).not.toBeNull();
  });

  test("does NOT adopt a pre-existing account whose email is UNCONFIRMED (squat guard); invites instead", async () => {
    const course = await createClass({ name: "E2E LTI Email Link - Unconfirmed" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [33111], lab_section_crns: [34222] });

    const email = uniqueEmail("unconfirmed");
    const userId = await createBareAuthUser(email, false);
    expect(await readSisUserId(userId)).toBeNull();

    const sis_user_id = surrogate();
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Unconfirmed Squatter", role: "student", email }],
      drop_missing: false
    });

    // The unconfirmed account is left untouched (NOT adopted into the course)...
    expect(await readSisUserId(userId)).toBeNull();
    // ...and the member is handled via the safe path: a fresh SIS-managed invitation,
    // with no enrollment bound to the unconfirmed account.
    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user).toBeUndefined();
    expect(state.invitation?.status).toBe("pending");
    expect(state.invitation?.sis_managed).toBe(true);
  });
});
