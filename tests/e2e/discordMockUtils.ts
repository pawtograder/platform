/**
 * Test-side plumbing shared by the Discord E2E specs.
 *
 * Three problems live here rather than being repeated in each spec:
 *
 *  1. **The mock is one process and the scenarios are global.** `POST /__mock/scenario/{name}`
 *     replaces the whole world and clears the call log, so two spec files driving it at once would
 *     silently rewrite each other's fixtures -- and Playwright runs files in parallel across four
 *     workers and two browser projects. `withDiscordMockLock` serialises the files that touch it.
 *
 *  2. **Every scenario poses the same guild id.** `classes_discord_server_id_active_key` allows one
 *     unarchived class per guild, and the seeded demo class already holds the mock's default guild,
 *     so a spec that pointed its own class at `DEFAULT_GUILD_ID` would fail on the unique index --
 *     or, worse, succeed by evicting the demo class. `applyScenarioForGuilds` applies a scenario and
 *     then clones its guild under caller-chosen ids, which also makes "this guild's breaker opened
 *     and that one's did not" expressible at all.
 *
 *  3. **The secret-gated functions are not reachable through supabase-js.** `functions.invoke()`
 *     cannot set `x-edge-function-secret` alongside the SDK's own auth header in a way that keeps
 *     the status code readable, so those two are called with plain `fetch`.
 */

import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { supabase } from "@/tests/e2e/TestingUtils";
import { getState, setScenario, setState, waitForMock } from "@/tests/mocks/discord/client";
import { DEFAULT_GUILD_ID, type MockGuild, type MockState } from "@/tests/mocks/discord/state";

export {
  BOT_ROLE_ID,
  DEFAULT_GUILD_ID,
  GRADER_ROLE_ID,
  INSTRUCTOR_ROLE_ID,
  STUDENT_ROLE_ID
} from "@/tests/mocks/discord/state";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Guild ids
// ============================================================================

/**
 * A guild id no other class can be holding.
 *
 * The `11429` prefix is not decoration. `DiscordErrorClassification.ts` documents a
 * misclassification caused by a bare substring search for "429" in an error message, which read
 * `guild 1142900000000000000` as a rate limit; the mock's default id keeps that regression covered
 * and these ids keep covering it while still being unique per run. 19 digits, so it satisfies
 * `claim_discord_guild`'s `^[0-9]{17,20}$`.
 */
export function randomGuildId(): string {
  let digits = "";
  for (let i = 0; i < 14; i += 1) digits += String(randomInt(0, 10));
  return `11429${digits}`;
}

/** A Discord user snowflake for a member this run invents. */
export function randomDiscordUserId(): string {
  let digits = "";
  for (let i = 0; i < 15; i += 1) digits += String(randomInt(0, 10));
  return `2${digits}`;
}

// ============================================================================
// Reachability
// ============================================================================

let reachable: boolean | null = null;

/**
 * Whether the mock is up, cached per worker process.
 *
 * Specs skip rather than fail when it is not: without `scripts/start-discord-mock.sh` and a
 * matching `DISCORD_API_BASE_URL` in the edge runtime's env file there is nothing under test here,
 * and a hard failure in that environment would say "Discord is broken" when it means "the mock was
 * not started".
 */
export async function discordMockReachable(): Promise<boolean> {
  if (reachable !== null) return reachable;
  try {
    await waitForMock(5_000);
    reachable = true;
  } catch {
    reachable = false;
  }
  if (!reachable) requireMockOrThrow("the Discord mock is not reachable");
  return reachable;
}

/**
 * Turn a skip into a failure where a skip would be a lie.
 *
 * Skipping is right on a developer machine that has not run `scripts/start-discord-mock.sh`: there is
 * nothing under test, and failing would say "Discord is broken" when it means "the mock is not
 * running". It is wrong in CI, where a skip reports coverage that never executed -- which is exactly
 * what happened before the workflow learned to start the mock: `e2e-local` went green with 136 Discord
 * tests silently skipped.
 *
 * So CI sets DISCORD_MOCK_REQUIRED=1 and gets a loud failure instead. The health check in the
 * workflow catches a mock that failed to start; this also catches the subtler case where the mock is
 * up but the edge runtime was never pointed at it, which no amount of curling the mock would reveal.
 */
