/**
 * Manual verification recording for issue #604 / group error messages.
 *
 * Run (local only; skipped in CI unless env is set):
 *   LOCAL_GROUP_ERROR_DEMO=1 npx playwright test tests/e2e/group-create-errors.manual.spec.ts --project=chromium --headed
 *
 * Prerequisites: local Supabase + `npm run dev`, seeded DB with class 2.
 * DB setup: assignment 2 has allow_student_formed_groups=true,
 * group_formation_deadline in the future, demo student not in a Lab 1 group.
 */
import { expect, test } from "@playwright/test";

test.skip(!process.env.LOCAL_GROUP_ERROR_DEMO, "Set LOCAL_GROUP_ERROR_DEMO=1 to run this local Supabase + seed demo");

const STUDENT_EMAIL = "student-3909dcdc-d2c5-41cf-870f-2e963dc9b1e3-demo-demo@pawtograder.net";
const PASSWORD = "change-it";

test.describe.configure({ mode: "serial" });

test.use({ video: "on" });

test("group create: empty name + invalid name + success toasts (issue #604)", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/login");
  await page.getByLabel("Email:").fill(STUDENT_EMAIL);
  await page.getByLabel("Password:").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  // Server action redirects to "/" after successful login
  await page.waitForURL(/localhost:3000\/?$/, { timeout: 30_000 });

  await page.goto("/course/2/assignments/2");
  await page.getByRole("heading", { name: "Lab 1 (Group)" }).waitFor({ state: "visible", timeout: 30_000 });

  const createBtn = page.getByRole("button", { name: "Create a new group" });
  await createBtn.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Create a new group" })).toBeVisible();

  // 1) Empty name → edge function IllegalArgument (message now in toast title, not "Internal Server Error")
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/cannot be empty/i).first()).toBeVisible({ timeout: 15_000 });

  // 2) Invalid name (spaces) → edge function IllegalArgument
  await dialog.getByLabel(/Choose a name/).fill("bad group name");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/alphanumeric|hyphens|underscores/i).first()).toBeVisible({ timeout: 15_000 });

  // 3) Valid name → success (creates group + enqueues repo)
  const uniqueName = `e2egrp${Date.now().toString(36)}`;
  await dialog.getByLabel(/Choose a name/).clear();
  await dialog.getByLabel(/Choose a name/).fill(uniqueName);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Repositories created/i).first()).toBeVisible({ timeout: 90_000 });
});
