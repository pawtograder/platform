import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import { DISCORD_DLQ, drainQueue, randomGuildId, untypedRpc, untypedTable } from "@/tests/e2e/discordMockUtils";

// Security coverage for the Discord guild claim (supabase/migrations/20260822130000_discord_guild_claim.sql).
//
// WHAT CHANGED AND WHY IT NEEDS A TEST
//
// `classes.discord_server_id` used to be a free-text field an instructor typed into and saved. One
// bot token serves every course on the deployment, so any guild the bot happens to be in was
// reachable from any class — including another course's server, whose roles and channels the async
// worker would then start rewriting. Typing 18 digits was the entire authorization step, and nothing
// stopped two classes from naming the same guild.
//
// The column is now written only by `claim_discord_guild()`, called from the install callback after
// Discord's own consent screen has confirmed which server the instructor controls. The properties
// asserted here are exactly the ones that would let that regress:
//
//   * an instructor UPDATE of discord_server_id is refused by RLS (42501),
//   * discord_channel_group_id — a category INSIDE an already-claimed guild — is still editable,
//   * the claim records who and when,
//   * a guild held by another unarchived class cannot be taken (DISCORD_GUILD_ALREADY_CLAIMED / 23505),
//   * a claimant who is not staff of the class is refused (DISCORD_CLAIM_FORBIDDEN / 42501),
//   * a guild id that is not a snowflake is refused (DISCORD_CLAIM_INVALID / 22023),
//   * and the RPC is not callable with a browser-held key at all — the EXECUTE grant is service_role
//     only, which is what stops the publishable anon key from pointing any class at any guild.
//
// Pure database coverage: no Discord API and no browser. The mock is not needed, so this file does
// not take the mock lock.

test.describe.configure({ mode: "serial" });

