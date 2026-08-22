import { expect, test } from "@playwright/test";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import { clearCalls, getCalls, setState } from "@/tests/mocks/discord/client";
// The mock rewrites channel ids when it clones a scenario's guild under this run's guild id (see
// cloneGuild in discordMockUtils), so the constants for #general and #announcements would name the
// TEMPLATE guild's channels, not this class's. The cloned ids are read out of the returned state by
// name instead, which is why only the type is imported here.
import type { MockState } from "@/tests/mocks/discord/state";
// The bit is read from the production module, not retyped: a deny of the wrong bit would make the
// fixture below pass for a reason that has nothing to do with Create Invite.
import { DISCORD_PERMISSION_BITS } from "@/supabase/functions/_shared/DiscordPermissions";
import {
  BOT_ROLE_ID,
  GRADER_ROLE_ID,
  INSTRUCTOR_ROLE_ID,
  STUDENT_ROLE_ID,
  applyScenarioForGuilds,
  discordApiIsMocked,
  discordMockReachable,
  DISCORD_DLQ,
  drainQueue,
  randomGuildId,
  releaseDiscordMockLock,
  takeDiscordMock,
  touchDiscordMockLock,
  untypedTable
} from "@/tests/e2e/discordMockUtils";

// E2E coverage for the `discord-check-bot-installation` edge function
// (supabase/functions/discord-check-bot-installation/index.ts) — the live install-check the Discord
// settings page runs before an instructor trusts that role sync will work.
//
// Request:  { class_id }
// Response: { installed, guild_id, guild_name, missing_permissions, can_manage_class_roles,
//             bot_role_position, highest_class_role_position, stale_class_role_ids,
//             channel_permission_problems, missing_tracked_channel_ids, can_create_invites,
//             install_url }
// Authz:    caller must be an instructor in `class_id`.
//
// UNLIKE its GitHub twin (tests/e2e/github-check-app-installation.test.tsx), the Discord-dependent
// half of this response IS deterministic here, because tests/mocks/discord/server.ts serves Discord's
// REST API from state. So this file asserts the whole contract rather than only the authz and
// validation halves: what makes that possible is the mock being reachable from inside the edge
// runtime container, which is what scripts/start-discord-mock.sh arranges.
//
// The regression this function exists to catch is the `bot-role-too-low` case below. A bot can be
// installed, hold every required permission, and still fail every role assignment with a bare
// 403/50013 because its own role ties or sits below the class roles. Discord's rule is strict
// inequality, so the interesting case is the TIE — `bot_role_position === highest_class_role_position`
// with an empty `missing_permissions` and `can_manage_class_roles: false`. A `>=` where the code
// wants `>` passes every other scenario in this file and fails only this one.
//
// Requires:
//   scripts/start-discord-mock.sh
//   DISCORD_API_BASE_URL=http://discord-mock:8788/api/v10 in the env file that
//     `npx supabase functions serve --env-file .env.local` was started with
// No app server (port 3001) is needed: this suite talks to the edge function directly.

type CheckResponse = {
  installed: boolean;
  guild_id: string | null;
  guild_name: string | null;
  missing_permissions: string[];
  can_manage_class_roles: boolean;
  bot_role_position: number | null;
  highest_class_role_position: number | null;
  /** Tracked roles the guild no longer has. */
  stale_class_role_ids: string[];
  /** Tracked channels whose own overwrites block the bot. */
  channel_permission_problems: { channel_id: string; channel_name: string | null; missing: string[] }[];
  /** Tracked channels the guild's channel list does not return: deleted, or hidden from the bot. */
  missing_tracked_channel_ids: string[];
  /** False when no candidate the invite path would try permits Create Invite. */
  can_create_invites: boolean;
  install_url: string;
};

test.describe.configure({ mode: "serial" });

