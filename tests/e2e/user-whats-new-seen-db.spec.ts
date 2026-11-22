import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { createAuthenticatedClient, createClass, createUserInClass, supabase } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// Contract tests for public.user_whats_new_seen
// (supabase/migrations/20261121150100_user_whats_new_seen.sql). The escalation walkthrough reads
// this row before opening on its own and writes it on Close or Done, so a person sees it once on
// any browser. No browser here: these pin the RLS the component relies on.
//   * a user can record and read their own row, and recording twice is not an error;
//   * a user can't read another user's row, or record one in their name;
//   * a user can't change or remove a row, and anon can't touch the table.
const ITEM = "oh-escalation:v1";

function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

test.describe("user_whats_new_seen", () => {
  test.describe.configure({ timeout: 120_000 });

  let alice: TestingUser;
  let bob: TestingUser;
  let aliceClient: SupabaseClient<Database>;
  let bobClient: SupabaseClient<Database>;

  async function rowsFor(user: TestingUser) {
    const { data, error } = await supabase.from("user_whats_new_seen").select("*").eq("user_id", user.user_id);
    expect(error).toBeNull();
    return data!;
  }

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Whats New ${suffix}` });
    alice = await createUserInClass({
      role: "grader",
      class_id: course.id,
      name: `E2E Whats New A ${suffix}`,
      email: `e2e-whats-new-a-${suffix}@pawtograder.net`
    });
    bob = await createUserInClass({
      role: "instructor",
      class_id: course.id,
      name: `E2E Whats New B ${suffix}`,
      email: `e2e-whats-new-b-${suffix}@pawtograder.net`
    });
    aliceClient = await createAuthenticatedClient(alice);
    bobClient = await createAuthenticatedClient(bob);
  });

  test("a user records and reads their own row, and recording again is not an error", async () => {
    const before = await aliceClient.from("user_whats_new_seen").select("item").eq("item", ITEM).maybeSingle();
    expect(before.error).toBeNull();
    expect(before.data).toBeNull();

    // Same call as the component: no user_id, so the column default fills in auth.uid().
    for (let i = 0; i < 2; i++) {
      const { error } = await aliceClient
        .from("user_whats_new_seen")
        .upsert({ item: ITEM }, { onConflict: "user_id,item", ignoreDuplicates: true });
      expect(error).toBeNull();
    }

    const after = await aliceClient.from("user_whats_new_seen").select("item").eq("item", ITEM).maybeSingle();
    expect(after.error).toBeNull();
    expect(after.data).toEqual({ item: ITEM });
    expect((await rowsFor(alice)).map((r) => r.item)).toEqual([ITEM]);
  });

  test("a user can't see another user's row", async () => {
    // Bob has no row of his own; Alice's row (from the test above, or this insert) must stay hidden.
    await supabase
      .from("user_whats_new_seen")
      .upsert({ user_id: alice.user_id, item: ITEM }, { onConflict: "user_id,item", ignoreDuplicates: true });
    const { data, error } = await bobClient.from("user_whats_new_seen").select("*");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    // Positive control: the same read as Alice returns her row.
    const own = await aliceClient.from("user_whats_new_seen").select("user_id");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ user_id: alice.user_id }]);
  });

  test("a user can't record a row in someone else's name", async () => {
    const { error } = await bobClient.from("user_whats_new_seen").insert({ user_id: alice.user_id, item: "other:v1" });
    expect(error?.code).toBe("42501");
    expect((await rowsFor(alice)).map((r) => r.item)).not.toContain("other:v1");
  });

  test("a user can't change or remove a row, even their own", async () => {
    await supabase
      .from("user_whats_new_seen")
      .upsert({ user_id: alice.user_id, item: ITEM }, { onConflict: "user_id,item", ignoreDuplicates: true });

    const update = await aliceClient.from("user_whats_new_seen").update({ item: "renamed:v1" }).eq("item", ITEM);
    expect(update.error?.code).toBe("42501");
    const del = await aliceClient.from("user_whats_new_seen").delete().eq("item", ITEM);
    expect(del.error?.code).toBe("42501");

    expect((await rowsFor(alice)).map((r) => r.item)).toEqual([ITEM]);
  });

  test("anon can't read or write the table", async () => {
    const read = await anonClient().from("user_whats_new_seen").select("*");
    expect(read.error?.code).toBe("42501");
    const write = await anonClient().from("user_whats_new_seen").insert({ user_id: bob.user_id, item: ITEM });
    expect(write.error?.code).toBe("42501");
    expect(await rowsFor(bob)).toEqual([]);
  });
});
