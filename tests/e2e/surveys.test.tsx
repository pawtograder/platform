import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

test.describe("Surveys Page", () => {
  test("student sees empty state when no surveys exist", async ({ page }) => {
    const course = await createClass();
    const [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Survey Student", useMagicLink: true }
    ]);

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "No Surveys Available" })).toBeVisible();
    await expect(page.getByText("There are no published surveys available for this course at this time.")).toBeVisible();
  });

  test("student sees published survey and updated status", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Survey Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: "Playwright Survey",
      description: "Quick check-in",
      status: "published",
      deleted_at: null,
      assigned_to_all: true,
      allow_response_editing: false,
      created_by: instructor.public_profile_id,
      json: {},
      version: 1
    });

    if (error) {
      throw new Error(`Failed to seed survey: ${error.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "Course Surveys" })).toBeVisible();
    await expect(page.getByText("Playwright Survey")).toBeVisible();
    await expect(page.getByText("Quick check-in")).toBeVisible();
    await expect(page.locator("span.chakra-badge", { hasText: "Not Started" })).toBeVisible();
    await expect(page.getByText("No Surveys Available")).not.toBeVisible();
  });
});
