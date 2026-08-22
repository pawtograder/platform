import { expect, test } from "@playwright/test";
import { createClass, createUserInClass, getTestRunPrefix, supabase } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import { clearCalls, getCalls, getState, waitForCall } from "@/tests/mocks/discord/client";
import {
  GRADER_ROLE_ID,
  INSTRUCTOR_ROLE_ID,
  STUDENT_ROLE_ID,
  addMockMember,
  applyScenarioForGuilds,
  discordApiIsMocked,
  discordMockReachable,
  DISCORD_DLQ,
  DISCORD_QUEUE,
  drainQueue,
  invokeEdgeFunction,
  randomDiscordUserId,
  randomGuildId,
  releaseDiscordMockLock,
  takeDiscordMock,
  touchDiscordMockLock,
  untypedRpc,
  untypedTable,
  waitForQueueMessage
} from "@/tests/e2e/discordMockUtils";

// E2E coverage for the Discord enrollment path end to end: enqueue -> discord-async-worker -> the
// mock Discord API -> the recorded membership state, plus the two safety nets that were added
// because that path fails silently when it fails.
//
// WHAT EACH SECTION IS FOR
//
//  1. Role sync. The straight-line case, asserted at both ends: the worker really issues
//     `PUT /guilds/{g}/members/{u}/roles/{r}` (proved from the mock's call log, not inferred) and the
//     student's `discord_membership_status` really becomes `in_guild`. A test that only checked the
//     database would pass against a worker that never called Discord at all.
//
//  2. Reconciler. All membership observation happens inside ONE hourly `batch_role_sync` envelope. If
//     it is dropped -- an isolate killed mid-sweep, a dead-letter, a requeue that outlives its retry
//     ceiling -- nothing re-observes those users and nothing notices, because a stale `not_joined`
//     row looks exactly like a fresh one. `reconcile_stuck_discord_memberships()` keys on STALENESS
//     for that reason, which is what this asserts.
//
//  3. Circuit breaker. One bot token serves every course, and Discord's rate limit is charged against
//     the token rather than the guild, so one misconfigured server turns every enrolled student into
//     a 403 and spends the whole platform's Discord budget rediscovering the same fact (557 of 594
//     dead-letter rows on 2026-08-11 were exactly that). The breaker is keyed on the guild, and the
//     assertion that matters is the SCOPING: the storming guild is parked and a different guild's
//     circuit stays closed.
//
// ORDERING TRAP, worth stating because it fails silently. `users.discord_id` must be set BEFORE any
// `discord_membership_status` row is inserted for that user: the trigger
// `clear_discord_membership_status_on_identity_change` deletes a user's membership rows whenever
// their linked account changes, so linking the account afterwards wipes the fixture and the spec then
// asserts against nothing.
//
// Requires the mock (scripts/start-discord-mock.sh), `DISCORD_API_BASE_URL` pointing at it in the env
// file `supabase functions serve` was started with, and EDGE_FUNCTION_SECRET. No browser.

/** Long enough for a bounded worker run to drain what a test enqueued. */
const WORKER_SETTLE_MS = 45_000;

test.describe.configure({ mode: "serial" });

