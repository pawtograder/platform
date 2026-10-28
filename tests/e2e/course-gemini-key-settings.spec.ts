/**
 * #1126 Course Settings → Gemini API Key, in the browser. Synthetic keys only.
 *
 * Capture controls: traces, video and screenshots are off for this file (a trace records the
 * request body, which carries the key), no test logs a request body, and stored values are checked
 * through privileged boolean comparisons (courseGeminiKeyDb.ts). Network interception is used only
 * to delay or drop responses. The only request body it reads is a status request's course id (the
 * status RPC carries no key); save requests are never read or recorded.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";
import type { Page as PlaywrightCorePage } from "playwright-core";
import { expect, test } from "../global-setup";
import { GEMINI_KEY_FEATURE, credentialState, storedKeyEquals, syntheticKey } from "./courseGeminiKeyDb";
import {
  createClass,
  createUserInClass,
  loginAsUser,
  setCourseFeature,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.use({ trace: "off", video: "off", screenshot: "off" });

const keyPage = (courseId: number) => `/course/${courseId}/manage/course/gemini-api-key`;
const STATUS_RPC = "**/rest/v1/rpc/get_course_gemini_key_status";
const SET_RPC = "**/rest/v1/rpc/set_course_gemini_key";
const REMOVE_RPC = "**/rest/v1/rpc/remove_course_gemini_key";

async function openKeyPage(page: Page, courseId: number) {
  await page.goto(keyPage(courseId));
  await expect(page.getByTestId("gemini-key-page")).toBeVisible();
}

async function expectStatus(
  page: Page,
  setup: "Enabled" | "Disabled",
  key: "Configured (not validated)" | "Not configured"
) {
  await expect(page.getByTestId("gemini-key-setup")).toHaveText(setup);
  await expect(page.getByTestId("gemini-key-configured")).toHaveText(key);
}

async function expectInputCleared(page: Page) {
  expect(await page.getByTestId("gemini-key-input").inputValue()).toBe("");
}

async function confirmRemove(page: Page) {
  await page.getByTestId("gemini-key-remove").click();
  await page.getByRole("button", { name: "Confirm action" }).click();
}

