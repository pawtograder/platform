import { Course } from "@/utils/supabase/DatabaseTypes";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase, TestingUser } from "../TestingUtils";
import { captureTunnel, payloadJsonOf, type TunnelCapture } from "./index";

/**
 * G2 (spec §7.3, ADR 3), PR tier: a report says who filed it by role only. Reports from a
 * student, a grader, and an instructor on course routes carry their `role` and the `class_id`;
 * a report from an admin route carries `role: "admin"` and no `class_id`. No envelope sent while
 * filing any of them contains the reporter's email or name.
 *
 * `captureTunnel` answers `/api/tunnel` itself, so nothing reaches Sentry. Admin pages have no
 * user menu, so the admin report goes through the other entry point there: "Report this" on an
 * error toast, forced by failing the request the page loads its data with.
 */

type FeedbackEvent = {
  tags?: Record<string, string>;
  user?: Record<string, unknown>;
  contexts: { feedback: Record<string, unknown> };
};

const decoder = new TextDecoder();
const feedbackOf = (t: TunnelCapture) => t.items("feedback").map((i) => payloadJsonOf<FeedbackEvent>(i)!);

let course: Course;
let adminHome: Course;
let student: TestingUser;
let grader: TestingUser;
let instructor: TestingUser;
let admin: TestingUser;

test.beforeAll(async () => {
  course = await createClass({ name: "E2E Bug Report Roles" });
  adminHome = await createClass({ name: "E2E Bug Report Admin Home" });
  [student, grader, instructor] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Rolecheck Student", useMagicLink: true },
    { role: "grader", class_id: course.id, name: "Rolecheck Grader", useMagicLink: true },
    { role: "instructor", class_id: course.id, name: "Rolecheck Instructor", useMagicLink: true }
  ]);
  // A platform admin holds the `admin` role in some class (see admin-create-class.test.tsx).
  [admin] = await createUsersInClass([
    { role: "instructor", class_id: adminHome.id, name: "Rolecheck Admin", useMagicLink: true }
  ]);
  const { error } = await supabase
    .from("user_roles")
    .update({ role: "admin" })
    .eq("user_id", admin.user_id)
    .eq("class_id", adminHome.id);
  if (error) throw new Error(`Failed to promote admin: ${error.message}`);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, grader, instructor, admin]);
});

async function submitFrom(dialog: Locator, message: string) {
  await dialog.getByRole("textbox", { name: /What happened/ }).fill(message);
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();
}

async function reportFromUserMenu(page: Page, message: string) {
  await page.getByRole("button", { name: "Support & Documentation" }).click();
  await page.getByRole("menuitem", { name: "Report a bug" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a bug" });
  await expect(dialog).toBeVisible();
  await submitFrom(dialog, message);
}

/** Every envelope sent while filing the report: none may name the reporter. */
function assertNoIdentity(tunnel: TunnelCapture, user: TestingUser) {
  const needles = [user.email, user.private_profile_name, user.public_profile_name].map((s) => s.toLowerCase());
  expect(tunnel.envelopes.length).toBeGreaterThan(0);
  const offenders = tunnel.envelopes.flatMap((e) => {
    const text = decoder.decode(e.raw).toLowerCase();
    return needles.filter((n) => text.includes(n)).map((n) => `${JSON.stringify(e.header)} contains ${n}`);
  });
  expect(offenders).toEqual([]);
}

function assertIdOnly(feedback: FeedbackEvent) {
  expect(feedback.user).toEqual({ id: expect.any(String), ip_address: null });
  expect(feedback.contexts.feedback.contact_email).toBeUndefined();
  expect(feedback.contexts.feedback.name).toBeUndefined();
}

test.describe("G2: reports carry the reporter's role, and the class only on course routes", () => {
  for (const [role, user] of [
    ["student", () => student],
    ["grader", () => grader],
    ["instructor", () => instructor]
  ] as const) {
    test(`${role} on a course route: role ${role}, class_id set`, async ({ page }) => {
      const tunnel = await captureTunnel(page);
      await loginAsUser(page, user(), course);
      await expect(page.locator("#main-content")).toBeVisible();
      await reportFromUserMenu(page, `G2 ${role} report`);

      const feedback = feedbackOf(tunnel);
      expect(feedback).toHaveLength(1);
      expect(feedback[0].contexts.feedback.message).toBe(`G2 ${role} report`);
      expect(feedback[0].tags?.role).toBe(role);
      expect(feedback[0].tags?.class_id).toBe(String(course.id));
      expect(feedback[0].tags?.route).toMatch(/^\/course\/\[course_id\]/);
      expect(feedback[0].user?.id).toBe(user().user_id);
      assertIdOnly(feedback[0]);
      assertNoIdentity(tunnel, user());
    });
  }

  test("admin on an admin route: role admin, no class_id", async ({ page }) => {
    const tunnel = await captureTunnel(page);
    await loginAsUser(page, admin);
    // The page loads its setting from system_settings on mount; failing that request shows an
    // error toast, which carries "Report this".
    await page.route(
      (url) => url.pathname.endsWith("/rest/v1/system_settings"),
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ code: "XX000", message: "E2E forced failure", details: null, hint: null })
        })
    );
    await page.goto("/admin/signup-welcome");
    // The visual-test stylesheet hides the toaster; this test clicks in it.
    await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests"));
    const toast = page.getByRole("status").filter({ hasText: "Failed to load welcome message" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Report this" }).click();
    const dialog = page.getByRole("dialog", { name: "Report a bug" });
    await expect(dialog).toBeVisible();
    await submitFrom(dialog, "G2 admin report");

    const feedback = feedbackOf(tunnel);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].contexts.feedback.message).toBe("G2 admin report");
    expect(feedback[0].tags?.role).toBe("admin");
    expect(feedback[0].tags).not.toHaveProperty("class_id");
    expect(feedback[0].tags?.route).toBe("/admin/signup-welcome");
    // No user ID here: the admin layout doesn't mount AuthStateProvider, so nothing calls
    // Sentry.setUser on admin pages (as on origin/staging). The report still names no one.
    expect(feedback[0].user ?? {}).not.toHaveProperty("email");
    expect(feedback[0].user ?? {}).not.toHaveProperty("username");
    expect(feedback[0].contexts.feedback.contact_email).toBeUndefined();
    expect(feedback[0].contexts.feedback.name).toBeUndefined();
    assertNoIdentity(tunnel, admin);
  });
});
