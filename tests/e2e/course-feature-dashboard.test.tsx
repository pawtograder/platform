import type { TablesInsert } from "@/utils/supabase/SupabaseTypes";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, setCourseFeature, supabase } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

test.describe("Course dashboard feature flags", () => {
  test.describe.configure({ mode: "serial" });

  let course: Course;
  let student: User;
  let instructor: User;

  test.beforeAll(async () => {
    course = await createClass({ name: "Feature Flag Dashboard Course" });
    [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Feature Flag Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Feature Flag Instructor", useMagicLink: true }
    ]);

    const survey: TablesInsert<"surveys"> = {
      class_id: course.id,
      created_by: instructor.public_profile_id,
      assigned_to_all: true,
      allow_response_editing: false,
      json: {},
      version: 1,
      status: "published",
      title: "Flagged Dashboard Survey",
      description: "This survey should be hidden by the dashboard feature gate"
    };
    const { error } = await supabase.from("surveys").insert(survey);
    if (error) {
      throw new Error(`Failed to seed dashboard survey: ${error.message}`);
    }

    await setCourseFeature(course.id, COURSE_FEATURES.SURVEYS, false);
    await setCourseFeature(course.id, COURSE_FEATURES.DISCUSSION, false);
    await setCourseFeature(course.id, COURSE_FEATURES.OFFICE_HOURS, false);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student, instructor]);
  });

  test("student dashboard hides widgets and links for disabled features", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);

    await expect(page.getByRole("heading", { name: "Upcoming Assignments" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Active Surveys" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Office Hours" })).toHaveCount(0);
    await expect(page.getByText("Flagged Dashboard Survey")).toHaveCount(0);

    const quickLinks = page.getByRole("navigation", { name: "Jump to course section" });
    await expect(quickLinks.getByRole("link", { name: "Surveys" })).toHaveCount(0);
    await expect(quickLinks.getByRole("link", { name: "Office Hours" })).toHaveCount(0);
    await expect(quickLinks.getByRole("link", { name: "Discussion" })).toHaveCount(0);
  });

  test("staff dashboard hides widgets for disabled staff-facing features", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}`);

    await expect(page.getByRole("heading", { name: "Assignment Grading Overview" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Surveys" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Open Office Hours Requests" })).toHaveCount(0);
    await expect(page.getByText("Flagged Dashboard Survey")).toHaveCount(0);
  });
});