function requireMockOrThrow(reason: string): void {
  if (process.env.DISCORD_MOCK_REQUIRED !== "1") return;
  throw new Error(
    `DISCORD_MOCK_REQUIRED=1 but ${reason}. These specs must not be skipped here — start it with ` +
      `scripts/start-discord-mock.sh and point DISCORD_API_BASE_URL at it.`
  );
}

/**
 * Whether the edge runtime is pointed at the mock rather than at discord.com.
 *
 * Checked separately from reachability because the two fail independently and only together mean
 * anything: a mock nobody is pointed at logs no calls, which looks exactly like a spec whose
 * assertions are wrong.
 */
export function discordApiIsMocked(): boolean {
  const base = process.env.DISCORD_API_BASE_URL ?? "";
  if (base === "") {
    requireMockOrThrow("DISCORD_API_BASE_URL is unset");
    return false;
  }
  // Compared as a parsed host, not as a substring. `base.includes("discord.com")` also matches
  // `discord.com.example.test` and `http://mock/?upstream=discord.com`, so it could call a run
  // mocked when it was pointed at a host that merely mentions Discord -- and the assertions here
  // would then be made against whatever answered.
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    // An unparseable base is not a mock we can vouch for; skip rather than assert.
    return false;
  }
  const mocked = host !== "discord.com" && !host.endsWith(".discord.com");
  if (!mocked) requireMockOrThrow(`DISCORD_API_BASE_URL points at ${host}`);
  return mocked;
}

// ============================================================================
// Cross-file mutex
// ============================================================================

const LOCK_PATH = path.join(os.tmpdir(), "pawtograder-discord-mock.lock");
/** The token of whoever currently holds the lock, written by the acquirer. */
const LOCK_OWNER_PATH = path.join(LOCK_PATH, "owner");
/** A holder that has not touched the lock in this long has died; its lock is taken. */
const LOCK_STALE_MS = 5 * 60_000;

/**
 * This process's claim on the lock, or null when it holds nothing.
 *
 * The lock needs an owner because it is also breakable. Without one: worker A decides B's lock is
 * stale and takes it, and then B's `afterAll` deletes the directory -- which is now A's lock -- and
 * a third worker walks straight into the scenario A is halfway through. So every mutation of the
 * lock is guarded by "is the token in there still mine", and release is a no-op when it is not.
 */
let lockToken: string | null = null;

function readLockOwner(): string | null {
  try {
    return fs.readFileSync(LOCK_OWNER_PATH, "utf8").trim();
  } catch {
    // No directory, or no owner file yet: not a lock this process can claim to hold.
    return null;
  }
}

/** Whether this process is the current holder. */
export function holdsDiscordMockLock(): boolean {
  return lockToken !== null && readLockOwner() === lockToken;
}

async function acquireDiscordMockLock(timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // mkdir is the atomic primitive here: it fails if the directory exists, which is exactly the
      // test-and-set a lock needs and which writing a file does not give.
      fs.mkdirSync(LOCK_PATH);
      // Taking the lock and taking ownership of it are the same act, including when the directory
      // was just broken open as stale: the breaker loops back to this mkdir and stamps its own
      // token, so the previous holder can no longer release what it lost.
      const token = `${process.pid}-${randomUUID()}`;
      fs.writeFileSync(LOCK_OWNER_PATH, token);
      lockToken = token;
      return;
    } catch {
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[discord-mock] breaking a stale lock at ${LOCK_PATH} (owner ${readLockOwner() ?? "unknown"}, idle ${Math.round((Date.now() - stat.mtimeMs) / 1000)}s)`
          );
          fs.rmSync(LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Vanished between the failed mkdir and the stat: retry immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting ${timeoutMs}ms for the Discord mock lock at ${LOCK_PATH}`);
      }
      await sleep(250);
    }
  }
}

