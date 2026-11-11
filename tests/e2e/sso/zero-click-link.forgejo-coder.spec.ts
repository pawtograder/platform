import { test, expect, type Frame, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { createClass, createUserInClass, loginAsUser, type TestingUser } from "../TestingUtils";

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, ".forgejo-coder-e2e.json"), "utf8")) as {
  pawtograderBaseUrl: string;
  forgejoBaseUrl: string;
  coderBaseUrl: string;
};
const PROVIDER = "forgejo";
const FORGEJO_ADMIN = "Basic " + Buffer.from("forgejo-admin:forgejo-e2e-admin-pw").toString("base64");

function linkUrl(returnTo: string) {
  const linkStart = `/external-auth/${PROVIDER}/callback?redirect=${encodeURIComponent(returnTo)}`;
  return `${cfg.coderBaseUrl}/api/v2/users/oidc/callback?redirect=${encodeURIComponent(linkStart)}`;
}

async function settle(page: Page, start?: string) {
  const hops: string[] = [];
  const onNav = (f: Frame) => {
    if (f === page.mainFrame()) hops.push(f.url());
  };
  page.on("framenavigated", onNav);
  if (start) await page.goto(start);
  let last = "";
  for (let stable = 0; stable < 4; ) {
    await page.waitForTimeout(1000);
    const now = page.url();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  page.off("framenavigated", onNav);
  const text = (
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  )
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return { hops, final: page.url(), text };
}

async function linked(page: Page) {
  const res = await page.request.get(`${cfg.coderBaseUrl}/api/v2/external-auth/${PROVIDER}`);
  return ((await res.json()) as { authenticated: boolean }).authenticated;
}

async function forgejoUserId(user: TestingUser) {
  const q = new URLSearchParams({ source_id: "1", login_name: user.user_id });
  const res = await fetch(`${cfg.forgejoBaseUrl}/api/v1/admin/users?${q}`, {
    headers: { Authorization: FORGEJO_ADMIN }
  });
  const users = (await res.json()) as { id: number }[];
  expect(users).toHaveLength(1);
  return users[0].id;
}

function report(name: string, r: unknown) {
  console.log(`\n### ${name}\n${JSON.stringify(r, null, 2)}`);
}

const users: Record<string, TestingUser> = {};
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const klass = await createClass({ name: "Zero-click link probe" });
  users.noGrant = await createUserInClass({ role: "student", class_id: klass.id, name: "No Grant" });
  users.grant = await createUserInClass({ role: "student", class_id: klass.id, name: "Pre Granted" });
});

test("control: without a grant, the chain stops on Forgejo's Authorize screen", async ({ browser }) => {
  const page = await (await browser.newContext({ baseURL: cfg.pawtograderBaseUrl })).newPage();
  await loginAsUser(page, users.noGrant);
  const r = await settle(page, linkUrl("/"));
  report("no grant", r);
  expect(r.final.startsWith(`${cfg.forgejoBaseUrl}/login/oauth/authorize`)).toBe(true);
  expect(r.text).toContain('Authorize "Coder" to access your account?');
  expect(await linked(page)).toBe(false);
});

test("with a grant: one click in Pawtograder, the link happens in a popup, Pawtograder closes it", async ({
  browser
}) => {
  const user = users.grant;
  const context = await browser.newContext({ baseURL: cfg.pawtograderBaseUrl });
  const page = await context.newPage();
  await loginAsUser(page, user);

  const setup = await context.newPage();
  report(
    "forgejo sign-in (provisioning stand-in)",
    await settle(setup, `${cfg.forgejoBaseUrl}/user/oauth2/pawtograder`)
  );
  await setup.close();
  report("grant", execFileSync(process.env.GRANT_SCRIPT!, [String(await forgejoUserId(user))]).toString());

  // Open the popup synchronously, then navigate it: popup blockers reject a window.open after an await.
  await page.goto("/");
  const popupPromise = context.waitForEvent("page");
  await page.evaluate(() => {
    (window as unknown as { __link: Window | null }).__link = window.open("about:blank", "pawtograder-link");
  });
  const popup = await popupPromise;
  const hops: string[] = [];
  popup.on("framenavigated", (f) => f === popup.mainFrame() && hops.push(f.url()));
  await page.evaluate((u) => {
    (window as unknown as { __link: Window }).__link.location.href = u;
  }, linkUrl("/"));

  const t0 = Date.now();
  await expect.poll(() => linked(page), { timeout: 30_000, intervals: [500] }).toBe(true);
  const ms = Date.now() - t0;
  const where = popup.url();
  await page.evaluate(() => (window as unknown as { __link: Window }).__link.close());
  await expect.poll(() => popup.isClosed()).toBe(true);
  report("popup", { hops, endedAt: where, linkedAfterMs: ms, closedByOpener: popup.isClosed() });

  expect(hops.some((h) => h.startsWith(`${cfg.forgejoBaseUrl}/user/login`) && h === where)).toBe(false);
  expect(hops.some((h) => h.startsWith(`${cfg.forgejoBaseUrl}/login/oauth/authorize`))).toBe(false);
});
