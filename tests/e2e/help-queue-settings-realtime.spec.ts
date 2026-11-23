/**
 * Queue settings realtime updates (issue #1082).
 *
 * Bug: editing a help queue's name or description on
 * /course/<id>/manage/office-hours/settings/queues left the page showing the old
 * values until a reload, in the window that made the edit and in every other open
 * staff window. The page reads queues from the help_queues TableController, which
 * listens on help_queues:<class_id>, and does not refetch after a save. The
 * broadcast_help_queue_data_change() trigger stopped sending to that topic in
 * 20250929004834_realtime-broadcast-optimization.sql.
 *
 * The test opens the settings page in two windows: the instructor who edits, and a
 * grader who only watches. It edits the queue through the UI and asserts that both
 * windows show the new name and description without a reload.
 *
 * Chromium only (default project). Requires: local Supabase + `npm run dev` on
 * port 3000 (or BASE_URL for deployed E2E).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  createClass,
  createUserInClass,
  dismissTimeZonePreferenceModal,
  insertOfficeHoursQueue,
  loginAsUser
} from "./TestingUtils";
import type { TestingUser } from "./TestingUtils";

test.describe("Queue settings realtime (issue #1082)", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let instructor: TestingUser;
  let grader: TestingUser;
  let originalName: string;
  let editedName: string;
  let editedDescription: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Queue Settings RT ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Queue Settings Instructor ${suffix}`,
      email: `e2e-queue-settings-inst-${suffix}@pawtograder.net`
    });
    grader = await createUserInClass({
      role: "grader",
      class_id: classId,
      name: `E2E Queue Settings Grader ${suffix}`,
      email: `e2e-queue-settings-grader-${suffix}@pawtograder.net`
    });

    originalName = `RT Queue ${suffix}`;
    editedName = `RT Queue Renamed ${suffix}`;
    editedDescription = `Edited description ${suffix}`;
    await insertOfficeHoursQueue({ class_id: classId, name: originalName });
  });

  async function openQueueSettings(browser: Browser, user: TestingUser): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsUser(page, user);
    await page.goto(`/course/${classId}/manage/office-hours/settings/queues`, { waitUntil: "domcontentloaded" });
    await dismissTimeZonePreferenceModal(page, 10_000);
    await expect(page.getByRole("heading", { name: "Help Queue Management" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(originalName, { exact: true })).toBeVisible({ timeout: 30_000 });
    return page;
  }

  test("queue edits appear without a reload in the editing window and other staff windows", async ({
    browser,
    browserName
  }) => {
    test.skip(browserName !== "chromium", "Chromium only (matches the rest of the realtime UI e2e suite)");

    const editorPage = await openQueueSettings(browser, instructor);
    const observerPage = await openQueueSettings(browser, grader);

    // Wait for both windows to finish their realtime subscriptions. Without this, the
    // edit can commit before the channel is joined, and the test would fail for a
    // reason unrelated to the bug.
    for (const page of [editorPage, observerPage]) {
      await expect(page.getByText("Real-time updates disconnected")).toHaveCount(0, { timeout: 30_000 });
      await page.waitForLoadState("networkidle");
    }

    // The queue card is the innermost element that holds both the queue name and its
    // Edit button.
    const queueCard = editorPage
      .locator("div")
      .filter({ has: editorPage.getByText(originalName, { exact: true }) })
      .filter({ has: editorPage.getByRole("button", { name: "Edit" }) })
      .last();
    await queueCard.getByRole("button", { name: "Edit" }).click();

    const dialog = editorPage.getByRole("dialog", { name: "Edit Help Queue" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Queue Name").fill(editedName);
    await dialog.getByLabel("Description").fill(editedDescription);
    await dialog.getByRole("button", { name: "Update Queue" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // No reload anywhere below. Both windows must pick up the change from realtime.
    for (const page of [editorPage, observerPage]) {
      await expect(page.getByText(editedName, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(editedDescription, { exact: true })).toBeVisible();
      await expect(page.getByText(originalName, { exact: true })).toHaveCount(0);
    }

    await editorPage.context().close();
    await observerPage.context().close();
  });
});
