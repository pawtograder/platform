/**
 * The install round-trip, driven through a browser.
 *
 * What this exists to prove is one property: the guild a class ends up claiming comes from the OAuth
 * authorization code, not from the `guild_id` query parameter on the callback.
 *
 * That distinction is the whole security argument for the flow. One bot token serves every course on
 * a deployment, so "the bot can see this guild" is true of every guild any course has ever connected
 * -- which means the bot-token check alone would let an instructor who legitimately started an
 * install redirect themselves to a callback naming somebody else's server and claim it. Only the
 * authorization code ties the callback to the consent screen that was actually completed.
 *
 * Discord's consent screen is on discord.com and is deliberately NOT redirected at the mock (it is a
 * user-facing page, not a REST call). So the consent step is intercepted in the browser: the route
 * handler below reads the real `state` Pawtograder minted, mints a code against the mock for whatever
 * guild the scenario wants, and redirects to the callback the way Discord would. Everything after
 * that -- state verification, the nonce cookie, the token exchange, the bot-token lookup, the claim
 * RPC -- is the real code path.
 */
import { expect, test } from "@playwright/test";
import { createClass, createUserInClass, getTestRunPrefix, loginAsUser, supabase } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import {
  discordApiIsMocked,
  discordMockReachable,
  randomGuildId,
  releaseDiscordMockLock,
  takeDiscordMock,
  untypedTable
} from "@/tests/e2e/discordMockUtils";
import { setState } from "@/tests/mocks/discord/client";

const MOCK_URL = process.env.DISCORD_MOCK_URL ?? "http://127.0.0.1:8788";