/** True if any key containing the sentinel prefix appears in web storage or the URL. */
async function sentinelInBrowserState(page: Page): Promise<boolean> {
  const inStorage = await page.evaluate(() => {
    const dump = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`);
    return [...dump(window.localStorage), ...dump(window.sessionStorage)].some((e) => e.includes("PAWTO_SYNTH_"));
  });
  return inStorage || page.url().includes("PAWTO_SYNTH_");
}

test.describe("Course Settings: Gemini API key (#1126)", () => {
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;

  test.beforeEach(async () => {
    course = await createClass({ name: "Gemini Key Settings" });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  });

  test("save → refresh → replace → disable → remove, with the input cleared and nothing stored in the browser", async ({
    page
  }) => {
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await loginAsUser(page, instructor, course);
    await openKeyPage(page, course.id);
    await expectStatus(page, "Enabled", "Not configured");
    await expect(page.getByText(/does not check it with Google and does not turn on AI grading/)).toBeVisible();

    const s1 = syntheticKey();
    await page.getByTestId("gemini-key-input").fill(s1);
    await page.getByTestId("gemini-key-save").click();
    await expect(page.getByTestId("gemini-key-notice")).toContainText("Key saved");
    await expectStatus(page, "Enabled", "Configured (not validated)");
    await expectInputCleared(page);
    expect(await storedKeyEquals(course.id, s1), "S1 stored").toBe(true);

    await page.reload();
    await expectStatus(page, "Enabled", "Configured (not validated)");

    const s2 = syntheticKey();
    await page.getByTestId("gemini-key-input").fill(s2);
    await expect(page.getByTestId("gemini-key-save")).toHaveText("Replace key");
    // Keyboard submit.
    await page.getByTestId("gemini-key-input").press("Enter");
    await expect(page.getByTestId("gemini-key-notice")).toContainText("Key replaced");
    await expectInputCleared(page);
    expect(await storedKeyEquals(course.id, s2), "S2 stored").toBe(true);

    // Disable through the existing Feature flags page.
    await page.goto(`/course/${course.id}/manage/course/feature-flags`);
    const toggle = page.getByLabel("Enable Gemini API key setup for this course");
    await expect(toggle).toBeChecked();
    await toggle.click({ force: true });
    await expect(toggle).not.toBeChecked();
    // Wait for the flag to be persisted, not just toggled in the UI.
    await expect
      .poll(async () => {
        const { data } = await supabase.from("classes").select("features").eq("id", course.id).single();
        const features = (data?.features ?? []) as { name: string; enabled: unknown }[];
        return features.find((f) => f.name === GEMINI_KEY_FEATURE)?.enabled;
      })
      .toBe(false);

    await openKeyPage(page, course.id);
    await expectStatus(page, "Disabled", "Configured (not validated)");
    await expect(page.getByTestId("gemini-key-disabled-help")).toBeVisible();
    await expect(page.getByTestId("gemini-key-input")).toBeDisabled();
    await expect(page.getByTestId("gemini-key-save")).toBeDisabled();
    expect(await storedKeyEquals(course.id, s2), "key retained while disabled").toBe(true);

    await confirmRemove(page);
    await expect(page.getByTestId("gemini-key-notice")).toContainText("Key removed");
    await expectStatus(page, "Disabled", "Not configured");
    expect(await credentialState(course.id)).toMatchObject({ mappings: 0, secretsNamedForCourse: 0 });
    expect(await sentinelInBrowserState(page), "no key in web storage or URL").toBe(false);
  });

  test("a failed status read shows 'unavailable', never 'not configured'", async ({ page }) => {
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await loginAsUser(page, instructor, course);
    await page.route(STATUS_RPC, (route) => route.abort("failed"));
    await openKeyPage(page, course.id);
    await expect(page.getByTestId("gemini-key-unavailable")).toBeVisible();
    await expect(page.getByText("This does not mean no key is stored.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("gemini-key-configured")).toHaveCount(0);
    await expect(page.getByTestId("gemini-key-input")).toHaveCount(0);

    await page.unroute(STATUS_RPC);
    await page.getByRole("button", { name: "Retry" }).click();
    await expectStatus(page, "Enabled", "Not configured");
  });

  test("a committed save whose response is lost is not shown as a success", async ({ page }) => {
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await loginAsUser(page, instructor, course);
    await openKeyPage(page, course.id);

    let committedStatus = -1;
    await page.route(SET_RPC, async (route: Route) => {
      // Let the request reach the backend and commit, then drop the response so the browser never
      // sees it. The body is not read.
      const response = await route.fetch();
      committedStatus = response.status();
      await route.abort("failed");
    });
    const s1 = syntheticKey();
    await page.getByTestId("gemini-key-input").fill(s1);
    await page.getByTestId("gemini-key-save").click();

    await expect(page.getByTestId("gemini-key-notice")).toContainText(
      "couldn't confirm whether the change was applied"
    );
    expect(committedStatus, "backend answered 200 (committed)").toBe(200);
    expect(await storedKeyEquals(course.id, s1), "the save did commit").toBe(true);
    await expect(page.getByTestId("gemini-key-notice")).not.toContainText("Key saved");
    // Status was re-read from the server, without claiming which key is stored.
    await expectStatus(page, "Enabled", "Configured (not validated)");
    await expectInputCleared(page);
  });

  test("a committed removal whose response is lost is not shown as a success", async ({ page }) => {
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await loginAsUser(page, instructor, course);
    await openKeyPage(page, course.id);
    await page.getByTestId("gemini-key-input").fill(syntheticKey());
    await page.getByTestId("gemini-key-save").click();
    await expectStatus(page, "Enabled", "Configured (not validated)");

    let committedStatus = -1;
    await page.route(REMOVE_RPC, async (route: Route) => {
      const response = await route.fetch();
      committedStatus = response.status();
      await route.abort("failed");
    });
    await confirmRemove(page);
    await expect(page.getByTestId("gemini-key-notice")).toContainText(
      "couldn't confirm whether the change was applied"
    );
    expect(committedStatus).toBe(200);
    expect((await credentialState(course.id)).mappings, "removal committed").toBe(0);
    await expect(page.getByTestId("gemini-key-notice")).not.toContainText("Key removed");
    await expectStatus(page, "Enabled", "Not configured");
  });

  test("backend rejections show fixed messages and keep the stored key", async ({ page }) => {
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await loginAsUser(page, instructor, course);
    await openKeyPage(page, course.id);
    const kept = syntheticKey();
    await page.getByTestId("gemini-key-input").fill(kept);
    await page.getByTestId("gemini-key-save").click();
    await expectStatus(page, "Enabled", "Configured (not validated)");

    // Setup disabled by another instructor while this page is open: the backend refuses.
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, false);
    const rejected = syntheticKey();
    await page.getByTestId("gemini-key-input").fill(rejected);
    await page.getByTestId("gemini-key-save").click();
    await expect(page.getByTestId("gemini-key-notice")).toContainText("setup is disabled for this course");
    await expect(page.getByTestId("gemini-key-notice")).not.toContainText(rejected);
    await expectStatus(page, "Disabled", "Configured (not validated)");
    await expectInputCleared(page);
    expect(await storedKeyEquals(course.id, kept), "prior key kept").toBe(true);

    // Over-long key (the server rejects; the client does not pre-validate length).
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await page.reload();
    await page.getByTestId("gemini-key-input").fill(syntheticKey() + "x".repeat(4100));
    await page.getByTestId("gemini-key-save").click();
    await expect(page.getByTestId("gemini-key-notice")).toContainText("Nothing was changed");
    expect(await storedKeyEquals(course.id, kept), "prior key kept after invalid input").toBe(true);

    // Blank input cannot be submitted.
    await page.getByTestId("gemini-key-input").fill("   ");
    await expect(page.getByTestId("gemini-key-save")).toBeDisabled();
  });

  test("switching courses while a status read is pending shows the new course's status", async ({ page }) => {
    const other = await createClass({ name: "Gemini Key Settings Other" });
    // Same instructor in both courses; A: disabled + configured, B: enabled + not configured.
    await createUserInClass({ role: "instructor", class_id: other.id, email: instructor.email });
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await setCourseFeature(other.id, GEMINI_KEY_FEATURE, true);
    await loginAsUser(page, instructor, course);
    await openKeyPage(page, course.id);
    await page.getByTestId("gemini-key-input").fill(syntheticKey());
    await page.getByTestId("gemini-key-save").click();
    await expectStatus(page, "Enabled", "Configured (not validated)");
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, false);

    // Hold course A's next status response until course B has rendered.
    let releaseA: () => void = () => undefined;
    const aHeld = new Promise<void>((r) => (releaseA = r));
    let aIntercepted = false;
    await page.route(STATUS_RPC, async (route) => {
      const body = route.request().postDataJSON() as { p_class_id?: number };
      if (body?.p_class_id === course.id && !aIntercepted) {
        aIntercepted = true;
        const response = await route.fetch();
        await aHeld;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await page.reload();
    await expect.poll(() => aIntercepted).toBe(true);
    // Client-side navigation to course B (the course layout stays mounted).
    await page.evaluate(
      (url) => (window as unknown as { next: { router: { push(u: string): void } } }).next.router.push(url),
      keyPage(other.id)
    );
    await expect(page.getByTestId("gemini-key-page")).toHaveAttribute("data-course-id", String(other.id));
    await expectStatus(page, "Enabled", "Not configured");
    releaseA();
    await page.waitForTimeout(1000);
    await expectStatus(page, "Enabled", "Not configured");
    await page.unroute(STATUS_RPC);

    // A mutation from B's page targets B only.
    const kb = syntheticKey();
    await page.getByTestId("gemini-key-input").fill(kb);
    await page.getByTestId("gemini-key-save").click();
    await expect(page.getByTestId("gemini-key-notice")).toContainText("Key saved");
    expect(await storedKeyEquals(other.id, kb)).toBe(true);
    expect(await storedKeyEquals(course.id, kb), "course A not touched").toBe(false);
    expect((await credentialState(course.id)).mappings).toBe(1);
  });

  test("graders see no status and do not call the RPCs; students are redirected", async ({ page }) => {
    const grader = await createUserInClass({ role: "grader", class_id: course.id });
    const rpcCalls: string[] = [];
    page.on("request", (r) => {
      if (/\/rpc\/(get|set|remove)_course_gemini_key/.test(r.url())) rpcCalls.push(r.url());
    });
    await loginAsUser(page, grader, course);
    await page.goto(keyPage(course.id));
    await expect(page.getByText("Access denied. This page is only available to instructors.")).toBeVisible();
    await expect(page.getByTestId("gemini-key-status")).toHaveCount(0);
    expect(rpcCalls).toEqual([]);

    const student = await createUserInClass({ role: "student", class_id: course.id });
    await page.context().clearCookies();
    await loginAsUser(page, student, course);
    await page.goto(keyPage(course.id));
    await expect(page).not.toHaveURL(/gemini-api-key/);
  });

  test("the page has no axe violations and announces outcomes", async ({ page }) => {
    await setCourseFeature(course.id, GEMINI_KEY_FEATURE, true);
    await loginAsUser(page, instructor, course);
    await openKeyPage(page, course.id);
    await expectStatus(page, "Enabled", "Not configured");
    const results = await new AxeBuilder({ page: page as unknown as PlaywrightCorePage })
      .include('[data-testid="gemini-key-page"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    await expect(page.getByLabel("Gemini API key")).toHaveAttribute("type", "password");
    await expect(page.getByTestId("gemini-key-notice")).toHaveAttribute("aria-live", "polite");

    // Keyboard-only: focus the field, type, submit with Enter.
    await page.getByLabel("Gemini API key").focus();
    await page.keyboard.type(syntheticKey());
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("gemini-key-notice")).toContainText("Key saved");
    const after = await new AxeBuilder({ page: page as unknown as PlaywrightCorePage })
      .include('[data-testid="gemini-key-page"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(after.violations.map((v) => v.id)).toEqual([]);
  });
});