/** Keep the lock from looking stale during a long file. Cheap enough to call per test. */
export function touchDiscordMockLock(): void {
  // Only our own lock. Refreshing somebody else's mtime would keep a dead holder's lock alive past
  // the point where breaking it is the right answer.
  if (!holdsDiscordMockLock()) return;
  try {
    const now = new Date();
    fs.utimesSync(LOCK_PATH, now, now);
  } catch {
    // Released underneath us between the check and here: nothing to keep alive.
  }
}

export function releaseDiscordMockLock(): void {
  if (lockToken === null) return;
  if (readLockOwner() !== lockToken) {
    // Either already released, or broken as stale and re-taken by somebody else. Deleting it now
    // would hand the mock to a third process while that owner is still driving it.
    lockToken = null;
    return;
  }
  fs.rmSync(LOCK_PATH, { recursive: true, force: true });
  lockToken = null;
}

/** Take the mock for the calling spec file. Pair with `releaseDiscordMockLock()` in `afterAll`. */
export async function takeDiscordMock(): Promise<void> {
  await acquireDiscordMockLock();
}

// ============================================================================
// Scenarios, cloned onto caller-chosen guilds
// ============================================================================

/**
 * Copy a guild under a new id, rewriting every id that has to agree with it.
 *
 * Two of those are easy to miss. `@everyone`'s role id IS the guild id -- that is Discord's rule,
 * and `botPermissions()` unions it in by looking the guild id up in the role list, so a clone that
 * kept the old one would compute zero permissions from `@everyone` and report a healthy server as
 * missing four. And channel ids are global in the mock's `findChannel`, which returns the first
 * match across all guilds, so a clone sharing them would resolve another guild's channel.
 */
function cloneGuild(guild: MockGuild, targetId: string): MockGuild {
  const suffix = targetId.slice(-4);
  const channelIds = new Map<string, string>();
  guild.channels.forEach((channel, index) => {
    // The ordinal is what makes this injective, and it is not optional. Rewriting only the last four
    // characters collapsed the two default channels onto ONE id: CATEGORY_CHANNEL_ID
    // (…0000000002) and GENERAL_CHANNEL_ID (…0000000001) differ only in their last digit, so both
    // mapped to the same clone. `findChannel` returns the first match across every guild, so the
    // clone's "general" channel and its category were the same channel -- a category, type 4, for
    // anything that looked one of them up.
    const ordinal = String(index).padStart(2, "0");
    channelIds.set(channel.id, channel.id.slice(0, -(ordinal.length + suffix.length)) + ordinal + suffix);
  });
  // Asserted rather than reasoned about, so a default channel added later cannot quietly bring the
  // collision back: two channels sharing an id in this mock is not a test failure with an obvious
  // cause, it is a channel lookup that silently answers about the wrong channel.
  const distinct = new Set(channelIds.values());
  if (distinct.size !== channelIds.size) {
    throw new Error(
      `cloneGuild(${guild.id} -> ${targetId}) produced colliding channel ids: ${JSON.stringify([...channelIds])}`
    );
  }
  return {
    ...guild,
    id: targetId,
    bot_roles: [...guild.bot_roles],
    roles: guild.roles.map((role) => (role.id === guild.id ? { ...role, id: targetId } : { ...role })),
    channels: guild.channels.map((channel) => ({
      ...channel,
      id: channelIds.get(channel.id) ?? channel.id,
      guild_id: targetId,
      parent_id: channel.parent_id ? (channelIds.get(channel.parent_id) ?? channel.parent_id) : channel.parent_id
    })),
    members: Object.fromEntries(
      Object.entries(guild.members).map(([id, member]) => [id, { ...member, roles: [...member.roles] }])
    )
  };
}