/** Ask the mock for an authorization code standing in for a completed consent screen. */
async function mintCode(guildId: string | null): Promise<string> {
  const response = await fetch(`${MOCK_URL}/__mock/oauth-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guild_id: guildId })
  });
  expect(response.ok, `minting an oauth code failed: HTTP ${response.status}`).toBe(true);
  return ((await response.json()) as { code: string }).code;
}

test.describe("Discord install flow: the claimed guild comes from the authorization code", () => {
  test.describe.configure({ timeout: 180_000 });

  // Chromium only, and not because of a browser quirk worth working around.
  //
  // The install nonce cookie is set `Secure`, which is correct: it is a single-use capability and
  // must not travel in clear text. Chromium treats http://localhost as a trustworthy origin and so
  // sends Secure cookies to it; WebKit does not -- it stores the cookie (it is visible in
  // `context.cookies()`) but will not transmit it over http. The callback then sees no nonce and
  // correctly refuses with "already been used or was not started here", which is the right behaviour
  // for a missing nonce and useless as a test of the code exchange.
  //
  // The local and CI harnesses both serve the app over http, so the alternative would be dropping
  // `Secure` from a security-relevant cookie to suit a test. Everything under test here is
  // browser-independent server-side logic, so one engine is sufficient coverage.
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "the Secure install-nonce cookie is not sent over http by non-Chromium engines"
  );

  const RUN = getTestRunPrefix();
  const SAFE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /** The guild the instructor really authorizes. */
  const AUTHORIZED_GUILD = randomGuildId();
  /** A guild the bot is also in, which the callback will be told about and must ignore. */
  const OTHER_GUILD = randomGuildId();

  let classId: number;
  let instructor: TestingUser;
  let held = false;

  const classes = () => untypedTable(supabase, "classes");

  test.beforeAll(async () => {
    if (!((await discordMockReachable()) && discordApiIsMocked())) return;
    // Held for the whole file: setState below replaces the mock's world, and another spec driving it
    // concurrently would rewrite these two guilds out from under the assertions. `held` is set only
    // after acquisition so afterAll cannot release a lock this file never took.
    await takeDiscordMock();
    held = true;
    // Both guilds exist and the bot is in both, so the bot-token check cannot be what distinguishes
    // them. Only the code can.
    await setState({
      guilds: {
        [AUTHORIZED_GUILD]: {
          id: AUTHORIZED_GUILD,
          name: "Authorized Server",
          owner_id: "9000000000000000001",
          bot_in_guild: true,
          bot_roles: [],
          roles: [{ id: AUTHORIZED_GUILD, name: "@everyone", position: 0, permissions: "0" }],
          members: {},
          channels: []
        },
        [OTHER_GUILD]: {
          id: OTHER_GUILD,
          name: "Someone Else's Server",
          owner_id: "9000000000000000002",
          bot_in_guild: true,
          bot_roles: [],
          roles: [{ id: OTHER_GUILD, name: "@everyone", position: 0, permissions: "0" }],
          members: {},
          channels: []
        }
      }
    });

    const cls = await createClass({ name: `E2E DiscordInstall ${RUN}` });
    classId = cls.id;
    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `DiscordInstall Instructor ${RUN}`,
      email: `e2e-dinstall-instr-${SAFE}@pawtograder.net`
    });
  });

  test.afterAll(async () => {
    if (classId) await supabase.from("classes").update({ discord_server_id: null }).eq("id", classId);
    if (held) releaseDiscordMockLock();
  });

  /**
   * Start an install and return the `state` Pawtograder minted, without following the redirect to
   * discord.com.
   *
   * Intercepting the consent screen in the browser was the obvious approach and does not work here:
   * the sandbox routes browser traffic through a proxy, so `page.route` on discord.com never fires
   * and the navigation reaches the real login page. Reading the `Location` header instead is both
   * more reliable and closer to what is being tested -- the consent screen is Discord's UI, and
   * nothing in this repo is responsible for it. `page.request` shares the browser context's cookie
   * jar, so the nonce cookie this response sets is the one the later navigation sends back.
   */
  async function startInstall(page: import("@playwright/test").Page): Promise<string> {
    const response = await page.request.get(`/api/discord/install?class_id=${classId}`, { maxRedirects: 0 });
    expect(response.status(), "install should redirect to Discord").toBe(302);
    const location = response.headers()["location"];
    expect(location, "no Location header on the install redirect").toBeTruthy();
    const authorize = new URL(location);
    expect(authorize.hostname, "the consent screen must stay on discord.com").toBe("discord.com");
    // The install URL's own contract, worth pinning here because the exchange depends on all three.
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/discord/install/callback");
    const state = authorize.searchParams.get("state");
    expect(state, "no state on the authorize URL").toBeTruthy();
    return state as string;
  }

  function callbackUrl(code: string, state: string, guildIdParam: string): string {
    const url = new URL("http://localhost:3001/api/discord/install/callback");
    url.searchParams.set("code", code);
    url.searchParams.set("state", state);
    url.searchParams.set("guild_id", guildIdParam);
    return url.toString();
  }

  test("a callback naming a different guild than the code still claims the code's guild", async ({ page }) => {
    test.skip(!held, "the Discord mock is not running or the deployment is not pointed at it");

    await loginAsUser(page, instructor);
    const state = await startInstall(page);

    // The code is bound to AUTHORIZED_GUILD; the redirect claims OTHER_GUILD. This is exactly the
    // forged callback the code exchange exists to defeat, and the bot is in BOTH guilds, so the
    // bot-token check cannot be what tells them apart.
    const code = await mintCode(AUTHORIZED_GUILD);
    await page.goto(callbackUrl(code, state, OTHER_GUILD));
    await page.waitForURL(new RegExp(`/course/${classId}/manage/discord`), { timeout: 60_000 });

    const { data } = await classes().select("discord_server_id").eq("id", classId);
    const stored = (data as { discord_server_id: string | null }[])[0]?.discord_server_id;
    expect(stored, "the class must hold the guild from the code, not the one in the query string").toBe(
      AUTHORIZED_GUILD
    );
    expect(stored).not.toBe(OTHER_GUILD);
  });

  test("a code carrying no bot grant claims nothing", async ({ page }) => {
    test.skip(!held, "the Discord mock is not running or the deployment is not pointed at it");

    await supabase.from("classes").update({ discord_server_id: null }).eq("id", classId);
    await loginAsUser(page, instructor);
    const state = await startInstall(page);

    // A consent screen finished without adding the bot anywhere, so Discord's token response names no
    // guild. Falling back to `guild_id` here is precisely the trust being removed.
    const code = await mintCode(null);
    await page.goto(callbackUrl(code, state, OTHER_GUILD));
    await page.waitForURL(new RegExp(`/course/${classId}/manage/discord`), { timeout: 60_000 });
    expect(page.url()).toContain("error");

    const { data } = await classes().select("discord_server_id").eq("id", classId);
    expect((data as { discord_server_id: string | null }[])[0]?.discord_server_id).toBeNull();
  });

  test("a code cannot be redeemed twice", async ({ page }) => {
    test.skip(!held, "the Discord mock is not running or the deployment is not pointed at it");

    await supabase.from("classes").update({ discord_server_id: null }).eq("id", classId);
    await loginAsUser(page, instructor);

    const state = await startInstall(page);
    const code = await mintCode(AUTHORIZED_GUILD);
    await page.goto(callbackUrl(code, state, AUTHORIZED_GUILD));
    await page.waitForURL(new RegExp(`/course/${classId}/manage/discord`), { timeout: 60_000 });
    const { data: first } = await classes().select("discord_server_id").eq("id", classId);
    expect((first as { discord_server_id: string | null }[])[0]?.discord_server_id).toBe(AUTHORIZED_GUILD);

    // Replaying the whole callback URL. Two independent things now refuse it -- the nonce cookie was
    // cleared by the first response, and the code is spent at Discord -- and either is sufficient.
    await supabase.from("classes").update({ discord_server_id: null }).eq("id", classId);
    await page.goto(callbackUrl(code, state, AUTHORIZED_GUILD));
    const { data: second } = await classes().select("discord_server_id").eq("id", classId);
    expect(
      (second as { discord_server_id: string | null }[])[0]?.discord_server_id,
      "a replayed callback must not re-claim"
    ).toBeNull();
  });
});
