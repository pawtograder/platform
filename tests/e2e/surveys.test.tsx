import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser } from "./TestingUtils";

test.describe("Surveys Page", () => {
  test("student can see the surveys page header", async ({ page }) => {
    const course = await createClass();
    const [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Survey Student", useMagicLink: true }
    ]);

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);
    await expect(page.getByText("No Surveys Available")).toBeVisible();
  });
});