/**
 * Apply a named scenario and pose its guild under each of `guildIds` as well.
 *
 * The scenario's own guild is left in place: the seeded demo class points at it, and removing it
 * would turn that class's batch sync into a 404 storm that has nothing to do with the spec.
 *
 * `guild-gone` has no guild to clone, which is the point of it -- the returned state simply has
 * none of the requested ids, so a class pointed at one gets Discord's 404 / 10004.
 */
export async function applyScenarioForGuilds(
  name: string,
  guildIds: string[],
  overrides?: (guildId: string) => Partial<MockGuild>
): Promise<MockState> {
  const base = await setScenario(name);
  const template = base.guilds[DEFAULT_GUILD_ID];
  if (!template) return base;
  const guilds: Record<string, MockGuild> = {};
  for (const guildId of guildIds) {
    guilds[guildId] = { ...cloneGuild(template, guildId), ...(overrides?.(guildId) ?? {}) };
  }
  return await setState({ guilds });
}

/** Add a member (holding no roles) to a guild the mock already knows about. */
export async function addMockMember(guildId: string, discordUserId: string, username?: string): Promise<void> {
  const state = await getState();
  if (!state.guilds[guildId]) {
    throw new Error(`Cannot add a member to guild ${guildId}: the mock does not have it`);
  }
  await setState({
    guilds: {
      [guildId]: {
        members: {
          [discordUserId]: {
            user: { id: discordUserId, username: username ?? `e2e-${discordUserId.slice(-4)}` },
            roles: [],
            nick: null,
            joined_at: new Date().toISOString()
          }
        }
      }
    }
  });
}

// ============================================================================
// Secret-gated edge functions
// ============================================================================

function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is required to invoke edge functions");
  return url.replace(/\/+$/, "");
}

export type EdgeFunctionCall = { status: number; body: unknown };

/**
 * POST an edge function, optionally with `x-edge-function-secret`.
 *
 * Plain fetch rather than `functions.invoke()` because both the 401-without-the-secret case and the
 * response body of the 200 case are under test, and the SDK turns a non-2xx into an error whose body
 * has to be re-read off `error.context`.
 */
export async function invokeEdgeFunction(
  name: string,
  options: { secret?: string | null; body?: unknown } = {}
): Promise<EdgeFunctionCall> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`
  };
  const secret = options.secret === undefined ? process.env.EDGE_FUNCTION_SECRET : options.secret;
  if (secret) headers["x-edge-function-secret"] = secret;

  const response = await fetch(`${supabaseUrl()}/functions/v1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {})
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    // Leave it as text; a non-JSON body is itself the interesting part of a failure.
  }
  return { status: response.status, body };
}

// ============================================================================
// The pgmq queue the worker drains
// ============================================================================

export const DISCORD_QUEUE = "discord_async_calls";
export const DISCORD_DLQ = "discord_async_calls_dlq";

export type QueueRow = {
  msg_id: number;
  message: { method?: string; class_id?: number; args?: Record<string, unknown>; retry_count?: number };
};

/**
 * Read up to `n` messages, hiding them for `vtSeconds`.
 *
 * A read is not a peek -- pgmq sets a visibility timeout on everything it hands back -- so a caller
 * that wants the worker to still see the message has to pass a short `vtSeconds`.
 */
export async function readQueue(queue = DISCORD_QUEUE, vtSeconds = 1, n = 100): Promise<QueueRow[]> {
  const { data, error } = await supabase
    .schema("pgmq_public")
    .rpc("read", { queue_name: queue, sleep_seconds: vtSeconds, n });
  if (error) throw new Error(`pgmq read of ${queue} failed: ${error.message}`);
  return (data ?? []) as unknown as QueueRow[];
}

export async function deleteQueueMessage(msgId: number, queue = DISCORD_QUEUE): Promise<void> {
  await supabase.schema("pgmq_public").rpc("delete", { queue_name: queue, message_id: msgId });
}

