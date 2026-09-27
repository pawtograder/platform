import { Course } from "@/utils/supabase/DatabaseTypes";
import dotenv from "dotenv";
import { test, expect } from "../global-setup";
import {
  createClass,
  createClassWithSISSections,
  createUsersInClass,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
dotenv.config({ path: ".env.local", quiet: true });

let course: Course;
let instructor: TestingUser | undefined;
let grader: TestingUser | undefined;
let classSectionIds: number[] = [];

// createClassWithSISSections names its rows `SIS Class Section <crn>`. 30001 is not a
// substring of 30002's name, so the row filters below are unambiguous.
const originalName = "SIS Class Section 30001";
const untouchedName = "SIS Class Section 30002";
const renamedName = "30001 - MWF 9:15am-10:20am (Doe)";

test.beforeAll(async () => {
  course = await createClass();
  [instructor, grader] = await createUsersInClass([
    {
      name: "Class Sections Instructor",
      email: "class-sections-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Class Sections Grader",
      email: "class-sections-grader@pawtograder.net",
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  const { classSections } = await createClassWithSISSections({
    class_id: course.id,
    class_section_crns: [30001, 30002],
    lab_section_crns: []
  });
  classSectionIds = classSections.map((section) => section.id);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor!, grader!]);
});

test.describe("Class Sections Page", () => {
  test.describe.configure({ mode: "serial" });

  test("Instructors reach the page from the Course Settings menu and rename a section", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.getByRole("button", { name: "Course Settings menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Class Sections" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Class Sections" }).click();

    await expect(page.getByRole("heading", { name: "Class Sections" })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: originalName });
    await expect(row).toBeVisible();
    // The CRN is shown so an instructor can tell identically-scheduled sections apart.
    await expect(row.getByText("30001", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: `Rename ${originalName}` }).click();
    await expect(page.getByText("Rename Class Section")).toBeVisible();

    const nameField = page.getByPlaceholder("e.g., 3500 - MWF 9:15am-10:20am (Doe)");
    await expect(nameField).toHaveValue(originalName);
    await nameField.fill(renamedName);
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Rename Class Section")).toBeHidden();
    await expect(page.getByRole("row").filter({ hasText: renamedName })).toBeVisible();

    // The rename is persisted through the RPC, not just optimistic local state.
    const { data } = await supabase.from("class_sections").select("name").eq("id", classSectionIds[0]).single();
    expect(data?.name).toBe(renamedName);
  });

  test("The rename survives a reload and leaves the other section alone", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/course/class-sections`);

    await expect(page.getByRole("row").filter({ hasText: renamedName })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: untouchedName })).toBeVisible();
  });

  test("Saving without editing closes the dialog without writing", async ({ page }) => {
    const before = await supabase
      .from("class_sections")
      .select("name, updated_at")
      .eq("id", classSectionIds[1])
      .single();

    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/course/class-sections`);

    const row = page.getByRole("row").filter({ hasText: untouchedName });
    await row.getByRole("button", { name: `Rename ${untouchedName}` }).click();
    await expect(page.getByText("Rename Class Section")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Rename Class Section")).toBeHidden();
    await expect(page.getByText("Error renaming class section")).toBeHidden();

    // No write means no updated_at bump, so nothing broadcasts for a no-op save.
    const after = await supabase
      .from("class_sections")
      .select("name, updated_at")
      .eq("id", classSectionIds[1])
      .single();
    expect(after.data?.name).toBe(before.data?.name);
    expect(after.data?.updated_at).toBe(before.data?.updated_at);
  });

  test("A name longer than the 100-character limit is rejected in the form", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/course/class-sections`);

    const row = page.getByRole("row").filter({ hasText: untouchedName });
    await row.getByRole("button", { name: `Rename ${untouchedName}` }).click();
    await page.getByPlaceholder("e.g., 3500 - MWF 9:15am-10:20am (Doe)").fill("x".repeat(101));
    await page.getByRole("button", { name: "Save" }).click();

    // The form catches it, so the RPC bound is never reached and the dialog stays open.
    await expect(page.getByText("Name must be 100 characters or fewer")).toBeVisible();
    await expect(page.getByText("Rename Class Section")).toBeVisible();

    const { data } = await supabase.from("class_sections").select("name").eq("id", classSectionIds[1]).single();
    expect(data?.name).toBe(untouchedName);
  });

  test("Sortable column headers are operable from the keyboard (WCAG 2.1.1)", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/course/class-sections`);

    // The sort control must be a real button, not a Text with an onClick. Sort on
    // Name rather than CRN: TanStack sorts string columns ascending-first but
    // number columns descending-first, and asc-then-desc is the clearer assertion.
    const sortButton = page.getByRole("button", { name: /^Name/ });
    await expect(sortButton).toBeVisible();

    // Unsorted to begin with, so the attribute is absent rather than "none".
    // This also pins scope="col": without it Chromium exposes the <th> as a
    // generic cell, there is no columnheader to find, and aria-sort is ignored.
    const header = page.getByRole("columnheader").filter({ hasText: "Name" });
    await expect(header).not.toHaveAttribute("aria-sort");

    await sortButton.focus();
    await expect(sortButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-sort", "ascending");

    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-sort", "descending");
  });

  test("Graders see the sections but cannot rename them", async ({ page }) => {
    await loginAsUser(page, grader!, course);
    await page.goto(`/course/${course.id}/manage/course/class-sections`);

    const row = page.getByRole("row").filter({ hasText: renamedName });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: `Rename ${renamedName}` })).toBeDisabled();
  });
});
