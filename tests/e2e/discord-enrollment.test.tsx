import { expect, test } from "@playwright/test";
import { createClass, createUserInClass, getTestRunPrefix, supabase } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import { clearCalls, getCalls, getState, setState, waitForCall } from "@/tests/mocks/discord/client";
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
  readQueue,
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
  /** Its own guild, because the invite-fallback test applies a scenario with denied channel overwrites. */
  const INVITE_GUILD = randomGuildId();
  /**
   * The guild the revocation test releases. Its own, because releasing it is the whole point and a
   * disconnected class would break every other section's fixtures.
   */
  const REVOKE_GUILD = randomGuildId();
  /**
   * A guild the revoke class is never connected to and the mock is never given, standing in for one
   * the class left in an earlier move. Its invite is the already-gone case: Discord answers
   * `404 / 10006 Unknown Invite` for a code it does not have, which must count as success rather than
   * dead-letter, because a released invite that somebody already deleted is the common case.
   */
  const REVOKE_OLD_GUILD = randomGuildId();
  /** The guilds the mock is given. Deliberately excludes GONE_GUILD -- see below. */
  const ALL_GUILDS = [SYNC_GUILD, RECON_GUILD, STORM_GUILD, INVITE_GUILD, REVOKE_GUILD];
  /**
   * A guild id the mock is NEVER given, so every guild route for it answers 404 / 10004 Unknown
   * Guild -- what Discord says about a server the bot has been removed from, a server that has been
   * deleted, and a discord_server_id that was always wrong. Kept out of ALL_GUILDS because
   * applyScenarioForGuilds() creates the ids it is handed, which would defeat the whole fixture.
   */
  const GONE_GUILD = randomGuildId();
  /** Every guild this spec leaves state under, for cleanup. ALL_GUILDS is the mock-backed subset. */
  const TOUCHED_GUILDS = [...ALL_GUILDS, GONE_GUILD, REVOKE_OLD_GUILD];

  // Distinct per user: lookupUserIdByDiscordId() uses `.single()`, so two platform users sharing a
  // Discord id would make the worker's reverse lookup fail rather than pick one.
  const SYNC_DISCORD_ID = randomDiscordUserId();
  const RECON_DISCORD_ID = randomDiscordUserId();
  const STORM_DISCORD_ID = randomDiscordUserId();
  const INVITE_DISCORD_ID = randomDiscordUserId();
  const GONE_DISCORD_ID = randomDiscordUserId();
  const REVOKE_DISCORD_ID = randomDiscordUserId();

  let syncClassId: number;
  let reconClassId: number;
  let stormClassId: number;
  let inviteClassId: number;
  let goneClassId: number;
  let revokeClassId: number;
  let syncStudent: TestingUser;
  let reconStudent: TestingUser;
  let stormStudent: TestingUser;
  let inviteStudent: TestingUser;
  let goneStudent: TestingUser;
  let revokeStudent: TestingUser;
  let revokeInstructor: TestingUser;
  let mockUp = false;

  const membership = () => untypedTable(supabase, "discord_membership_status");
  const breakers = () => untypedTable(supabase, "discord_circuit_breakers");
  const asyncErrors = () => untypedTable(supabase, "discord_async_errors");
  const channelsTable = () => untypedTable(supabase, "discord_channels");

  /** Point a class at a guild and record the class roles the mock's snowflakes stand for. */
  async function connectClass(classId: number, guildId: string): Promise<void> {
    // Service role, because discord_server_id is written only by
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
    // Type-erased for `last_reconciled_at`, which lands with the Discord install-flow migration; SupabaseTypes.d.ts
    // is regenerated centrally once all of this branch's migrations are in, so the column is not in the
    // typed column union yet. Same escape hatch the branch uses for its not-yet-generated RPCs.
    const query = membership() as unknown as {
      select: (columns: string) => {
        eq: (
          column: string,
          value: number
        ) => Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>;
      };
    };
    const { data, error } = await query
      .select(
        "class_id, user_id, guild_id, state, detail, last_observed_at, last_retry_requested_at, last_reconciled_at"
      )
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

    const inviteClass = await createClass({ name: `E2E DiscordEnroll Invite ${RUN_PREFIX}` });
    inviteClassId = inviteClass.id;
    inviteStudent = await createUserInClass({
      role: "student",
      class_id: inviteClassId,
      name: `DiscordEnroll Invite ${RUN_PREFIX}`,
      email: `e2e-denroll-invite-${SAFE_ID}@pawtograder.net`
    });

    const revokeClass = await createClass({ name: `E2E DiscordEnroll Revoke ${RUN_PREFIX}` });
    revokeClassId = revokeClass.id;
    revokeStudent = await createUserInClass({
      role: "student",
      class_id: revokeClassId,
      name: `DiscordEnroll Revoke ${RUN_PREFIX}`,
      email: `e2e-denroll-revoke-${SAFE_ID}@pawtograder.net`
    });
    // An instructor, because disconnect_discord_guild() authorizes on the acting user rather than on
    // the service role: the point of driving the real RPC is that the teardown reached here the way
    // an instructor pressing Disconnect reaches it.
    revokeInstructor = await createUserInClass({
      role: "instructor",
      class_id: revokeClassId,
      name: `DiscordEnroll Revoke Staff ${RUN_PREFIX}`,
      email: `e2e-denroll-revoke-staff-${SAFE_ID}@pawtograder.net`
    });

    const goneClass = await createClass({ name: `E2E DiscordEnroll Gone ${RUN_PREFIX}` });
    goneClassId = goneClass.id;
    goneStudent = await createUserInClass({
      role: "student",
      class_id: goneClassId,
      name: `DiscordEnroll Gone ${RUN_PREFIX}`,
      email: `e2e-denroll-gone-${SAFE_ID}@pawtograder.net`
    });

    await connectClass(syncClassId, SYNC_GUILD);
    await connectClass(reconClassId, RECON_GUILD);
    await connectClass(stormClassId, STORM_GUILD);
    await connectClass(goneClassId, GONE_GUILD);

    await connectClass(inviteClassId, INVITE_GUILD);
    await connectClass(revokeClassId, REVOKE_GUILD);
    // Linked but deliberately NOT a member of REVOKE_GUILD: the invite this test revokes has to be
    // minted by the real path, and add_member_role only mints one for a student who is absent.
    await linkDiscord(revokeStudent, REVOKE_DISCORD_ID);
    // Deliberately NOT added to the mock guild: ensureInviteForUser only runs for a student the
    // membership check reports as absent.
    await linkDiscord(inviteStudent, INVITE_DISCORD_ID);
    await linkDiscord(syncStudent, SYNC_DISCORD_ID);
    await linkDiscord(reconStudent, RECON_DISCORD_ID);
    await linkDiscord(stormStudent, STORM_DISCORD_ID);
    // Not added to any mock guild: the unknown-guild test needs the membership lookup to miss, and
    // GONE_GUILD does not exist in the mock for it to be added to.
    await linkDiscord(goneStudent, GONE_DISCORD_ID);
    // The unknown-guild storm happens on the invite call, which is only reached for a course that
    // has opted in to student invitations. Set here rather than in the test so the fixture is one
    // statement away from connectClass, which is what makes the storm reproducible.
    const { error: goneFeatureError } = await supabase
      .from("classes")
      .update({ features: [{ name: "discord-student-join", enabled: true }] })
      .eq("id", goneClassId);
    expect(goneFeatureError, "enabling student Discord invitations for the unknown-guild class").toBeNull();

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
    const mine = new Set(TOUCHED_GUILDS);
    const myClasses = new Set([syncClassId, reconClassId, stormClassId, inviteClassId, goneClassId, revokeClassId]);
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
    await breakers().delete().in("key", TOUCHED_GUILDS);
    await asyncErrors().delete().in("guild_id", TOUCHED_GUILDS);
    for (const classId of [syncClassId, reconClassId, stormClassId, inviteClassId, goneClassId, revokeClassId]) {
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

    // The row is stamped, so the next pass does not pile a second copy on top of this one -- but on
    // last_reconciled_at, the reconciler's OWN throttle.
    const row = await membershipRow(reconClassId, reconStudent.user_id);
    expect(row?.last_reconciled_at).toBeTruthy();

    // And it leaves the instructor's Re-invite throttle alone. This is the regression the separate
    // column exists for: the reconciler fires at minutes 7, 22, 37 and 52, and while it was stamping
    // last_retry_requested_at, request_discord_reinvite() skipped these students for the next five
    // minutes and components/discord/reinvite-button.tsx rendered the button as already-just-used --
    // on exactly the stuck students an instructor opens the roster to retry.
    expect(row?.last_retry_requested_at, "the reconciler must not spend the instructor's retry throttle").toBeNull();
  });

  test("a second reconciler pass does not re-enqueue the same user", async () => {
    // last_reconciled_at is inside the same window now, so this candidate is being handled and must be
    // left alone. Without that guard the reconciler would quadruple the hourly sync's Discord calls,
    // which is worse than the failure it repairs -- and an envelope that dead-letters would come back
    // on every pass forever, because nothing else updates last_observed_at for it.
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

    // try/finally, because everything from here to the restore can throw. A failed assertion -- or a
    // reconciler call that rejects -- used to skip the re-enable and leave reconStudent disabled with
    // its stuck membership row still present, so every later spec in this file ran against a fixture
    // it did not expect. That turns one real failure into a cascade of unrelated ones, which is the
    // expensive kind: the first failure is the only true one and it is no longer the obvious one.
    try {
      const withDropped = await invokeEdgeFunction("discord-reconciler");
      const droppedCount = (withDropped.body as { long_stuck_users?: number }).long_stuck_users ?? 0;
      expect(droppedCount, "a dropped student must not be counted as a live failure").toBe(activeCount - 1);
    } finally {
      // Put the enrollment back so later tests in this file see the fixture they expect.
      await supabase
        .from("user_roles")
        .update({ disabled: false })
        .eq("class_id", reconClassId)
        .eq("user_id", reconStudent.user_id);
      await membership().delete().eq("class_id", reconClassId);
    }
  });

  test("an invite falls back to the next channel when the first refuses it", async () => {
    // The defect this covers: createGuildInvite used to take the FIRST visible text channel and give
    // up if the POST failed. Discord layers per-channel overwrites on top of guild-level permissions,
    // and GET /guilds/{id}/channels only hides channels the bot cannot SEE -- a channel that denies
    // only CREATE_INSTANT_INVITE stays in the list and is a trap. Since invites are the enrollment
    // mechanism (add_guild_member was removed from this branch, so students join by clicking a link),
    // one restrictive channel meant nobody in the course could be invited.
    //
    // The `channel-invite-denied` scenario is built for exactly this: guild-level permissions are
    // complete, #general denies Create Invite by overwrite, and a second text channel allows it.
    await applyScenarioForGuilds("channel-invite-denied", [INVITE_GUILD]);

    // The student must be linked, NOT in the guild, and the course must allow student invitations --
    // ensureInviteForUser returns "not_offered" without the feature flag and never reaches Discord.
    const { error: featureError } = await supabase
      .from("classes")
      .update({ features: [{ name: "discord-student-join", enabled: true }] })
      .eq("id", inviteClassId);
    expect(featureError, "enabling student Discord invitations").toBeNull();

    await drainQueue();
    await clearCalls();
    await enqueueRoleSync(inviteStudent.user_id, inviteClassId);
    const response = await invokeEdgeFunction("discord-async-worker");
    expect(response.status).toBe(200);

    // The invite exists, which is the outcome that matters.
    let invite: unknown = null;
    for (let attempt = 0; attempt < 30 && !invite; attempt += 1) {
      const invites = Object.values((await getState()).invites ?? {});
      invite = invites.find((candidate) => candidate.guild_id === INVITE_GUILD) ?? null;
      if (!invite) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(invite, `no invite was created in ${INVITE_GUILD}`).toBeTruthy();

    // And the route it took, which is what distinguishes a fallback from the first channel simply
    // having worked. Both POSTs must be present: a refusal followed by a success.
    const invitePosts = (await getCalls()).filter(
      (call) => call.method === "POST" && /^\/channels\/\d+\/invites$/.test(call.path)
    );
    expect(invitePosts.length, "expected a refused attempt and then a successful one").toBeGreaterThanOrEqual(2);
    expect(invitePosts.some((call) => call.status === 403 && call.code === 50013)).toBe(true);
    expect(invitePosts.some((call) => call.status === 200 || call.status === 201)).toBe(true);
    // The successful one is not the channel that refused.
    const refused = invitePosts.find((call) => call.status === 403)?.path;
    const succeeded = invitePosts.find((call) => call.status === 200 || call.status === 201)?.path;
    expect(succeeded).not.toBe(refused);

    // The student is recorded as invited rather than cannot_invite -- the whole point of the fallback.
    const row = await membershipRow(inviteClassId, inviteStudent.user_id);
    expect(row?.state, "a successful fallback must not record cannot_invite").not.toBe("cannot_invite");

    await supabase.from("classes").update({ features: null }).eq("id", inviteClassId);
  });

  test("releasing a guild revokes the class's outstanding invites at Discord", async () => {
    // The hole this closes. clear_discord_tracking_for_class() dropped every POINTER a class held
    // into its guild -- roles, channels, messages, the discussion-topic channel id -- and left the one
    // row that is not a pointer but a live capability: discord_invites. Invites are minted with
    // max_age = 604800 and max_uses = 5, and the uniqueness index on classes.discord_server_id is
    // partial on `archived = false`, so the released guild is claimable by another course the instant
    // the release commits. For up to seven days after that, a former student of this course could
    // follow their old link into somebody else's server. components/discord/pending-invites.tsx
    // filters to invites whose guild_id still matches the class's server, so the rows became
    // invisible at exactly the moment they became dangerous.
    //
    // Asserted at BOTH ends, because either half alone passes for the wrong reason: a queue-only
    // assertion passes against a worker that cannot handle the method, and a call-log-only assertion
    // cannot tell a revocation from the mint that preceded it. So: the envelope is on the queue, and
    // the worker really issues `DELETE /invites/{code}` for it.
    await applyScenarioForGuilds("healthy", ALL_GUILDS);
    await drainQueue();

    // 1. A real invite, minted by the real path -- not seeded. The code has to exist in Discord for
    //    the revocation to be observable as anything other than a 404.
    const { error: featureError } = await supabase
      .from("classes")
      .update({ features: [{ name: "discord-student-join", enabled: true }] })
      .eq("id", revokeClassId);
    expect(featureError, "enabling student Discord invitations for the revoke class").toBeNull();

    await enqueueRoleSync(revokeStudent.user_id, revokeClassId);
    const minted = await driveWorker(async () => {
      const { data } = await supabase
        .from("discord_invites")
        .select("invite_code")
        .eq("class_id", revokeClassId)
        .eq("guild_id", REVOKE_GUILD);
      return (data ?? []).length > 0;
    }, 60_000);
    expect(minted, "the worker never minted an invite, so there is nothing to revoke").toBe(true);

    const { data: mintedRows, error: mintedError } = await supabase
      .from("discord_invites")
      .select("invite_code")
      .eq("class_id", revokeClassId)
      .eq("guild_id", REVOKE_GUILD);
    expect(mintedError).toBeNull();
    const liveCode = (mintedRows ?? [])[0]?.invite_code as string;
    expect(liveCode, "no invite_code was stored for the minted invite").toBeTruthy();
    // It is really live in Discord, which is what makes the DELETE below meaningful.
    expect(
      Object.values((await getState()).invites ?? {}).some((invite) => invite.code === liveCode),
      `the mock does not hold invite ${liveCode}, so revoking it would prove nothing`
    ).toBe(true);

    // 2. A second live invite whose row is marked `used`. `used` is our own bookkeeping --
    //    mark_discord_invite_used sets it when the intended student turns up -- and it says nothing
    //    about Discord's counter, which allows five. A teardown that skipped used rows would leave
    //    four uses of a live link into a guild another course may already own.
    const usedCode = `e2eused${SAFE_ID}`.slice(0, 16);
    const revokeGuildChannels = ((await getState()).guilds[REVOKE_GUILD]?.channels ?? []).filter(
      (channel) => channel.type === 0
    );
    expect(revokeGuildChannels.length, "the healthy scenario should give REVOKE_GUILD a text channel").toBeGreaterThan(
      0
    );
    await setState({
      invites: {
        [usedCode]: {
          code: usedCode,
          guild_id: REVOKE_GUILD,
          channel_id: revokeGuildChannels[0].id,
          max_age: 604800,
          max_uses: 5,
          uses: 1,
          created_at: new Date().toISOString()
        }
      }
    });
    const { error: usedInsertError } = await supabase.from("discord_invites").insert({
      user_id: revokeInstructor.user_id,
      class_id: revokeClassId,
      guild_id: REVOKE_GUILD,
      invite_code: usedCode,
      invite_url: `https://discord.gg/${usedCode}`,
      expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      used: true
    });
    expect(usedInsertError, "seeding a used-but-live invite").toBeNull();

    // 3. A row for a guild from an earlier move whose code Discord no longer has. Discord answers
    //    404 / 10006 Unknown Invite, and revokeInvite() reads that as success -- it is the state the
    //    request was trying to reach. It must not dead-letter, or every teardown after somebody tidied
    //    up by hand becomes a DLQ row and an alert.
    const goneCode = `e2egone${SAFE_ID}`.slice(0, 16);
    const { error: goneInsertError } = await supabase.from("discord_invites").insert({
      user_id: revokeStudent.user_id,
      class_id: revokeClassId,
      guild_id: REVOKE_OLD_GUILD,
      invite_code: goneCode,
      invite_url: `https://discord.gg/${goneCode}`,
      expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      used: false
    });
    expect(goneInsertError, "seeding an invite Discord no longer has").toBeNull();

    // 4. An already-expired row, which is skipped: Discord invalidated it when max_age elapsed, so a
    //    DELETE would spend a request on a guaranteed 404. The row still goes, because a row naming a
    //    guild the class has left would suppress the replacement invite for that user.
    const expiredCode = `e2eexpd${SAFE_ID}`.slice(0, 16);
    const { error: expiredInsertError } = await supabase.from("discord_invites").insert({
      user_id: revokeInstructor.user_id,
      class_id: revokeClassId,
      guild_id: REVOKE_OLD_GUILD,
      invite_code: expiredCode,
      invite_url: `https://discord.gg/${expiredCode}`,
      expires_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      used: false
    });
    expect(expiredInsertError, "seeding an expired invite").toBeNull();

    // From here the call log contains only teardown traffic, so a DELETE in it cannot be mistaken for
    // part of the mint above.
    await drainQueue();
    await clearCalls();

    // The disconnect itself, through the RPC an instructor's Disconnect button calls. Its BEFORE
    // trigger is what runs clear_discord_tracking_for_class.
    const { error: disconnectError } = await untypedRpc(supabase, "disconnect_discord_guild", {
      p_class_id: revokeClassId,
      p_actor: revokeInstructor.user_id
    });
    expect(disconnectError, "disconnect_discord_guild failed").toBeNull();

    // The revocations are enqueued by the same transaction, so they are on the queue before the
    // worker is poked at all.
    const codeOf = (row: { message?: { args?: Record<string, unknown> } }) =>
      String((row.message?.args as { invite_code?: string } | undefined)?.invite_code ?? "");
    const isRevocationFor =
      (code: string) => (row: { message?: { method?: string; args?: Record<string, unknown> } }) =>
        row.message?.method === "delete_invite" && codeOf(row) === code;

    for (const code of [liveCode, usedCode, goneCode]) {
      expect(
        await waitForQueueMessage(isRevocationFor(code), 15_000),
        `no delete_invite was enqueued for outstanding invite ${code}`
      ).not.toBeNull();
    }
    expect(
      (await readQueue(DISCORD_QUEUE, 1, 100)).filter(isRevocationFor(expiredCode)),
      "an invite Discord had already expired does not need a Discord call"
    ).toHaveLength(0);

    // And the rows are gone, in the same transaction as the sends.
    const { data: remainingRows, error: remainingError } = await supabase
      .from("discord_invites")
      .select("invite_code")
      .eq("class_id", revokeClassId);
    expect(remainingError).toBeNull();
    expect(
      (remainingRows ?? []).map((row) => row.invite_code),
      "the teardown left discord_invites rows behind"
    ).toEqual([]);

    // 5. The half that matters: the worker actually calls Discord.
    const pathFor = (code: string) => `/invites/${code}`;
    const revoked = await driveWorker(async () => {
      const calls = await getCalls();
      return [liveCode, usedCode, goneCode].every((code) =>
        calls.some((call) => call.method === "DELETE" && call.path === pathFor(code))
      );
    }, 60_000);
    expect(revoked, "the worker never issued DELETE /invites/{code} for the released invites").toBe(true);

    const calls = await getCalls();
    const deleteFor = (code: string) => calls.find((call) => call.method === "DELETE" && call.path === pathFor(code));
    expect(deleteFor(liveCode)?.status, `DELETE ${pathFor(liveCode)} should have succeeded`).toBe(200);
    expect(deleteFor(usedCode)?.status, "a used invite still has uses left and must be revoked").toBe(200);
    // The already-gone one is attempted and answered 404 / 10006, which is the success case.
    expect(deleteFor(goneCode)?.status).toBe(404);
    expect(deleteFor(goneCode)?.code).toBe(10006);
    expect(
      calls.some((call) => call.method === "DELETE" && call.path === pathFor(expiredCode)),
      "an expired invite must not cost a Discord request"
    ).toBe(false);

    // Neither invite is live in Discord any more, which is the actual outcome under test.
    const liveAfter = Object.values((await getState()).invites ?? {}).map((invite) => invite.code);
    expect(liveAfter, `${liveCode} is still a working invite into ${REVOKE_GUILD}`).not.toContain(liveCode);
    expect(liveAfter, `${usedCode} is still a working invite into ${REVOKE_GUILD}`).not.toContain(usedCode);

    // Resolved cleanly. A 404 that dead-lettered would turn every tidy-up into an alert, and a
    // requeued revocation would come back on every visibility timeout.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const isMineRevocation = (row: { message?: { method?: string; args?: Record<string, unknown> } }) =>
      row.message?.method === "delete_invite" && [liveCode, usedCode, goneCode].includes(codeOf(row));
    expect(
      (await readQueue(DISCORD_QUEUE, 1, 100)).filter(isMineRevocation),
      "a revocation was requeued instead of archived"
    ).toHaveLength(0);
    expect(
      (await readQueue(DISCORD_DLQ, 1, 100)).filter(isMineRevocation),
      "a revocation was dead-lettered -- a 404 Unknown Invite is the success case, not a failure"
    ).toHaveLength(0);

    await supabase.from("classes").update({ features: null }).eq("id", revokeClassId);
  });

  test("create_channel for a guild the class has left creates nothing there", async () => {
    // create_role and add_member_role both re-read classes.discord_server_id and drop an envelope
    // that names a different guild. create_channel did not, and it is the one method that is
    // enqueued automatically the instant a server is connected -- trigger_discord_create_roles_on_
    // server_connect queues #scheduling and #operations -- so it is the most likely of the three to
    // still be in flight when the class moves. Applied against the old guild it puts a channel named
    // after this course inside a server the course has left, and archiving releases a guild for
    // another class to claim immediately (the uniqueness index is partial on archived = false), so
    // that server may already belong to somebody else.
    //
    // Asserted with a control in the SAME worker run: "no channel in the old guild" is also what a
    // worker that never ran would produce, and the control is the evidence that it ran and
    // discriminated.
    await applyScenarioForGuilds("healthy", ALL_GUILDS);
    await drainQueue();
    await clearCalls();
    // So the tracking-row count below is unambiguous. connectClass() in beforeAll enqueued channel
    // work for this class, which the beforeAll drain removed before it could run, but a local stack
    // can carry rows from an earlier run.
    await supabase.from("discord_channels").delete().eq("class_id", syncClassId);

    const staleName = `e2e-stale-${SAFE_ID}`;
    const currentName = `e2e-current-${SAFE_ID}`;

    // The superseded envelope. syncClassId is on SYNC_GUILD; this one names INVITE_GUILD, which is
    // exactly the shape an envelope minted before a move has. INVITE_GUILD rather than STORM_GUILD
    // because the storm test parks STORM_GUILD's breaker, and a parked guild's envelope is DEFERRED
    // before the handler is reached -- which would pass this test for the wrong reason.
    const { error: staleError } = await untypedRpc(supabase, "enqueue_discord_channel_creation", {
      p_class_id: syncClassId,
      p_channel_type: "scheduling",
      p_resource_id: null,
      p_channel_name: staleName,
      p_guild_id: INVITE_GUILD
    });
    expect(staleError, "enqueueing the superseded create_channel").toBeNull();

    const { error: currentError } = await untypedRpc(supabase, "enqueue_discord_channel_creation", {
      p_class_id: syncClassId,
      p_channel_type: "operations",
      p_resource_id: null,
      p_channel_name: currentName,
      p_guild_id: SYNC_GUILD
    });
    expect(currentError, "enqueueing the control create_channel").toBeNull();

    const served = await driveWorker(async () => {
      const calls = await getCalls();
      return calls.some((call) => call.method === "POST" && call.path === `/guilds/${SYNC_GUILD}/channels`);
    }, 45_000);
    expect(served, "the control create_channel never reached Discord, so this test proves nothing").toBe(true);

    const staleCreates = (await getCalls()).filter(
      (call) => call.method === "POST" && call.path === `/guilds/${INVITE_GUILD}/channels`
    );
    expect(
      staleCreates,
      `a create_channel naming ${INVITE_GUILD} must not reach Discord for a class on ${SYNC_GUILD}`
    ).toHaveLength(0);
    expect(
      Object.values((await getState()).guilds[INVITE_GUILD]?.channels ?? []).some((c) => c.name === staleName)
    ).toBe(false);

    // Only the control is tracked. A discord_channels row for the stale channel would be worse than
    // the stray channel itself: later syncs would route this course's messages into the other guild.
    const { data: tracked, error: trackedError } = await supabase
      .from("discord_channels")
      .select("discord_channel_id, channel_type")
      .eq("class_id", syncClassId);
    expect(trackedError).toBeNull();
    expect((tracked ?? []).map((row) => row.channel_type)).toEqual(["operations"]);

    // Resolved cleanly, which is the other half of the fix: stale work is not an error, so it is
    // archived rather than requeued (it would come back every visibility timeout) or dead-lettered
    // (it would show up as a failure that needs investigating).
    const isStale = (row: { message?: { method?: string; args?: Record<string, unknown> } }) =>
      row.message?.method === "create_channel" &&
      (row.message.args as { name?: string } | undefined)?.name === staleName;
    expect(
      (await readQueue(DISCORD_QUEUE, 1, 100)).filter(isStale),
      "the superseded envelope was requeued instead of archived"
    ).toHaveLength(0);
    expect(
      (await readQueue(DISCORD_DLQ, 1, 100)).filter(isStale),
      "stale work was dead-lettered as a failure"
    ).toHaveLength(0);
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

  test("a notification is not parked by a circuit opened for a ROLE failure", async () => {
    // The scoping the breaker did NOT have. STORM_GUILD is parked by the two tests above, and it was
    // parked for 403/50013 on add_member_role -- a role-hierarchy or Manage Roles problem, which is
    // exactly what discord-check-bot-installation exists to diagnose.
    //
    // Before CIRCUIT_GATED_METHODS the breaker gated EVERY guild-scoped envelope, so that role failure
    // also parked the class's send_message and update_message work: help requests, regrade requests
    // and discussion notifications. They are per-event rather than per-enrollment, so they were never
    // the fan-out the breaker protects the shared token from -- and after MAX_CIRCUIT_DEFERRALS windows
    // they DEAD-LETTER. A student's help request silently never reached Discord because of an unrelated
    // role position in the server settings, and nothing in the product said so.
    const { data: openRows } = await breakers().select("key, state, open_until").eq("key", STORM_GUILD);
    const stillOpen = (openRows ?? []).some(
      (row) => row.state === "open" && (!row.open_until || new Date(String(row.open_until)).getTime() > Date.now())
    );
    // Guarded, because "the notification went through" is also what a CLOSED breaker produces. Without
    // this the test would keep passing after a regression that simply never opened the circuit.
    expect(stillOpen, `${STORM_GUILD}'s breaker must still be open for this test to mean anything`).toBe(true);

    // A tracked text channel in the parked guild. Tracked matters: send_message's own preflight drops
    // an envelope for a channel the class no longer tracks, so an untracked one would be dropped for
    // the wrong reason and the assertion below would fail without telling us why.
    const mockState = (await getState()) as unknown as {
      guilds?: Record<string, { channels?: Array<{ id: string; type: number }> }>;
    };
    const textChannel = (mockState.guilds?.[STORM_GUILD]?.channels ?? []).find((channel) => channel.type === 0);
    expect(textChannel, `mock guild ${STORM_GUILD} has no text channel to post into`).toBeTruthy();
    const channelId = String(textChannel?.id);

    await channelsTable().delete().eq("class_id", stormClassId);
    const { error: channelError } = await channelsTable().insert({
      class_id: stormClassId,
      discord_channel_id: channelId,
      channel_type: "operations",
      resource_id: null
    });
    expect(channelError, "seeding a tracked channel").toBeNull();

    await clearCalls();
    await drainQueue();

    const { error: sendError } = await supabase.schema("pgmq_public").rpc("send", {
      queue_name: "discord_async_calls",
      message: {
        method: "send_message",
        class_id: stormClassId,
        args: { channel_id: channelId, content: "e2e: a help request notification" }
      },
      sleep_seconds: 0
    } as never);
    expect(sendError, "enqueueing a send_message envelope").toBeNull();

    const delivered = await driveWorker(async () => {
      const calls = await getCalls();
      return calls.some((call) => call.method === "POST" && call.path === `/channels/${channelId}/messages`);
    }, 45_000);
    expect(delivered, "a notification was withheld from a guild parked for a role failure").toBe(true);

    // And it was never charged a deferral, which is the mechanism that would have dead-lettered it.
    const remaining = await readQueue();
    const deferrals = remaining.filter(
      (row) =>
        row.message?.method === "send_message" &&
        Boolean((row.message as { circuit_deferrals?: number }).circuit_deferrals)
    );
    expect(deferrals, "send_message was charged a circuit deferral").toHaveLength(0);

    await channelsTable().delete().eq("class_id", stormClassId);
    await drainQueue();
  });

  test("a discussion notification survives even though its channel is not in discord_channels", async () => {
    // The other channel source, and the reason the message preflight cannot simply ask "is this channel
    // tracked". discussion_topics.discord_channel_id is a free-text field an instructor types on the
    // discussion-topics settings page (see createTopicModal); nothing writes it into discord_channels
    // and nothing clears it. So a discussion notification's channel is routinely absent from the
    // tracking table, and a preflight keyed on tracking alone would silently stop every discussion
    // notification on the platform while looking like a safety improvement.
    //
    // RECON_GUILD, not STORM_GUILD: this is about the channel source, and running it against a parked
    // guild would tangle it with the breaker-scope property the previous test covers.
    const mockState = (await getState()) as unknown as {
      guilds?: Record<string, { channels?: Array<{ id: string; type: number }> }>;
    };
    const textChannel = (mockState.guilds?.[RECON_GUILD]?.channels ?? []).find((channel) => channel.type === 0);
    expect(textChannel, `mock guild ${RECON_GUILD} has no text channel to post into`).toBeTruthy();
    const channelId = String(textChannel?.id);

    // Deliberately NOT tracked: the whole point is that discord_channels does not know this channel.
    await channelsTable().delete().eq("class_id", reconClassId);
    // Idempotent setup. The cleanup at the end of this test does not run when an assertion fails, and a
    // leaked topic row makes the NEXT run fail on the insert instead of on the behaviour -- which reads
    // as a different bug entirely.
    const topicName = `${getTestRunPrefix()}-discord-topic`;
    await supabase.from("discussion_topics").delete().eq("class_id", reconClassId).eq("topic", topicName);
    const { data: topicRow, error: topicError } = await supabase
      .from("discussion_topics")
      .insert({
        class_id: reconClassId,
        topic: topicName,
        description: "e2e: a topic whose Discord channel the instructor typed in",
        color: "#336699",
        discord_channel_id: channelId
      })
      .select("id")
      .single();
    expect(topicError, "seeding a discussion topic").toBeNull();

    await clearCalls();
    await drainQueue();

    const { error: sendError } = await supabase.schema("pgmq_public").rpc("send", {
      queue_name: "discord_async_calls",
      message: {
        method: "send_message",
        class_id: reconClassId,
        args: { channel_id: channelId, content: "e2e: a discussion notification" }
      },
      sleep_seconds: 0
    } as never);
    expect(sendError, "enqueueing a send_message envelope").toBeNull();

    const delivered = await driveWorker(async () => {
      const calls = await getCalls();
      return calls.some((call) => call.method === "POST" && call.path === `/channels/${channelId}/messages`);
    }, 45_000);
    expect(delivered, "a discussion notification was dropped because its channel is not tracked").toBe(true);

    if (topicRow?.id) await supabase.from("discussion_topics").delete().eq("id", topicRow.id);
    await drainQueue();
  });

  test("a guild Discord does not have opens the breaker too, not just a permission storm", async () => {
    // The gap this closes. isBotPermissionProblem() -- which the worker used to gate its breaker
    // accounting on -- answers true for 50001, 50013, the empty-guild message and HTTP 403. Discord
    // reports 10004 Unknown Guild as a 404, so it fell outside that predicate while sitting INSIDE
    // TERMINAL_DISCORD_ERROR_CODES. The combination was the worst of both: a bot removed from a
    // configured server produced one immediate dead-letter per enrolled student and counted toward
    // nothing, so the breaker built to stop exactly that storm never opened for the loudest version
    // of it. A 200-student course meant 200 requests against the token every course shares.
    //
    // GONE_GUILD is never given to the mock, so every guild route for it answers 404 / 10004 -- the
    // same thing Discord says when the bot is kicked, when the server is deleted, and when
    // discord_server_id was mistyped.
    await applyScenarioForGuilds("healthy", ALL_GUILDS);
    await clearCalls();
    await drainQueue();
    // Scoped to GONE_GUILD, NOT to TOUCHED_GUILDS: the breaker rows are shared state and the
    // deferral test above depends on STORM_GUILD's staying open, so a blanket delete here silently
    // unparks that guild and the deferral assertion then measures a worker with nothing to defer.
    await breakers().delete().eq("key", GONE_GUILD);
    await asyncErrors().delete().eq("guild_id", GONE_GUILD);

    // Same shape as the permission-storm test: the threshold is 10 in 5 minutes, 12 leaves room for
    // the breaker to open before the last of them.
    const ATTEMPTS = 12;
    for (let i = 0; i < ATTEMPTS; i += 1) {
      await enqueueRoleSync(goneStudent.user_id, goneClassId);
    }

    const opened = await driveWorker(async () => {
      const { data } = await breakers().select("key, state").eq("key", GONE_GUILD);
      return (data ?? []).some((row) => row.state === "open");
    }, 90_000);
    expect(opened, `an unknown-guild storm in ${GONE_GUILD} never opened its circuit`).toBe(true);

    const { data: goneBreaker } = await breakers()
      .select("scope, key, state, open_until, trip_count, last_reason")
      .eq("key", GONE_GUILD);
    const breaker = (goneBreaker ?? [])[0];
    expect(breaker).toBeTruthy();
    expect(breaker.scope).toBe("guild");
    expect(breaker.state).toBe("open");
    expect(new Date(String(breaker.open_until)).getTime()).toBeGreaterThan(Date.now());

    // The failures really were 10004, not some other 404 that happens to trip the same threshold.
    // This is the assertion that fails if the classification regresses: with the old predicate the
    // rows are absent entirely, because nothing counted them.
    const { data: errorRows } = await asyncErrors().select("guild_id, method, error_data").eq("guild_id", GONE_GUILD);
    expect((errorRows ?? []).length, "unknown-guild failures were not charged to the guild").toBeGreaterThanOrEqual(10);
    expect(
      (errorRows ?? []).some(
        (row) => Number((row.error_data as { discord_error_code?: number })?.discord_error_code) === 10004
      ),
      "expected at least one recorded failure to carry Discord code 10004"
    ).toBe(true);

    // The RPC the worker itself consults agrees, so the next envelope for this guild is deferred
    // rather than spending another round trip -- which is the whole point of counting these.
    const { data: circuit, error: circuitError } = await untypedRpc<Array<{ state: string }>>(
      supabase,
      "get_discord_circuit",
      { p_scope: "guild", p_key: GONE_GUILD }
    );
    expect(circuitError).toBeNull();
    expect((circuit ?? [])[0]?.state).toBe("open");

    // Still scoped. A wider predicate must not turn one dead server into a platform-wide park.
    for (const other of [SYNC_GUILD, RECON_GUILD]) {
      const { data: otherRows } = await breakers().select("key, state").eq("key", other);
      expect(
        (otherRows ?? []).filter((row) => row.state === "open"),
        `guild ${other} should not have been parked by ${GONE_GUILD}`
      ).toHaveLength(0);
    }

    // And the student is told what is actually wrong, which is a different sentence from a missing
    // permission -- the reason isBotPermissionProblem() was left alone rather than widened.
    const row = await membershipRow(goneClassId, goneStudent.user_id);
    expect(row?.state).toBe("cannot_invite");
  });
});