test.describe("discord-check-bot-installation edge function", () => {
  test.describe.configure({ timeout: 120_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // Not DEFAULT_GUILD_ID: `classes_discord_server_id_active_key` permits one unarchived class per
  // guild and the seeded demo class already holds the mock's default. Cloned into the mock per
  // scenario by applyScenarioForGuilds.
  const GUILD_ID = randomGuildId();

  let classAId: number;
  let classBId: number;
  let instructorA: TestingUser;
  let instructorB: TestingUser;
  let studentA: TestingUser;
  let studentB: TestingUser; // enrolled in a different class
  let mockUp = false;

  test.beforeAll(async () => {
    // The hook's own timeout, not the tests'. takeDiscordMock() below can wait a while: the mock is
    // one process and one scenario at a time, so every spec file that drives it queues behind the
    // others -- and Playwright runs this file once per browser project even though neither test here
    // opens a browser. The default 60s hook timeout is shorter than that queue, and the failure it
    // produces ("beforeAll hook timeout") looks nothing like the contention that caused it.
    test.setTimeout(300_000);
    mockUp = (await discordMockReachable()) && discordApiIsMocked();
    if (!mockUp) return;
    await takeDiscordMock();

    const clsA = await createClass({ name: `E2E DiscordCheck A ${RUN_PREFIX}` });
    classAId = clsA.id;
    const clsB = await createClass({ name: `E2E DiscordCheck B ${RUN_PREFIX}` });
    classBId = clsB.id;

    instructorA = await createUserInClass({
      role: "instructor",
      class_id: classAId,
      name: `DiscordCheck Instructor ${RUN_PREFIX}`,
      email: `e2e-dcheck-instr-${SAFE_ID}@pawtograder.net`
    });
    instructorB = await createUserInClass({
      role: "instructor",
      class_id: classBId,
      name: `DiscordCheck Instructor B ${RUN_PREFIX}`,
      email: `e2e-dcheck-instr-b-${SAFE_ID}@pawtograder.net`
    });
    studentA = await createUserInClass({
      role: "student",
      class_id: classAId,
      name: `DiscordCheck Student ${RUN_PREFIX}`,
      email: `e2e-dcheck-stu-${SAFE_ID}@pawtograder.net`
    });
    studentB = await createUserInClass({
      role: "student",
      class_id: classBId,
      name: `DiscordCheck Other ${RUN_PREFIX}`,
      email: `e2e-dcheck-other-${SAFE_ID}@pawtograder.net`
    });

    // Class A is connected to the mock's guild; class B deliberately is not, so the
    // "no server configured" branch has a fixture too.
    //
    // Written with the service-role client on purpose: since 20260822130000 an instructor UPDATE
    // cannot touch discord_server_id (see discord-guild-claim.test.tsx, which is where that is the
    // property under test) and claim_discord_guild is the only other writer. Service role bypasses
    // RLS, so this is the cheapest way to pose the connected state.
    const { error: connectError } = await supabase
      .from("classes")
      .update({ discord_server_id: GUILD_ID })
      .eq("id", classAId);
    expect(connectError, `failed to point class ${classAId} at guild ${GUILD_ID}`).toBeNull();

    // The class's roles as Pawtograder recorded them, using the mock's role snowflakes. Without
    // these, `highest_class_role_position` is null and `canManageRoles` short-circuits to true for
    // an empty list — which would make the hierarchy assertions below vacuous.
    //
    // Inserted AFTER the server is set: clear_discord_roles_on_server_change fires BEFORE UPDATE of
    // discord_server_id and deletes them, so the other order silently leaves no rows.
    const { error: rolesError } = await supabase.from("discord_roles").insert([
      { class_id: classAId, discord_role_id: STUDENT_ROLE_ID, role_type: "student" },
      { class_id: classAId, discord_role_id: GRADER_ROLE_ID, role_type: "grader" },
      { class_id: classAId, discord_role_id: INSTRUCTOR_ROLE_ID, role_type: "instructor" }
    ]);
    expect(rolesError, "failed to seed discord_roles").toBeNull();

    // Connecting a server enqueues create_role and create_channel work via
    // trg_discord_create_roles_on_server_connect. Nothing in this file wants that work done, and a
    // worker run started by another spec drains the same queue -- it would find these, fail to create
    // a role in a guild the mock is not currently posing, and dead-letter them. Dropped here rather
    // than only in afterAll so that window never opens.
    await drainQueue((row) => (row.message?.args as { guild_id?: string } | undefined)?.guild_id === GUILD_ID);
  });

  test.afterAll(async () => {
    if (!mockUp) return;
    // Connecting a server enqueues create_role / create_channel work via
    // trg_discord_create_roles_on_server_connect. Nothing here invokes the worker, so drop those so
    // a later worker run (this suite's enrollment spec, or a cron poke) does not process them.
    if (classAId) {
      const mine = (row: { message?: { args?: Record<string, unknown> } }) =>
        (row.message?.args as { guild_id?: string } | undefined)?.guild_id === GUILD_ID;
      await drainQueue(mine);
      await drainQueue(mine, DISCORD_DLQ);
      await supabase.from("classes").update({ discord_server_id: null }).eq("id", classAId);
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

  /**
   * The mock's calls for THIS class's guild.
   *
   * Scoped rather than "the log is empty", because the log is one process's and a `discord-async-worker`
   * run started by another spec keeps draining its queue in the background after that spec has
   * finished -- its requests land here and have nothing to do with this one. Filtering by the guild
   * keeps the property ("an unauthorized caller causes no traffic for this class's server") while
   * making it independent of what else is running.
   */
  async function callsForThisClass() {
    return (await getCalls()).filter((call) => call.path.includes(GUILD_ID));
  }

  async function check(user: TestingUser, classId: number | null | undefined) {
    const client = await createAuthenticatedClient(user);
    const body = classId === undefined ? {} : { class_id: classId };
    return await client.functions.invoke<CheckResponse>("discord-check-bot-installation", { body });
  }

  // ---------------------------------------------------------------------------
  // Authorization — a pure user_roles check, so no Discord call is reached
  // ---------------------------------------------------------------------------
  test("rejects a non-instructor (student) caller before touching Discord", async () => {
    await applyScenarioForGuilds("healthy", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(studentA, classAId);
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(401);
    }
    // The whole point of rejecting first: an unauthorized caller must not be able to make the
    // deployment spend its single shared bot token's rate limit.
    expect(await callsForThisClass()).toHaveLength(0);
  });

  test("rejects a caller who is an instructor in a DIFFERENT class", async () => {
    await clearCalls();
    const { data, error } = await check(instructorA, classBId);
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(401);
    }
    expect(await callsForThisClass()).toHaveLength(0);
  });

  test("rejects a student enrolled in another class entirely", async () => {
    const { data, error } = await check(studentB, classAId);
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
  });

  test("service role is not an instructor either: the function is authz-gated, not key-gated", async () => {
    const { data, error } = await supabase.functions.invoke<CheckResponse>("discord-check-bot-installation", {
      body: { class_id: classAId }
    });
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Input validation — UserVisibleError 400, before any Discord call
  // ---------------------------------------------------------------------------
  test("rejects a missing class_id with a 400", async () => {
    await clearCalls();
    const { error } = await check(instructorA, undefined);
    expect(error).not.toBeNull();
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(400);
      const body = await error.context.json().catch(() => null);
      expect(JSON.stringify(body ?? {})).toMatch(/class_id is required/i);
    }
    expect(await callsForThisClass()).toHaveLength(0);
  });

  test("rejects a null class_id with a 400", async () => {
    const { error } = await check(instructorA, null);
    expect(error).not.toBeNull();
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(400);
    }
  });

  // ---------------------------------------------------------------------------
  // Response shape
  // ---------------------------------------------------------------------------
  test("a class with no Discord server reports not-installed with a bare install URL", async () => {
    const { data, error } = await check(instructorB, classBId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const body = data as CheckResponse;
    expect(body.installed).toBe(false);
    expect(body.guild_id).toBeNull();
    expect(body.guild_name).toBeNull();
    // Empty rather than the full required list: nothing has failed to grant anything yet, and six
    // red rows next to an un-pressed install button would be noise, not information.
    expect(body.missing_permissions).toEqual([]);
    expect(body.can_manage_class_roles).toBe(false);
    expect(body.bot_role_position).toBeNull();
    expect(body.highest_class_role_position).toBeNull();
    expect(body.install_url).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?/);
    // No guild is pinned, because there is none to pin.
    expect(body.install_url).not.toContain("guild_id=");
  });

  // ---------------------------------------------------------------------------
  // Per-scenario assertions, driven by the mock's state
  // ---------------------------------------------------------------------------
  test("healthy: installed, no missing permissions, hierarchy fine", async () => {
    await applyScenarioForGuilds("healthy", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    expect(body.installed).toBe(true);
    expect(body.guild_id).toBe(GUILD_ID);
    expect(body.guild_name).toBe("CS 3200 Fall 2026");
    expect(body.missing_permissions).toEqual([]);
    expect(body.can_manage_class_roles).toBe(true);
    // The scenario puts the bot's role at 10 and the highest class role (instructor) at 5.
    expect(body.bot_role_position).toBe(10);
    expect(body.highest_class_role_position).toBe(5);
    // Re-running the OAuth flow is how a bot's permissions are widened, so the URL is still offered,
    // pinned to the configured guild so the consent screen cannot be pointed elsewhere.
    expect(body.install_url).toContain(`guild_id=${GUILD_ID}`);

    // Traffic really reached the mock: the guild, the bot's own member object, and the role list.
    const calls = await callsForThisClass();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        `GET /guilds/${GUILD_ID}`,
        `GET /guilds/${GUILD_ID}/members/@me`,
        `GET /guilds/${GUILD_ID}/roles`,
        // One request for the whole channel audit: GET /guilds/{id}/channels carries every channel's
        // permission_overwrites inline, so the per-channel answer costs no per-channel fan-out.
        `GET /guilds/${GUILD_ID}/channels`
      ])
    );
    expect(calls.filter((c) => c.path === `/guilds/${GUILD_ID}/channels`)).toHaveLength(1);
    expect(calls.every((c) => c.status === 200)).toBe(true);
    // Nothing is denied per channel, and #general permits Create Invite, so students can be invited.
    expect(body.channel_permission_problems).toEqual([]);
    expect(body.missing_tracked_channel_ids).toEqual([]);
    expect(body.can_create_invites).toBe(true);
  });

  test("bot-not-in-guild: not installed, and the install URL is pinned to the configured guild", async () => {
    await applyScenarioForGuilds("bot-not-in-guild", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    expect(body.installed).toBe(false);
    // The configured id is echoed back even though the bot cannot see the guild: that id is what the
    // instructor has to recognise (or correct).
    expect(body.guild_id).toBe(GUILD_ID);
    expect(body.guild_name).toBeNull();
    expect(body.missing_permissions).toEqual([]);
    expect(body.can_manage_class_roles).toBe(false);
    expect(body.install_url).toContain(`guild_id=${GUILD_ID}`);

    // One call, refused the way Discord refuses it. A bot has no way to tell "no such guild" from
    // "not your guild", so the check stops here rather than asking about roles it cannot see.
    const guildCall = (await callsForThisClass()).find((c) => c.path === `/guilds/${GUILD_ID}`);
    expect(guildCall).toBeTruthy();
    expect(guildCall?.status).toBe(404);
    expect(guildCall?.code).toBe(10004);
  });

  test("guild-gone: a stale discord_server_id reads as not installed", async () => {
    // No guild in the mock at all, which is what a class pointed at a deleted (or mistyped) server
    // sees. Indistinguishable from bot-not-in-guild at the API, deliberately.
    await applyScenarioForGuilds("guild-gone", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    expect(body.installed).toBe(false);
    expect(body.guild_id).toBe(GUILD_ID);
    expect(body.bot_role_position).toBeNull();
    expect(body.highest_class_role_position).toBeNull();

    const guildCall = (await callsForThisClass()).find((c) => c.path === `/guilds/${GUILD_ID}`);
    expect(guildCall?.status).toBe(404);
    expect(guildCall?.code).toBe(10004);
  });

  test("missing-manage-roles: installed, but the missing permission is named", async () => {
    await applyScenarioForGuilds("missing-manage-roles", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    // Installed and reachable. Reporting this as "not installed" is the wrong answer that this
    // response shape exists to avoid: the remediation would be re-inviting a bot that is already in.
    expect(body.installed).toBe(true);
    expect(body.missing_permissions).toContain("Manage Roles");
    // Only that one: the scenario takes Manage Roles off the bot's role and leaves @everyone alone.
    expect(body.missing_permissions).toEqual(["Manage Roles"]);
    expect(body.can_manage_class_roles).toBe(false);
    // The hierarchy is fine here, so the position pair is NOT the evidence — the named permission is.
    expect(body.bot_role_position).toBe(10);
    expect(body.highest_class_role_position).toBe(5);

    expect((await callsForThisClass()).some((c) => c.path === `/guilds/${GUILD_ID}/roles`)).toBe(true);
  });

  test("bot-role-too-low: permissions all held, hierarchy TIES, so role management is refused", async () => {
    // The regression this whole feature exists to catch. The bot's role is at position 5, the same
    // as the class's instructor role. Discord's rule is strict inequality, so a tie fails — and it
    // fails with 403/50013, the same code as not holding Manage Roles at all, which is why it cannot
    // be diagnosed from the error and has to be preflighted.
    await applyScenarioForGuilds("bot-role-too-low", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    expect(body.installed).toBe(true);
    // Nothing is missing: this is not a permissions problem.
    expect(body.missing_permissions).toEqual([]);
    expect(body.can_manage_class_roles).toBe(false);
    // The equal-position case. `<` reports this correctly; `<=` reports a healthy install for a
    // server where every instructor-role assignment will fail.
    expect(body.bot_role_position).toBe(5);
    expect(body.highest_class_role_position).toBe(5);
    expect(body.bot_role_position).toBe(body.highest_class_role_position);

    expect((await callsForThisClass()).filter((c) => c.status !== 200)).toHaveLength(0);
  });

  test("rate-limited: a 429 surfaces a retryable error and NEVER 'not installed'", async () => {
    // 429 says nothing about the guild's configuration — it says the shared bot token is out of
    // budget. Answering `installed: false` here would be confident, wrong, and would send the
    // instructor to re-invite a bot that is already installed.
    await applyScenarioForGuilds("rate-limited", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(instructorA, classAId);
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
    if (error?.context instanceof Response) {
      // 503, not 502 and not 200: the caller is being told to try again.
      expect(error.context.status).toBe(503);
      const payload = (await error.context.json().catch(() => null)) as {
        error?: { recoverable?: boolean; message?: string };
      } | null;
      expect(payload?.error?.recoverable).toBe(true);
      expect(payload?.error?.message ?? "").toMatch(/try again/i);
    }

    const guildCall = (await callsForThisClass()).find((c) => c.path === `/guilds/${GUILD_ID}`);
    expect(guildCall?.status).toBe(429);
  });

  test("a discord_roles row naming a role the guild no longer has is reported, not silently skipped", async () => {
    // Somebody deleted the role in Discord. Two separate things have to be true. The orphan must not
    // enter the hierarchy comparison -- pinning it at position 0 would make the server look
    // manageable for the wrong reason, since 0 < 10 for any bot -- AND it has to be reported, because
    // the surviving discord_roles row is doing active harm: every assignment of that snowflake 404s,
    // and the row's existence is what stops the ordinary create-role path from replacing it. Dropping
    // it from the hierarchy check while saying nothing is what let a class with a broken role read as
    // fully healthy.
    await applyScenarioForGuilds("healthy", [GUILD_ID]);
    const orphan = "1209999999999999999";
    const roles = untypedTable(supabase, "discord_roles");
    const { error: delError } = await roles.delete().eq("class_id", classAId);
    expect(delError).toBeNull();
    const { error: insError } = await roles.insert({
      class_id: classAId,
      discord_role_id: orphan,
      role_type: "student"
    });
    expect(insError).toBeNull();

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    expect(body.installed).toBe(true);
    // No live class role remains, so there is no position to report and nothing that could be
    // blocked — canManageRoles returns true for an empty list.
    expect(body.highest_class_role_position).toBeNull();
    expect(body.can_manage_class_roles).toBe(true);
    // The part that stops this reading as healthy.
    expect(body.stale_class_role_ids).toEqual([orphan]);

    // And the converse: with the fixture's live roles restored, nothing is reported stale. Without
    // this the assertion above would still pass if the field simply listed every tracked role.

    // Restore the fixture for anything that runs after this.
    await roles.delete().eq("class_id", classAId);
    await roles.insert([
      { class_id: classAId, discord_role_id: STUDENT_ROLE_ID, role_type: "student" },
      { class_id: classAId, discord_role_id: GRADER_ROLE_ID, role_type: "grader" },
      { class_id: classAId, discord_role_id: INSTRUCTOR_ROLE_ID, role_type: "instructor" }
    ]);

    const { data: healthy } = await check(instructorA, classAId);
    expect((healthy as CheckResponse).stale_class_role_ids).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // The channel layer — per-channel and per-category overwrites
  //
  // Discord resolves permissions in two layers, and every test above reads only the first one. A
  // guild can grant Send Messages to everyone and deny it in `#general`, or deny Create Invite in the
  // channel the enrollment path reaches for, and every assertion above still passes. The assertion
  // these tests share is that `missing_permissions` stays EMPTY: these are not server-level gaps, they
  // have a different fix (edit that channel), and folding them together would send an instructor to a
  // re-authorize button that cannot change a channel overwrite.
  // ---------------------------------------------------------------------------

  /** A cloned guild's channel id, looked up by name because cloneGuild rewrites the ids. */
  function channelIdByName(state: MockState, name: string): string {
    const channel = state.guilds[GUILD_ID]?.channels.find((c) => c.name === name);
    if (!channel) {
      throw new Error(`the mock's clone of guild ${GUILD_ID} has no channel named "${name}"`);
    }
    return channel.id;
  }

  /** Track a channel for class A the way discord-async-worker does after creating one. */
  async function trackChannel(channelId: string) {
    const { error } = await untypedTable(supabase, "discord_channels").insert({
      class_id: classAId,
      discord_channel_id: channelId,
      channel_type: "general"
    });
    expect(error, `failed to track channel ${channelId}`).toBeNull();
  }

  async function untrackChannels() {
    await untypedTable(supabase, "discord_channels").delete().eq("class_id", classAId);
  }

  test("channel-send-denied: a tracked channel the bot cannot post in is named, and is NOT a server-level gap", async () => {
    // Guild-level permissions are complete. #general denies Send Messages to the bot's role by
    // overwrite, so every notification posted there 403s while the server-level audit stays clean --
    // which is exactly the state that used to read as "Connected and working".
    const state = await applyScenarioForGuilds("channel-send-denied", [GUILD_ID]);
    const generalId = channelIdByName(state, "general");
    await trackChannel(generalId);
    await clearCalls();

    try {
      const { data, error } = await check(instructorA, classAId);
      expect(error).toBeNull();
      const body = data as CheckResponse;
      expect(body.installed).toBe(true);
      // The assertion that proves the two layers are kept distinct. Nothing is missing server-wide.
      expect(body.missing_permissions).toEqual([]);
      expect(body.can_manage_class_roles).toBe(true);
      expect(body.stale_class_role_ids).toEqual([]);
      // Named channel, named permission: the remediation is one switch in one channel's settings.
      expect(body.channel_permission_problems).toEqual([
        { channel_id: generalId, channel_name: "general", missing: ["Send Messages"] }
      ]);
      // Create Invite is untouched here, so enrollment still works. The two channel answers are
      // separate for that reason.
      expect(body.can_create_invites).toBe(true);

      const calls = await callsForThisClass();
      expect(calls.filter((c) => c.path === `/guilds/${GUILD_ID}/channels`)).toHaveLength(1);
      expect(calls.every((c) => c.status === 200)).toBe(true);
    } finally {
      await untrackChannels();
    }
  });

  test("channel-send-denied: the same guild with nothing tracked reports no channel problem", async () => {
    // The scope of `channel_permission_problems` is the class's own channels. A denied channel the
    // class does not post to is somebody else's business, and reporting it would put a permanent
    // warning on every course whose server has one locked-down channel.
    const state = await applyScenarioForGuilds("channel-send-denied", [GUILD_ID]);
    channelIdByName(state, "general"); // asserts the denied channel is really there

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    expect(body.missing_permissions).toEqual([]);
    expect(body.channel_permission_problems).toEqual([]);
    expect(body.can_create_invites).toBe(true);
  });

  test("channel-invite-denied: one denied text channel does not stop invites when another allows them", async () => {
    // The first text channel by position denies Create Invite; #announcements allows it. Invites need
    // ONE usable channel, so the guild can still enroll students and `can_create_invites` stays true.
    // Reporting false here would send an instructor to fix a channel that is not the problem.
    const state = await applyScenarioForGuilds("channel-invite-denied", [GUILD_ID]);
    const generalId = channelIdByName(state, "general");
    const announcementsId = channelIdByName(state, "announcements");
    expect(announcementsId).not.toBe(generalId);
    // Tracked, so the audit definitely looks at the denied channel and still finds nothing to report:
    // Create Invite is asked of the guild's text channels as a set, not of each tracked channel.
    await trackChannel(generalId);
    await clearCalls();

    try {
      const { data, error } = await check(instructorA, classAId);
      expect(error).toBeNull();
      const body = data as CheckResponse;
      expect(body.installed).toBe(true);
      // Again: not a server-level gap. The bot holds Create Invite across the guild.
      expect(body.missing_permissions).toEqual([]);
      expect(body.can_create_invites).toBe(true);
      // Posting in #general is unaffected, so there is nothing to report about it either.
      expect(body.channel_permission_problems).toEqual([]);
    } finally {
      await untrackChannels();
    }
  });

  test("the invite audit stops where the invite path stops, so a fifth usable candidate is not counted", async () => {
    // The panel's job is to predict the invite path, and that path tries at most
    // MAX_INVITE_CHANNEL_ATTEMPTS (4) of the ordered candidates. A guild whose first four candidates
    // deny Create Invite and whose fifth allows it would report `can_create_invites: true` from an
    // uncapped scan, and then every student in the class would still land on `cannot_invite` -- the
    // panel confidently disagreeing with the worker about the same guild.
    //
    // The names avoid every hint in PREFERRED_NAME_HINTS so the candidate order is decided by
    // `position` alone, which is what makes "the fifth one" a statement about this fixture and not
    // about the name ranking.
    const denied = (n: number, position: number) => ({
      id: `14500000000000000${String(n).padStart(2, "0")}`,
      name: `locked-${n}`,
      type: 0,
      guild_id: GUILD_ID,
      parent_id: null,
      position,
      permission_overwrites: [
        { id: BOT_ROLE_ID, type: 0, allow: "0", deny: DISCORD_PERMISSION_BITS.CREATE_INSTANT_INVITE.toString() }
      ]
    });
    const open = (position: number) => ({
      id: "1450000000000000099",
      name: "open-room",
      type: 0,
      guild_id: GUILD_ID,
      parent_id: null,
      position
    });

    // Four denied candidates ahead of the only usable one: the worker never reaches it.
    await applyScenarioForGuilds("healthy", [GUILD_ID], () => ({
      channels: [denied(1, 1), denied(2, 2), denied(3, 3), denied(4, 4), open(5)]
    }));
    await clearCalls();
    const { data: capped, error: cappedError } = await check(instructorA, classAId);
    expect(cappedError).toBeNull();
    const cappedBody = capped as CheckResponse;
    expect(cappedBody.installed).toBe(true);
    // Not a server-level gap: the bot holds Create Invite across the guild, as every other test here.
    expect(cappedBody.missing_permissions).toEqual([]);
    expect(cappedBody.can_create_invites).toBe(false);

    // A-B on the one thing that changed: with three denied candidates the usable channel is the
    // fourth, inside the budget, and the same guild reports true. Without this the assertion above
    // would also pass if the usable channel were simply misconfigured.
    await applyScenarioForGuilds("healthy", [GUILD_ID], () => ({
      channels: [denied(1, 1), denied(2, 2), denied(3, 3), open(4)]
    }));
    const { data: withinBudget, error: budgetError } = await check(instructorA, classAId);
    expect(budgetError).toBeNull();
    expect((withinBudget as CheckResponse).can_create_invites).toBe(true);
  });

  test("a tracked channel the guild does not return is reported as missing, not as healthy", async () => {
    // A Discord admin deleted a Pawtograder-managed channel. The discord_channels row survives, and
    // the audit's permission pass can say nothing about a channel whose overwrites it never read -- so
    // before this field the row was silently skipped and the panel said "Connected and working" while
    // every notification aimed at that channel failed.
    //
    // The same signal covers a channel hidden by a View Channel denial, because
    // GET /guilds/{id}/channels omits both cases identically and the API offers nothing to tell them
    // apart. The remediation ("re-sync, or grant the bot access") is written to cover both.
    const state = await applyScenarioForGuilds("healthy", [GUILD_ID]);
    const generalId = channelIdByName(state, "general");
    const deletedId = "1409999999999999999";
    await trackChannel(generalId);
    await trackChannel(deletedId);
    await clearCalls();

    try {
      const { data, error } = await check(instructorA, classAId);
      expect(error).toBeNull();
      const body = data as CheckResponse;
      expect(body.installed).toBe(true);
      expect(body.missing_permissions).toEqual([]);
      expect(body.can_manage_class_roles).toBe(true);
      // The one that is gone, and only that one: #general is present and healthy.
      expect(body.missing_tracked_channel_ids).toEqual([deletedId]);
      // Deliberately NOT folded in here. This field's claim is that an overwrite blocks an operation,
      // which is unsupportable for a channel that was never in the listing.
      expect(body.channel_permission_problems).toEqual([]);
      // Enrollment is unaffected: invites are asked of the guild's channels, not of the tracked ones.
      expect(body.can_create_invites).toBe(true);
    } finally {
      await untrackChannels();
    }
  });

  test("no-text-channel: a guild with nowhere to invite into cannot enroll anybody", async () => {
    // The severe half of the channel layer, and the reason it is its own field. Every server-level
    // permission is held, so `missing_permissions` is empty and the old response would have called
    // this healthy -- but there is no text channel, so no invite can be created and no student can
    // reach the server at all.
    await applyScenarioForGuilds("no-text-channel", [GUILD_ID]);
    await clearCalls();

    const { data, error } = await check(instructorA, classAId);
    expect(error).toBeNull();
    const body = data as CheckResponse;
    expect(body.installed).toBe(true);
    expect(body.missing_permissions).toEqual([]);
    expect(body.can_manage_class_roles).toBe(true);
    expect(body.can_create_invites).toBe(false);
    expect(body.channel_permission_problems).toEqual([]);
  });

  test("missing-view-channel: a 403 on the channel list is a fact, not a failure", async () => {
    // The bot cannot see the channel list at all, which Discord answers 403 / 50001. That is terminal
    // and already named at the server level, so the check keeps the rest of its diagnosis rather than
    // throwing the whole thing away -- and reports the channel layer as unusable, which it is.
    const state = await applyScenarioForGuilds("missing-view-channel", [GUILD_ID]);
    // Tracked, so "nothing is reported missing" below is a decision rather than an empty input: this
    // channel exists in the guild and is absent from a listing the bot cannot read.
    await trackChannel(channelIdByName(state, "general"));
    await clearCalls();

    try {
      const { data, error } = await check(instructorA, classAId);
      expect(error).toBeNull();
      const body = data as CheckResponse;
      expect(body.installed).toBe(true);
      expect(body.missing_permissions).toContain("View Channels");
      expect(body.can_create_invites).toBe(false);
      // Nothing is claimed about individual channels: their overwrites were never readable.
      expect(body.channel_permission_problems).toEqual([]);
      // And nothing is claimed to be MISSING either. With no listing at all every tracked channel is
      // absent from it, so reporting them would be an artefact of the 403 rather than a finding.
      expect(body.missing_tracked_channel_ids).toEqual([]);

      const channelsCall = (await callsForThisClass()).find((c) => c.path === `/guilds/${GUILD_ID}/channels`);
      expect(channelsCall?.status).toBe(403);
      expect(channelsCall?.code).toBe(50001);
    } finally {
      await untrackChannels();
    }
  });

  test("a 5xx on the channel list is retryable, and never reported as a channel permission problem", async () => {
    // The distinction the whole failure-handling discipline in this function exists for. A 503 says
    // nothing about the guild's channels; answering `can_create_invites: false` on the strength of it
    // would tell an instructor their server cannot enroll anybody because Discord hiccuped.
    await applyScenarioForGuilds("healthy", [GUILD_ID]);
    await setState({ faults: [{ method: "GET", path: "channels$", status: 503 }] });
    await clearCalls();

    try {
      const { data, error } = await check(instructorA, classAId);
      expect(data?.installed).toBeUndefined();
      expect(error).not.toBeNull();
      if (error?.context instanceof Response) {
        // 503 and recoverable: try again, rather than a confident wrong answer about the channels.
        expect(error.context.status).toBe(503);
        const payload = (await error.context.json().catch(() => null)) as {
          error?: { recoverable?: boolean; message?: string };
        } | null;
        expect(payload?.error?.recoverable).toBe(true);
        expect(payload?.error?.message ?? "").toMatch(/channels/i);
      }
      const channelsCall = (await callsForThisClass()).find((c) => c.path === `/guilds/${GUILD_ID}/channels`);
      expect(channelsCall?.status).toBe(503);
    } finally {
      // Faults replace rather than merge, so clearing them is one empty array.
      await setState({ faults: [] });
    }
  });
});
