import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";

test.setTimeout(120_000);

// adminHome is where the admin holds their global admin role; targetCourse is a different
// course the admin has NO role in (so entering it must provision an instructor enrollment).
let adminHome: Course;
let targetCourse: Course;
let admin: TestingUser;
let student: TestingUser;

test.beforeAll(async () => {
  adminHome = (await createClass({ name: "Admin Home Course" })) as Course;
  targetCourse = (await createClass({ name: "Act As Instructor Target" })) as Course;

  [admin] = await createUsersInClass([
    { role: "instructor", class_id: adminHome.id, name: "Acting Admin", useMagicLink: true }
  ]);
  const { error } = await supabase
    .from("user_roles")
    .update({ role: "admin" })
    .eq("user_id", admin.user_id)
    .eq("class_id", adminHome.id);
  if (error) throw new Error(`Failed to promote admin: ${error.message}`);

  [student] = await createUsersInClass([
    { role: "student", class_id: targetCourse.id, name: "Plain Student", useMagicLink: true }
  ]);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([admin, student]);
});

test.describe("Admin acts as instructor", () => {
  test.describe.configure({ mode: "serial" });

  test("admin enters an un-enrolled course and sees the instructor surface", async ({ page }) => {
    await loginAsUser(page, admin);
    await page.goto("/admin");

    // Use the quick course picker on the dashboard. The picker's "Manage as instructor"
    // button is the one immediately following its course <select>.
    const pickerSelect = page.getByLabel("Select a course to manage as instructor");
    await pickerSelect.selectOption(String(targetCourse.id));
    await pickerSelect.locator("xpath=following::button[1]").click();

    await expect(page).toHaveURL(new RegExp(`/course/${targetCourse.id}/manage`), { timeout: 20_000 });
    // No "no access" screen.
    await expect(page.getByText(/don.t have access to this course/i)).toHaveCount(0);
    // Admin-viewing banner is shown across the manage area.
    await expect(page.getByTestId("admin-viewing-banner")).toBeVisible();

    // An instructor-only page loads (gradebook).
    await page.goto(`/course/${targetCourse.id}/manage/gradebook`);
    await expect(page.getByText(/don.t have access to this course/i)).toHaveCount(0);
    await expect(page.getByTestId("admin-viewing-banner")).toBeVisible();

    // The provisioning created exactly one active instructor role for the admin.
    const { data: roles } = await supabase
      .from("user_roles")
      .select("id,role,disabled")
      .eq("user_id", admin.user_id)
      .eq("class_id", targetCourse.id)
      .eq("disabled", false);
    expect(roles?.length).toBe(1);
    expect(roles?.[0].role).toBe("instructor");
  });

  test("admin_enter_course_as_instructor is idempotent on repeat entry", async () => {
    const freshCourse = (await createClass({ name: "Idempotency Target" })) as Course;
    const adminClient = await createAuthenticatedClient(admin);

    const first = await adminClient.rpc("admin_enter_course_as_instructor", { p_class_id: freshCourse.id });
    expect(first.error).toBeNull();
    const second = await adminClient.rpc("admin_enter_course_as_instructor", { p_class_id: freshCourse.id });
    expect(second.error).toBeNull();

    const { data: roles } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", admin.user_id)
      .eq("class_id", freshCourse.id)
      .eq("disabled", false);
    expect(roles?.length).toBe(1);
  });

  test("non-admin is redirected away from the admin portal", async ({ page }) => {
    await loginAsUser(page, student, targetCourse);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/course(\/|$)/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Admin Portal" })).toHaveCount(0);
  });
});