test.describe("claim_discord_guild + discord_server_id RLS", () => {
  test.describe.configure({ timeout: 120_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // Distinct per run so a crashed earlier run cannot leave a class holding one of these and trip
  // classes_discord_server_id_active_key on the way in.
  const GUILD_A = randomGuildId();
  const GUILD_CONTESTED = randomGuildId();
  const GUILD_MOVE = randomGuildId();

  let classAId: number;
  let classBId: number;
  let instructorA: TestingUser;
  let instructorB: TestingUser;
  let studentA: TestingUser;

  const classes = () => untypedTable(supabase, "classes");

  async function readClass(classId: number): Promise<Record<string, unknown>> {
    const { data, error } = await classes()
      .select("id, discord_server_id, discord_channel_group_id, discord_server_claimed_by, discord_server_claimed_at")
      .eq("id", classId);
    expect(error, `reading class ${classId} failed`).toBeNull();
    expect(data?.length, `class ${classId} not found`).toBe(1);
    return (data as Record<string, unknown>[])[0];
  }

  test.beforeAll(async () => {
    // Two classes, each with its OWN instructor and its own per-class profiles. createUserInClass
    // creates the `profiles` rows for the class it is given, which matters because
    // user_roles.private_profile_id / public_profile_id are NOT NULL and per-class: reusing another
    // class's profile ids hits a unique violation that an ON CONFLICT DO NOTHING would swallow,
    // leaving a class with no staff and a confusing DISCORD_CLAIM_FORBIDDEN later.
    const clsA = await createClass({ name: `E2E DiscordClaim A ${RUN_PREFIX}` });
    classAId = clsA.id;
    const clsB = await createClass({ name: `E2E DiscordClaim B ${RUN_PREFIX}` });
    classBId = clsB.id;

    instructorA = await createUserInClass({
      role: "instructor",
      class_id: classAId,
      name: `DiscordClaim Instructor A ${RUN_PREFIX}`,
      email: `e2e-dclaim-instr-a-${SAFE_ID}@pawtograder.net`
    });
    instructorB = await createUserInClass({
      role: "instructor",
      class_id: classBId,
      name: `DiscordClaim Instructor B ${RUN_PREFIX}`,
      email: `e2e-dclaim-instr-b-${SAFE_ID}@pawtograder.net`
    });
    studentA = await createUserInClass({
      role: "student",
      class_id: classAId,
      name: `DiscordClaim Student A ${RUN_PREFIX}`,
      email: `e2e-dclaim-stu-a-${SAFE_ID}@pawtograder.net`
    });
  });

  test.afterAll(async () => {
    // A successful claim writes discord_server_id, which fires
    // trg_discord_create_roles_on_server_connect and enqueues create_role / create_channel work.
    // Nothing here runs the worker, so drop those envelopes rather than leaving them for whatever
    // invokes it next.
    const mine = new Set([GUILD_A, GUILD_CONTESTED, GUILD_MOVE]);
    const isMine = (row: { message?: { args?: Record<string, unknown> } }) =>
      mine.has(String((row.message?.args as { guild_id?: string } | undefined)?.guild_id));
    await drainQueue(isMine);
    // A worker run started by another spec drains the same queue and would dead-letter these, since
    // none of these guilds exists in the mock.
    await drainQueue(isMine, DISCORD_DLQ);
    for (const classId of [classAId, classBId]) {
      if (classId) await supabase.from("classes").update({ discord_server_id: null }).eq("id", classId);
    }
  });

  // ---------------------------------------------------------------------------
  // discord_server_id is no longer instructor-writable
  // ---------------------------------------------------------------------------
  test("an instructor cannot set discord_server_id with a direct PostgREST UPDATE", async () => {
    const client = await createAuthenticatedClient(instructorA);
    const { error } = await client.from("classes").update({ discord_server_id: GUILD_A }).eq("id", classAId);

    // 42501: the row passes the policy's USING clause (this really is their class) and fails its
    // WITH CHECK, because only_calendar_or_discord_ids_changed() no longer lists discord_server_id.
    // An UPDATE that was merely filtered out would come back with no error at all, so asserting the
    // error code — not just "the value did not change" — is what distinguishes refusal from a
    // silently-ignored write.
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
    expect(await readClass(classAId)).toMatchObject({ discord_server_id: null });
  });

  test("an instructor cannot forge the claim provenance columns either", async () => {
    const client = await createAuthenticatedClient(instructorA);
    // Both new columns are absent from the allow-list, so an instructor cannot backdate a claim or
    // attribute it to somebody else.
    const loose = client as unknown as {
      from: (t: string) => {
        update: (v: Record<string, unknown>) => {
          eq: (c: string, v: unknown) => Promise<{ error: { code?: string } | null }>;
        };
      };
    };
    const { error } = await loose
      .from("classes")
      .update({ discord_server_claimed_by: instructorA.user_id })
      .eq("id", classAId);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  test("an instructor CAN still update discord_channel_group_id", async () => {
    // A category id inside a guild the class already controls carries none of the cross-tenant risk,
    // and it is the one Discord field an instructor legitimately edits by hand. If this breaks, the
    // settings form silently stops saving.
    const client = await createAuthenticatedClient(instructorA);
    const categoryId = "1400000000000009001";
    const { error } = await client.from("classes").update({ discord_channel_group_id: categoryId }).eq("id", classAId);
    expect(error).toBeNull();
    expect(await readClass(classAId)).toMatchObject({ discord_channel_group_id: categoryId });
  });

  // ---------------------------------------------------------------------------
  // The RPC is service_role only
  // ---------------------------------------------------------------------------
  test("claim_discord_guild is not callable by an authenticated (non-service-role) caller", async () => {
    // The hole this closes: REVOKE ... FROM PUBLIC would have left the anon and authenticated ACL
    // entries Supabase grants at CREATE time in place, and a browser-held key could then point any
    // class at any guild. Both roles are revoked by name, so both must be refused.
    const authed = await createAuthenticatedClient(instructorA);
    const { error } = await untypedRpc(authed, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_A,
      p_claimed_by: instructorA.user_id
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
    expect(error?.message ?? "").toMatch(/permission denied for function claim_discord_guild/i);
    expect(await readClass(classAId)).toMatchObject({ discord_server_id: null });
  });

  test("claim_discord_guild is not callable with the anon key", async () => {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(url, "SUPABASE_URL is required").toBeTruthy();
    expect(anonKey, "SUPABASE_ANON_KEY is required").toBeTruthy();
    const anon = createClient(url as string, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { error } = await untypedRpc(anon as unknown as typeof supabase, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_A
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  // ---------------------------------------------------------------------------
  // Validation and authorization inside the claim
  // ---------------------------------------------------------------------------
  test("a malformed snowflake fails with DISCORD_CLAIM_INVALID", async () => {
    // Validated in the function and not only in the route because this value is interpolated into
    // Discord REST paths by the worker: a guild id carrying a slash would be a path-traversal
    // primitive against the Discord API.
    for (const bad of ["not-a-snowflake", "12345", "1142900000/000000000", "", "  "]) {
      const { error } = await untypedRpc(supabase, "claim_discord_guild", {
        p_class_id: classAId,
        p_guild_id: bad,
        p_claimed_by: instructorA.user_id
      });
      expect(error, `guild id ${JSON.stringify(bad)} should have been refused`).not.toBeNull();
      expect(error?.code).toBe("22023");
      expect(error?.message ?? "").toContain("DISCORD_CLAIM_INVALID");
    }
    expect(await readClass(classAId)).toMatchObject({ discord_server_id: null });
  });

  test("a non-instructor claimant fails with DISCORD_CLAIM_FORBIDDEN", async () => {
    // The claimant is verified rather than merely recorded: this is the only writer of
    // discord_server_id, so a bug in the route must not be able to connect a server on behalf of
    // somebody who is not staff of the class.
    const { error: studentError } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_A,
      p_claimed_by: studentA.user_id
    });
    expect(studentError).not.toBeNull();
    expect(studentError?.code).toBe("42501");
    expect(studentError?.message ?? "").toContain("DISCORD_CLAIM_FORBIDDEN");

    // An instructor of a DIFFERENT class is equally not staff here — the check is class-scoped.
    const { error: otherError } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_A,
      p_claimed_by: instructorB.user_id
    });
    expect(otherError).not.toBeNull();
    expect(otherError?.code).toBe("42501");
    expect(otherError?.message ?? "").toContain("DISCORD_CLAIM_FORBIDDEN");

    // And a null claimant is refused rather than recorded as "unknown", which is exactly the
    // unattributed state the old free-text field left behind.
    const { error: nullError } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_A,
      p_claimed_by: null
    });
    expect(nullError).not.toBeNull();
    expect(nullError?.code).toBe("42501");
    expect(nullError?.message ?? "").toContain("DISCORD_CLAIM_FORBIDDEN");

    expect(await readClass(classAId)).toMatchObject({ discord_server_id: null });
  });

  // ---------------------------------------------------------------------------
  // The happy path, and the provenance it records
  // ---------------------------------------------------------------------------
  test("claim_discord_guild connects the server and records who claimed it and when", async () => {
    const before = Date.now();
    const { data, error } = await untypedRpc<
      Array<{
        class_id: number;
        guild_id: string;
        claimed_by: string;
        claimed_at: string;
        previous_guild_id: string | null;
      }>
    >(supabase, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_A,
      p_claimed_by: instructorA.user_id
    });
    expect(error).toBeNull();
    const row = (data ?? [])[0];
    expect(row).toBeTruthy();
    expect(row.class_id).toBe(classAId);
    expect(row.guild_id).toBe(GUILD_A);
    expect(row.claimed_by).toBe(instructorA.user_id);
    // Null, not the new guild: the caller uses this to tell a fresh connection from a move (a move
    // tears the old guild's roles and channels down).
    expect(row.previous_guild_id).toBeNull();

    const stored = await readClass(classAId);
    expect(stored.discord_server_id).toBe(GUILD_A);
    expect(stored.discord_server_claimed_by).toBe(instructorA.user_id);
    expect(typeof stored.discord_server_claimed_at).toBe("string");
    const claimedAt = new Date(stored.discord_server_claimed_at as string).getTime();
    expect(claimedAt).toBeGreaterThanOrEqual(before - 60_000);
    expect(claimedAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test("re-claiming the guild the class is already on refreshes provenance without a teardown", async () => {
    // Re-running the install flow to widen the bot's permissions, or filling in provenance for a
    // server configured before the claim flow existed. discord_server_id is deliberately left out of
    // the UPDATE, so neither server-change trigger fires and the class keeps its roles.
    const first = await readClass(classAId);
    const { data, error } = await untypedRpc<Array<{ previous_guild_id: string | null }>>(
      supabase,
      "claim_discord_guild",
      { p_class_id: classAId, p_guild_id: GUILD_A, p_claimed_by: instructorA.user_id }
    );
    expect(error).toBeNull();
    // The guild it was already on is reported as the previous one, which is how the route knows this
    // is a refresh rather than a move.
    expect((data ?? [])[0]?.previous_guild_id).toBe(GUILD_A);

    const second = await readClass(classAId);
    expect(second.discord_server_id).toBe(GUILD_A);
    expect(second.discord_server_claimed_by).toBe(instructorA.user_id);
    expect(new Date(second.discord_server_claimed_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(first.discord_server_claimed_at as string).getTime()
    );
  });

  // ---------------------------------------------------------------------------
  // One active class per guild
  // ---------------------------------------------------------------------------
  test("a second class cannot claim a guild an active class already holds", async () => {
    // Class A takes the contested guild first.
    const { error: firstError } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_CONTESTED,
      p_claimed_by: instructorA.user_id
    });
    expect(firstError).toBeNull();

    const { error } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classBId,
      p_guild_id: GUILD_CONTESTED,
      p_claimed_by: instructorB.user_id
    });
    expect(error).not.toBeNull();
    // 23505 (unique_violation), the same SQLSTATE the partial unique index would raise, so the route
    // has one thing to handle whether the conflict was found by the check or by the index.
    expect(error?.code).toBe("23505");
    expect(error?.message ?? "").toContain("DISCORD_GUILD_ALREADY_CLAIMED");
    // The message names the class holding it, because the remediation is a conversation with that
    // course's staff (or archiving it) rather than anything class B can do alone.
    expect(error?.message ?? "").toContain(String(classAId));

    // Class B is untouched: the refusal happens before any write.
    expect(await readClass(classBId)).toMatchObject({ discord_server_id: null });
  });

  test("archiving the holder releases the guild", async () => {
    // The unique index is partial on `archived = false`, and the RPC checks the same condition, so
    // the two cannot disagree about who is holding a server. Archiving the finished course is the
    // documented remediation for the message above; this is that remediation working.
    const { error: archiveError } = await supabase.from("classes").update({ archived: true }).eq("id", classAId);
    expect(archiveError).toBeNull();

    const { error } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classBId,
      p_guild_id: GUILD_CONTESTED,
      p_claimed_by: instructorB.user_id
    });
    expect(error).toBeNull();
    expect(await readClass(classBId)).toMatchObject({
      discord_server_id: GUILD_CONTESTED,
      discord_server_claimed_by: instructorB.user_id
    });
    // The archived class keeps its historical server id; that is what the partial index is for.
    expect(await readClass(classAId)).toMatchObject({ discord_server_id: GUILD_CONTESTED });

    await supabase.from("classes").update({ archived: false, discord_server_id: null }).eq("id", classAId);
  });

  test("a claim for a class that does not exist is refused, not silently created", async () => {
    const { error } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: -1,
      p_guild_id: GUILD_MOVE,
      p_claimed_by: instructorA.user_id
    });
    expect(error).not.toBeNull();
    // no_data_found. A `SELECT ... INTO` with no matching row leaves every target NULL, so this is
    // reported off FOUND rather than off a sentinel column that would read NULL and fall through.
    expect(error?.code).toBe("P0002");
    expect(error?.message ?? "").toContain("DISCORD_CLAIM_CLASS_NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // disconnect_discord_guild
  //
  // The inverse of a claim, and the reason it has to exist: claim_discord_guild validates its
  // argument against '^[0-9]{17,20}$', so it cannot express "no server". Without this RPC, taking
  // discord_server_id off the instructor-writable allow-list left instructors unable to disconnect
  // Discord at all.
  // ---------------------------------------------------------------------------
  test("disconnect_discord_guild is not callable by an authenticated (non-service-role) caller", async () => {
    // The grant is service_role only, same as claim_discord_guild. An instructor reaching it directly
    // would be a second writer of discord_server_id outside the flow.
    const authed = await createAuthenticatedClient(instructorA);
    const { error } = await untypedRpc(authed, "disconnect_discord_guild", {
      p_class_id: classAId,
      p_actor: instructorA.user_id
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
    expect(error?.message ?? "").toMatch(/permission denied for function disconnect_discord_guild/i);
  });

  test("a non-instructor cannot disconnect a class's Discord server", async () => {
    // Set up a server to disconnect, so a refusal cannot pass merely because there was nothing there.
    const { error: claimError } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classAId,
      p_guild_id: GUILD_MOVE,
      p_claimed_by: instructorA.user_id
    });
    expect(claimError).toBeNull();

    for (const [label, actor] of [
      ["a student of the class", studentA.user_id],
      ["an instructor of a different class", instructorB.user_id],
      ["no actor at all", null]
    ] as const) {
      const { error } = await untypedRpc(supabase, "disconnect_discord_guild", {
        p_class_id: classAId,
        p_actor: actor
      });
      expect(error, `${label} should not be able to disconnect`).not.toBeNull();
      expect(error?.message ?? "").toContain("DISCORD_CLAIM_FORBIDDEN");
    }

    // Still connected after all three refusals.
    expect((await readClass(classAId)).discord_server_id).toBe(GUILD_MOVE);
  });

  test("an instructor disconnects the server, and the guild becomes claimable again", async () => {
    const { data, error } = await untypedRpc<Array<{ class_id: number; previous_guild_id: string | null }>>(
      supabase,
      "disconnect_discord_guild",
      { p_class_id: classAId, p_actor: instructorA.user_id }
    );
    expect(error).toBeNull();
    // The released guild is reported back, which is what lets the route name the server it tore down
    // instead of saying "a server".
    expect((data ?? [])[0]?.previous_guild_id).toBe(GUILD_MOVE);

    const after = await readClass(classAId);
    expect(after.discord_server_id).toBeNull();
    // Provenance is cleared too. Leaving it would make the settings page report a claim on a server
    // the class is no longer connected to.
    expect(after.discord_server_claimed_by).toBeNull();
    expect(after.discord_server_claimed_at).toBeNull();

    // The point of releasing it: the other class can now take the same guild, which the unique index
    // would have refused a moment ago.
    const { error: reclaimError } = await untypedRpc(supabase, "claim_discord_guild", {
      p_class_id: classBId,
      p_guild_id: GUILD_MOVE,
      p_claimed_by: instructorB.user_id
    });
    expect(reclaimError).toBeNull();
    expect((await readClass(classBId)).discord_server_id).toBe(GUILD_MOVE);

    // Put it back so afterAll's queue drain and the next test see a clean slate.
    await untypedRpc(supabase, "disconnect_discord_guild", {
      p_class_id: classBId,
      p_actor: instructorB.user_id
    });
  });

  test("disconnecting a class that has no server is a no-op, not an error", async () => {
    // A double-submitted button must not 500. The NULL previous_guild_id is how the route knows to
    // stay quiet rather than announcing a teardown that did not happen.
    const { data, error } = await untypedRpc<Array<{ previous_guild_id: string | null }>>(
      supabase,
      "disconnect_discord_guild",
      { p_class_id: classAId, p_actor: instructorA.user_id }
    );
    expect(error).toBeNull();
    expect((data ?? [])[0]?.previous_guild_id).toBeNull();
    expect((await readClass(classAId)).discord_server_id).toBeNull();
  });

  test("a disconnect for a class that does not exist is refused", async () => {
    const { error } = await untypedRpc(supabase, "disconnect_discord_guild", {
      p_class_id: -1,
      p_actor: instructorA.user_id
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("P0002");
    expect(error?.message ?? "").toContain("DISCORD_CLAIM_CLASS_NOT_FOUND");
  });
});
