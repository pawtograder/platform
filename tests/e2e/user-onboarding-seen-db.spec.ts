/**
 * DB-level coverage for user_onboarding_seen
 * (supabase/migrations/20261121160000_user_onboarding_seen.sql).
 *
 * The table holds which onboarding guides each user has seen. Its RLS has to do three things:
 *   * a signed-in user can insert and read their own rows, and inserting the same key twice is
 *     not an error;
 *   * a user can't read another user's rows, or insert a row for someone else;
 *   * nobody can change or remove a row once written, and the anon key can't read the table.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { createClass, createUserInClass, createAuthenticatedClient, supabase, type TestingUser } from "./TestingUtils";
import { hasSeenOnboarding, markOnboardingSeen, ONBOARDING_KEYS } from "@/lib/onboardingSeen";

const KEY = ONBOARDING_KEYS.OFFICE_HOURS_STUDENT_ONBOARDING;

function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** The rows the service role sees for a user, so a test can check what RLS let through. */
async function rowsFor(user: TestingUser) {
  const { data, error } = await supabase.from("user_onboarding_seen").select("*").eq("user_id", user.user_id);
  expect(error).toBeNull();
  return data ?? [];
}

test.describe("user_onboarding_seen RLS", () => {
  // The later tests read the row the first one writes.
  test.describe.configure({ mode: "serial" });

  let studentA: TestingUser;
  let studentB: TestingUser;
  let clientA: SupabaseClient<Database>;
  let clientB: SupabaseClient<Database>;

  test.beforeAll(async () => {
    const course = await createClass({ name: "E2E Onboarding Seen" });
    studentA = await createUserInClass({ role: "student", class_id: course.id });
    studentB = await createUserInClass({ role: "student", class_id: course.id });
    clientA = await createAuthenticatedClient(studentA);
    clientB = await createAuthenticatedClient(studentB);
  });

  test("a user records a guide as seen once, and reading it back says seen", async () => {
    expect(await hasSeenOnboarding(clientA, KEY)).toBe(false);

    await markOnboardingSeen(clientA, KEY);
    // A second click on the same guide must not fail.
    await markOnboardingSeen(clientA, KEY);

    expect(await hasSeenOnboarding(clientA, KEY)).toBe(true);
    const rows = await rowsFor(studentA);
    expect(rows.map((row) => row.key)).toEqual([KEY]);
  });

  test("another user can't see that row, and has their own answer", async () => {
    const { data, error } = await clientB.from("user_onboarding_seen").select("*").eq("user_id", studentA.user_id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await hasSeenOnboarding(clientB, KEY)).toBe(false);
  });

  test("a user can't insert a row for someone else", async () => {
    const { error } = await clientB.from("user_onboarding_seen").insert({ user_id: studentA.user_id, key: KEY });
    expect(error?.code).toBe("42501");
  });

  test("nobody can change or remove a row once it is written", async () => {
    await clientA.from("user_onboarding_seen").update({ seen_at: "2000-01-01T00:00:00Z" }).eq("key", KEY);
    await clientA.from("user_onboarding_seen").delete().eq("key", KEY);

    const rows = await rowsFor(studentA);
    expect(rows).toHaveLength(1);
    expect(rows[0].seen_at).not.toBe("2000-01-01T00:00:00+00:00");
  });

  test("the anon key can't read the table", async () => {
    const { data, error } = await anonClient().from("user_onboarding_seen").select("*");
    expect(data ?? []).toEqual([]);
    expect(error?.code).toBe("42501");
  });

  test("keys are lowercase words joined by dashes", async () => {
    const { error } = await clientA.from("user_onboarding_seen").insert({ key: "Office Hours" });
    expect(error?.code).toBe("23514");
  });
});