test.describe("Discord enrollment: worker, reconciler, circuit breaker", () => {
  test.describe.configure({ timeout: 240_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // Three guilds, one per concern, so the breaker's per-guild scoping is expressible: the storm
  // happens in STORM_GUILD and the assertion is that SYNC_GUILD's circuit is untouched.
  const SYNC_GUILD = randomGuildId();
  const RECON_GUILD = randomGuildId();
  const STORM_GUILD = randomGuildId();
  const ALL_GUILDS = [SYNC_GUILD, RECON_GUILD, STORM_GUILD];

  // Distinct per user: lookupUserIdByDiscordId() uses `.single()`, so two platform users sharing a
  // Discord id would make the worker's reverse lookup fail rather than pick one.
  const SYNC_DISCORD_ID = randomDiscordUserId();
  const RECON_DISCORD_ID = randomDiscordUserId();
  const STORM_DISCORD_ID = randomDiscordUserId();

  let syncClassId: number;
  let reconClassId: number;
  let stormClassId: number;
  let syncStudent: TestingUser;
  let reconStudent: TestingUser;
  let stormStudent: TestingUser;
  let mockUp = false;

  const membership = () => untypedTable(supabase, "discord_membership_status");
  const breakers = () => untypedTable(supabase, "discord_circuit_breakers");
  const asyncErrors = () => untypedTable(supabase, "discord_async_errors");

  /** Point a class at a guild and record the class roles the mock's snowflakes stand for. */
  async function connectClass(classId: number, guildId: string): Promise<void> {
    // Service role, because since 20260822130000 discord_server_id is written only by
    // claim_discord_guild() (see discord-guild-claim.test.tsx). Service role bypasses RLS.
    const { error: connectError } = await supabase
      .from("classes")
      .update({ discord_server_id: guildId })
      .eq("id", classId);
    expect(connectError, `connecting class ${classId} to guild ${guildId}`).toBeNull();

    // After the server, never before: clear_discord_roles_on_server_change fires BEFORE UPDATE of
    // discord_server_id and deletes the class's roles, so the other order leaves none.
    const { error: rolesError } = await supabase.from("discord_roles").insert([
      { class_id: classId, discord_role_id: STUDENT_ROLE_ID, role_type: "student" },
      { class_id: classId, discord_role_id: GRADER_ROLE_ID, role_type: "grader" },
      { class_id: classId, discord_role_id: INSTRUCTOR_ROLE_ID, role_type: "instructor" }
    ]);
    expect(rolesError, `seeding discord_roles for class ${classId}`).toBeNull();
  }

  async function linkDiscord(user: TestingUser, discordId: string): Promise<void> {
    const { error } = await supabase
      .from("users")
      .update({ discord_id: discordId, discord_username: `e2e-${discordId.slice(-4)}` })
      .eq("user_id", user.user_id);
    expect(error, `linking discord_id for ${user.email}`).toBeNull();
  }

  async function membershipRow(classId: number, userId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await membership()
      .select("class_id, user_id, guild_id, state, detail, last_observed_at, last_retry_requested_at")
      .eq("class_id", classId);
    expect(error).toBeNull();
    return (data ?? []).find((row) => row.user_id === userId) ?? null;
  }

  async function enqueueRoleSync(userId: string, classId: number, role = "student"): Promise<void> {
    const { error } = await untypedRpc(supabase, "enqueue_discord_role_sync", {
      p_user_id: userId,
      p_class_id: classId,
      p_role: role,
      p_action: "add"
    });
    expect(error, "enqueue_discord_role_sync failed").toBeNull();
  }

  /**
   * Poke the worker until `settled` reports true, or give up.
   *
   * The worker answers 200 immediately and does its work under `waitUntil`, so the response says
   * nothing about the outcome. With no Redis configured it runs in "bounded" mode -- drain until the
   * queue is idle, then return -- so a poke that arrives while a previous run is still going is
   * answered `already_running: true` and does nothing; polling and re-poking covers both.
   */
  async function driveWorker(settled: () => Promise<boolean>, timeoutMs = WORKER_SETTLE_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let pokes = 0;
    while (Date.now() < deadline) {
      const response = await invokeEdgeFunction("discord-async-worker");
      expect(response.status, `worker poke returned ${response.status}`).toBe(200);
      pokes += 1;
      const innerDeadline = Math.min(deadline, Date.now() + 8_000);
      while (Date.now() < innerDeadline) {
        if (await settled()) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // "The worker never settled" and "the assertion is wrong" fail the same way; this is what tells
    // them apart from a CI log.
    // eslint-disable-next-line no-console
    console.warn(`[discord-enrollment] worker did not settle after ${pokes} poke(s) in ${timeoutMs}ms`);
    return false;
  }

  test.beforeAll(async () => {
    // The hook's own timeout, not the tests'. takeDiscordMock() below can wait a while: the mock is
    // one process and one scenario at a time, so every spec file that drives it queues behind the
    // others -- and Playwright runs this file once per browser project even though neither test here
    // opens a browser. The default 60s hook timeout is shorter than that queue, and the failure it
    // produces ("beforeAll hook timeout") looks nothing like the contention that caused it.
    test.setTimeout(300_000);
    // `mockUp` is what afterAll releases the lock on, so it is set AFTER the lock is actually held.
    // Setting it first meant a takeDiscordMock() that timed out still ran the release path, and this
    // file would then delete a lock another spec file holds.
    if (!((await discordMockReachable()) && discordApiIsMocked())) return;
    await takeDiscordMock();
    mockUp = true;

    const clsSync = await createClass({ name: `E2E DiscordEnroll Sync ${RUN_PREFIX}` });
    syncClassId = clsSync.id;
    const clsRecon = await createClass({ name: `E2E DiscordEnroll Recon ${RUN_PREFIX}` });
    reconClassId = clsRecon.id;
    const clsStorm = await createClass({ name: `E2E DiscordEnroll Storm ${RUN_PREFIX}` });
    stormClassId = clsStorm.id;

    syncStudent = await createUserInClass({
      role: "student",
      class_id: syncClassId,
      name: `DiscordEnroll Sync ${RUN_PREFIX}`,
      email: `e2e-denroll-sync-${SAFE_ID}@pawtograder.net`
    });
    reconStudent = await createUserInClass({
      role: "student",
      class_id: reconClassId,
      name: `DiscordEnroll Recon ${RUN_PREFIX}`,
      email: `e2e-denroll-recon-${SAFE_ID}@pawtograder.net`
    });
    stormStudent = await createUserInClass({
      role: "student",
      class_id: stormClassId,
      name: `DiscordEnroll Storm ${RUN_PREFIX}`,
      email: `e2e-denroll-storm-${SAFE_ID}@pawtograder.net`
    });

    await connectClass(syncClassId, SYNC_GUILD);
    await connectClass(reconClassId, RECON_GUILD);
    await connectClass(stormClassId, STORM_GUILD);

    await linkDiscord(syncStudent, SYNC_DISCORD_ID);
    await linkDiscord(reconStudent, RECON_DISCORD_ID);
    await linkDiscord(stormStudent, STORM_DISCORD_ID);

    // Everything already on the queue is residue: connecting a server enqueues create_role and
    // create_channel work, seeding all three discord_roles rows fires
    // trigger_sync_existing_users_on_role_creation, and a local stack accumulates hourly
    // batch_role_sync envelopes because the pg_cron poke has no edge-function secret and 401s. Any of
    // it would run on the first poke below and rewrite these fixtures -- a create_role in particular
    // would replace the seeded discord_roles rows with freshly minted mock roles.
    const dropped = await drainQueue();
    // Worth saying out loud: a surprising count here means the local stack had residue that would
    // otherwise have run inside this spec's worker pokes.
    // eslint-disable-next-line no-console
    console.log(`[discord-enrollment] cleared ${dropped} pre-existing discord_async_calls message(s)`);
  });

  test.afterAll(async () => {
    if (!mockUp) return;
    const guildOf = (row: { message?: { args?: Record<string, unknown> } }) =>
      String((row.message?.args as { guild_id?: string } | undefined)?.guild_id ?? "");
    const mine = new Set(ALL_GUILDS);
    const myClasses = new Set([syncClassId, reconClassId, stormClassId]);
    const isMine = (row: { message?: { class_id?: number; args?: Record<string, unknown> } }) =>
      mine.has(guildOf(row)) || (row.message?.class_id !== undefined && myClasses.has(row.message.class_id));
    // Both queues: a terminal permission failure is dead-lettered rather than retried, so the storm
    // section deliberately produces DLQ rows.
    //
    // Envelopes the breaker deferred carry `vt = now() + 180s` and are invisible to any read until
    // then, so a few can survive this. They are harmless -- the class no longer points at the guild,
    // so the worker's per-handler guild check drops them -- and the next run's blanket drain collects
    // them.
    // A bounded worker run drains until the queue is idle and only then returns, so one may still be
    // going when the last test ends. Give it a moment before cleaning up, or the rows it writes next
    // arrive after the cleanup that was meant to collect them.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await drainQueue(isMine, DISCORD_QUEUE, 15_000);
    await drainQueue(isMine, DISCORD_DLQ, 15_000);
    // Breaker and error rows are global state keyed on the guild, so leaving them behind would park
    // these guilds for the next run and make its worker defer everything.
    await breakers().delete().in("key", ALL_GUILDS);
    await asyncErrors().delete().in("guild_id", ALL_GUILDS);
    for (const classId of [syncClassId, reconClassId, stormClassId]) {
      if (classId) await supabase.from("classes").update({ discord_server_id: null }).eq("id", classId);
    }
    releaseDiscordMockLock();
  });

  test.beforeEach(async () => {
    test.skip(
      !mockUp,
      "Discord mock is not reachable or the edge runtime is not pointed at it; run scripts/start-discord-mock.sh"
    );
    touchDiscordMockLock();
  });

  // ---------------------------------------------------------------------------
  // 1. Role sync
  // ---------------------------------------------------------------------------
  test("the worker refuses to run without the edge-function secret", async () => {
    const response = await invokeEdgeFunction("discord-async-worker", { secret: null });
    expect(response.status).toBe(401);
    const response2 = await invokeEdgeFunction("discord-async-worker", { secret: "not-the-secret" });
    expect(response2.status).toBe(401);
  });

  test("a queued role sync reaches Discord and records the student as in_guild", async () => {
    await applyScenarioForGuilds("healthy", ALL_GUILDS);
    // The student has joined the server but holds no class role yet, which is the state a role sync
    // exists to fix.
    await addMockMember(SYNC_GUILD, SYNC_DISCORD_ID, "sync-student");
    await clearCalls();

    await enqueueRoleSync(syncStudent.user_id, syncClassId);

    const settled = await driveWorker(async () => {
      const row = await membershipRow(syncClassId, syncStudent.user_id);
      return row?.state === "in_guild";
    });
    expect(settled, "the worker did not record in_guild in time").toBe(true);

    // Proved from the mock, not inferred from the database: the role really was assigned.
    const assign = await waitForCall(
      (call) =>
        call.method === "PUT" &&
        call.path === `/guilds/${SYNC_GUILD}/members/${SYNC_DISCORD_ID}/roles/${STUDENT_ROLE_ID}`,
      10_000
    );
    expect(assign.status).toBe(204);

    // And the membership check that preceded it, which is how the worker decided the student was in
    // the guild rather than needing an invite.
    const calls = await getCalls();
    expect(calls.some((c) => c.method === "GET" && c.path === `/guilds/${SYNC_GUILD}/members/${SYNC_DISCORD_ID}`)).toBe(
      true
    );
    // Nothing was invited: an invite for a student already in the server is the duplicate-invite bug.
    // Read off the mock's state rather than filtered out of the call log, because an invite request
    // names a channel and not a guild -- and the log is shared with whatever else is running.
    const invites = Object.values((await getState()).invites ?? {});
    expect(invites.filter((invite) => invite.guild_id === SYNC_GUILD)).toHaveLength(0);

    const row = await membershipRow(syncClassId, syncStudent.user_id);
    expect(row).toBeTruthy();
    expect(row?.state).toBe("in_guild");
    expect(row?.guild_id).toBe(SYNC_GUILD);
  });

  test("the mock now shows the student holding the class role", async () => {
    // The end state read from the mock's world rather than from its log: the role list on the member
    // object is what Discord would report to anyone else asking, so this is the assertion a caller
    // that never inspects our call log would care about.
    const state = await getState();
    expect(state.guilds[SYNC_GUILD]?.members?.[SYNC_DISCORD_ID]?.roles).toContain(STUDENT_ROLE_ID);
  });

  // ---------------------------------------------------------------------------
  // 2. Reconciler
  // ---------------------------------------------------------------------------
  test("discord-reconciler refuses a request without the edge-function secret", async () => {
    // x-supabase-webhook-source is an attacker-settable routing label and must never grant access on
    // its own, so it is sent here deliberately.
    const response = await invokeEdgeFunction("discord-reconciler", { secret: null });
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).toContain("Unauthorized");
  });

  test("discord-reconciler re-enqueues a membership check that has gone stale", async () => {
    await applyScenarioForGuilds("healthy", ALL_GUILDS);

    // Four hours stale: the function's default window is 180 minutes, three missed hourly passes.
    // Inserted AFTER linkDiscord ran in beforeAll -- doing it the other way round would have this row
    // deleted by clear_discord_membership_status_on_identity_change.
    const staleAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    await membership().delete().eq("class_id", reconClassId);
    const { error: insertError } = await membership().insert({
      class_id: reconClassId,
      user_id: reconStudent.user_id,
      guild_id: RECON_GUILD,
      state: "not_joined",
      detail: "e2e: pretending the hourly sweep was lost",
      first_observed_at: staleAt,
      last_observed_at: staleAt
    });
    expect(insertError, "seeding a stale not_joined row").toBeNull();

    // The function skips candidates that already have work queued, so start from an empty queue.
    await drainQueue();

    const response = await invokeEdgeFunction("discord-reconciler");
    expect(response.status).toBe(200);
    const body = response.body as { success?: boolean; requeued?: number };
    expect(body.success).toBe(true);
    expect(body.requeued ?? 0).toBeGreaterThanOrEqual(1);

    // The specific envelope, not just the count: `requeued` counts every stale candidate on the
    // deployment, so a number alone would pass without this fixture being involved at all.
    const queued = await waitForQueueMessage(
      (row) =>
        row.message?.method === "add_member_role" &&
        (row.message.args as { guild_id?: string; user_id?: string; role_id?: string })?.guild_id === RECON_GUILD &&
        (row.message.args as { user_id?: string })?.user_id === RECON_DISCORD_ID
    );
    expect(queued, `no add_member_role queued for ${RECON_DISCORD_ID} in ${RECON_GUILD}`).toBeTruthy();
    expect((queued?.message.args as { role_id?: string })?.role_id).toBe(STUDENT_ROLE_ID);

    // And the row is stamped, so the next pass does not pile a second copy on top of this one.
    const row = await membershipRow(reconClassId, reconStudent.user_id);
    expect(row?.last_retry_requested_at).toBeTruthy();
  });

  test("a second reconciler pass does not re-enqueue the same user", async () => {
    // last_retry_requested_at is inside the same window now, so this candidate is being handled and
    // must be left alone. Without that guard the reconciler would quadruple the hourly sync's Discord
    // calls, which is worse than the failure it repairs.
    await drainQueue();
    const response = await invokeEdgeFunction("discord-reconciler");
    expect(response.status).toBe(200);

    const queued = await waitForQueueMessage(
      (row) =>
        row.message?.method === "add_member_role" &&
        (row.message.args as { guild_id?: string })?.guild_id === RECON_GUILD,
      3_000
    );
    expect(queued, "the same stale row was re-enqueued twice").toBeNull();
  });

  test("a dropped student's stuck membership stops being alerted on", async () => {
    // A student who reached cannot_invite and was then dropped keeps their status row: nothing
    // deletes it on disable, deliberately, so re-enabling them does not lose the history. The
    // reconciler must still stop paging the class about somebody who is no longer expected in the
    // server. Asserted as a DELTA rather than an absolute, because `long_stuck_users` counts every
    // affected class on the deployment and other specs seed their own.
    const staleAt = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    await membership().delete().eq("class_id", reconClassId);
    const { error: insertError } = await membership().insert({
      class_id: reconClassId,
      user_id: reconStudent.user_id,
      guild_id: RECON_GUILD,
      state: "cannot_invite",
      discord_error_code: 50013,
      detail: "e2e: bot cannot invite",
      first_observed_at: staleAt,
      last_observed_at: staleAt
    });
    expect(insertError, "seeding a long-stuck cannot_invite row").toBeNull();

    const withActive = await invokeEdgeFunction("discord-reconciler");
    const activeCount = (withActive.body as { long_stuck_users?: number }).long_stuck_users ?? 0;
    expect(activeCount, "an active student's stuck row should be alerted on").toBeGreaterThanOrEqual(1);

    // Drop them.
    const { error: disableError } = await supabase
      .from("user_roles")
      .update({ disabled: true })
      .eq("class_id", reconClassId)
      .eq("user_id", reconStudent.user_id);
    expect(disableError, "disabling the enrollment").toBeNull();

    const withDropped = await invokeEdgeFunction("discord-reconciler");
    const droppedCount = (withDropped.body as { long_stuck_users?: number }).long_stuck_users ?? 0;
    expect(droppedCount, "a dropped student must not be counted as a live failure").toBe(activeCount - 1);

    // Put the enrollment back so later tests in this file see the fixture they expect.
    await supabase
      .from("user_roles")
      .update({ disabled: false })
      .eq("class_id", reconClassId)
      .eq("user_id", reconStudent.user_id);
    await membership().delete().eq("class_id", reconClassId);
  });

  // ---------------------------------------------------------------------------
  // 3. Circuit breaker
  // ---------------------------------------------------------------------------
  test("a permission storm in one guild opens THAT guild's circuit and leaves others closed", async () => {
    // Manage Roles is the one permission the bot cannot get from @everyone, and losing it is what a
    // server admin does by accident. Every role assignment then answers 403 / 50013 -- once per
    // enrolled student, all against the one token every course shares.
    await applyScenarioForGuilds("missing-manage-roles", ALL_GUILDS);
    await addMockMember(STORM_GUILD, STORM_DISCORD_ID, "storm-student");
    await clearCalls();
    await drainQueue();
    await breakers().delete().in("key", ALL_GUILDS);
    await asyncErrors().delete().in("guild_id", ALL_GUILDS);

    // The threshold is 10 failures in 5 minutes; 12 leaves room for the breaker to open before the
    // last of them and defer it, which is the behaviour under test rather than a problem.
    const ATTEMPTS = 12;
    for (let i = 0; i < ATTEMPTS; i += 1) {
      await enqueueRoleSync(stormStudent.user_id, stormClassId);
    }

    const opened = await driveWorker(async () => {
      const { data } = await breakers()
        .select("scope, key, state, open_until, trip_count, last_reason")
        .eq("key", STORM_GUILD);
      return (data ?? []).some((row) => row.state === "open");
    }, 90_000);
    expect(opened, "the storming guild's circuit never opened").toBe(true);

    const { data: stormBreaker } = await breakers()
      .select("scope, key, state, open_until, trip_count, last_reason")
      .eq("key", STORM_GUILD);
    const breaker = (stormBreaker ?? [])[0];
    expect(breaker).toBeTruthy();
    expect(breaker.scope).toBe("guild");
    expect(breaker.state).toBe("open");
    expect(Number(breaker.trip_count)).toBeGreaterThanOrEqual(1);
    // Parked into the future, not merely marked open.
    expect(new Date(String(breaker.open_until)).getTime()).toBeGreaterThan(Date.now());
    expect(String(breaker.last_reason)).toMatch(/permission error/i);

    // The failures that tripped it were logged against the guild, which is what the threshold counts.
    const { data: errorRows } = await asyncErrors().select("guild_id, method, error_data").eq("guild_id", STORM_GUILD);
    expect((errorRows ?? []).length).toBeGreaterThanOrEqual(10);
    expect((errorRows ?? []).every((row) => row.method === "add_member_role")).toBe(true);

    // Confirmed against the RPC the worker itself consults, not only against the table.
    const { data: circuit, error: circuitError } = await untypedRpc<Array<{ state: string; open_until: string }>>(
      supabase,
      "get_discord_circuit",
      { p_scope: "guild", p_key: STORM_GUILD }
    );
    expect(circuitError).toBeNull();
    expect((circuit ?? [])[0]?.state).toBe("open");

    // THE SCOPING PROPERTY. A guild-keyed breaker is the whole point: one misconfigured server must
    // not stop every other course's Discord work, which is what a global breaker would do.
    for (const other of [SYNC_GUILD, RECON_GUILD]) {
      const { data: otherRows } = await breakers().select("key, state").eq("key", other);
      expect(
        (otherRows ?? []).filter((row) => row.state === "open"),
        `guild ${other} should not have been parked by ${STORM_GUILD}'s storm`
      ).toHaveLength(0);
      const { data: otherCircuit } = await untypedRpc<Array<{ state: string }>>(supabase, "get_discord_circuit", {
        p_scope: "guild",
        p_key: other
      });
      expect((otherCircuit ?? []).some((row) => row.state === "open")).toBe(false);
    }

    // And the errors were charged to the storming guild alone.
    const { data: otherErrors } = await asyncErrors().select("guild_id").eq("guild_id", SYNC_GUILD);
    expect(otherErrors ?? []).toHaveLength(0);

    // The refusals really came from Discord, with the code that cannot be told apart from a missing
    // permission -- the reason the installation check preflights the hierarchy instead of reading it
    // off an error.
    const refusals = (await getCalls()).filter(
      (call) => call.method === "PUT" && call.path.startsWith(`/guilds/${STORM_GUILD}/members/`)
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((call) => call.status === 403 && call.code === 50013)).toBe(true);
  });

  test("work for a parked guild is deferred without touching Discord, while other guilds are served", async () => {
    // The payoff: with the breaker open, the next envelope for that guild costs no Discord request at
    // all. That is the budget the breaker exists to protect.
    //
    // Asserted with a control in the SAME worker run, because "no requests for the parked guild" is
    // also what a worker that never ran would produce. The unparked guild's envelope is the evidence
    // that the run happened and discriminated between them.
    await clearCalls();
    await drainQueue();
    await enqueueRoleSync(stormStudent.user_id, stormClassId);
    await enqueueRoleSync(reconStudent.user_id, reconClassId);

    const served = await driveWorker(async () => {
      const calls = await getCalls();
      return calls.some((call) => call.path.includes(RECON_GUILD));
    }, 30_000);
    expect(served, `the control envelope for ${RECON_GUILD} was never processed`).toBe(true);

    const stormCalls = (await getCalls()).filter((call) => call.path.includes(STORM_GUILD));
    expect(stormCalls, `parked guild ${STORM_GUILD} should have received no requests`).toHaveLength(0);
  });
});
