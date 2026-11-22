/**
 * The client side of the onboarding guides' rows in user_whats_new_seen (lib/onboardingSeen.ts).
 * The table's RLS is checked against a real database in tests/e2e/user-whats-new-seen-db.spec.ts
 * (#1261). These tests check which queries the helpers send and how they report the results.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { hasSeenOnboarding, markOnboardingSeen, ONBOARDING_KEYS } from "@/lib/onboardingSeen";

const KEY = ONBOARDING_KEYS.OFFICE_HOURS_STUDENT_ONBOARDING;

/** A stand-in for the few supabase-js builder calls the helpers make. */
function fakeClient(result: { data?: unknown; error?: unknown }) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  const eq = jest.fn(() => ({ maybeSingle }));
  const select = jest.fn(() => ({ eq }));
  const upsert = jest.fn().mockResolvedValue({ error: result.error ?? null });
  const from = jest.fn(() => ({ select, upsert }));
  const client = { from } as unknown as SupabaseClient<Database>;
  return { client, from, select, eq, upsert };
}

describe("hasSeenOnboarding", () => {
  it("reads the guide's row from user_whats_new_seen", async () => {
    const fake = fakeClient({ data: { item: KEY } });
    await expect(hasSeenOnboarding(fake.client, KEY)).resolves.toBe(true);
    expect(fake.from).toHaveBeenCalledWith("user_whats_new_seen");
    expect(fake.eq).toHaveBeenCalledWith("item", KEY);
  });

  it("says not seen when the user has no row for the guide", async () => {
    await expect(hasSeenOnboarding(fakeClient({ data: null }).client, KEY)).resolves.toBe(false);
  });

  it("throws when the read fails, instead of guessing", async () => {
    const error = { message: "network down" };
    await expect(hasSeenOnboarding(fakeClient({ error }).client, KEY)).rejects.toBe(error);
  });
});

describe("markOnboardingSeen", () => {
  it("inserts the guide as the item and lets the database fill in the user", async () => {
    const fake = fakeClient({});
    await markOnboardingSeen(fake.client, KEY);
    expect(fake.from).toHaveBeenCalledWith("user_whats_new_seen");
    expect(fake.upsert).toHaveBeenCalledWith({ item: KEY }, { onConflict: "user_id,item", ignoreDuplicates: true });
  });

  it("throws when the insert fails", async () => {
    const error = { message: "permission denied" };
    await expect(markOnboardingSeen(fakeClient({ error }).client, KEY)).rejects.toBe(error);
  });
});