/**
 * Remove every message matching `match`, and report how many went.
 *
 * Used both to clear pre-existing residue before a worker run (an hourly `batch_role_sync` left
 * over from a cron poke that got a 401 would otherwise sweep every class the moment the worker is
 * invoked) and to clean up afterwards.
 */
export async function drainQueue(
  match: (row: QueueRow) => boolean = () => true,
  queue = DISCORD_QUEUE,
  timeoutMs = 8_000
): Promise<number> {
  let removed = 0;
  const deadline = Date.now() + timeoutMs;
  // Deliberately not "read once and stop when the page is empty". A read is not a peek: every
  // message pgmq hands back gets `vt = now() + sleep_seconds`, so a message some earlier read touched
  // is INVISIBLE right now and one empty page means nothing at all. The stopping condition is
  // therefore an empty stretch LONGER than the visibility timeout being used, which is the only thing
  // that distinguishes "the queue is empty" from "everything on it is briefly hidden".
  //
  // Both weaker versions of this were wrong in the same direction, and quietly: they drained nothing
  // and the test that caught it was one asserting a message was NOT there, which passed for the wrong
  // reason.
  const READ_VT_SECONDS = 1;
  const QUIET_MS = READ_VT_SECONDS * 1000 + 500;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    const rows = await readQueue(queue, READ_VT_SECONDS, 100);
    if (rows.length === 0) {
      if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince > QUIET_MS) break;
    } else {
      quietSince = null;
      for (const row of rows) {
        if (!match(row)) continue;
        await deleteQueueMessage(row.msg_id, queue);
        removed += 1;
      }
    }
    await sleep(300);
  }
  return removed;
}

/** Poll the queue for a message matching `match`, without consuming it for long. */
export async function waitForQueueMessage(
  match: (row: QueueRow) => boolean,
  timeoutMs = 15_000,
  queue = DISCORD_QUEUE
): Promise<QueueRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readQueue(queue, 1, 100);
    const found = rows.find(match);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await sleep(500);
  }
}

// ============================================================================
// Narrow casts for schema this branch adds
// ============================================================================

/**
 * Access to schema whose presence in the generated `Database` type depends on when somebody last ran
 * `npm run client-local`.
 *
 * `claim_discord_guild`, `reconcile_stuck_discord_memberships`, `discord_circuit_breakers`,
 * `discord_async_errors` and the two new `classes` columns arrive with this branch's migrations, and
 * `SupabaseTypes.d.ts` is generated from the database rather than from the migrations. So a spec that
 * used them through the typed client would compile or not depending on the state of a generated file
 * -- which is not a property a test should have. These two helpers work either way, and keeping the
 * casts to two named functions means there is one place to audit rather than an `as never` per call
 * site. Same escape hatch `discord-reconciler` and the metrics function use.
 */
export type UntypedResult<T> = { data: T | null; error: { message: string; code?: string } | null };

export function untypedRpc<T>(
  client: typeof supabase,
  fn: string,
  args: Record<string, unknown>
): Promise<UntypedResult<T>> {
  const loose = client as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => Promise<UntypedResult<T>>;
  };
  return loose.rpc(fn, args);
}

/** PostgREST access to a table (or column) the generated types do not know about yet. */
export function untypedTable(
  client: typeof supabase,
  table: string
): {
  select: (columns: string) => {
    eq: (column: string, value: unknown) => Promise<UntypedResult<Record<string, unknown>[]>>;
  };
  insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => Promise<UntypedResult<null>>;
  update: (values: Record<string, unknown>) => {
    eq: (column: string, value: unknown) => Promise<UntypedResult<null>>;
  };
  delete: () => {
    eq: (column: string, value: unknown) => Promise<UntypedResult<null>>;
    in: (column: string, values: unknown[]) => Promise<UntypedResult<null>>;
  };
} {
  return (
    client as unknown as {
      from: (name: string) => ReturnType<typeof untypedTable>;
    }
  ).from(table);
}
