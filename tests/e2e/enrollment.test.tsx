import { Course } from "@/utils/supabase/DatabaseTypes";
import percySnapshot from "@percy/playwright";
import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import { createClass, createUserInClass, loginAsUser, TestingUser } from "./TestingUtils";
import { random } from "mathjs";
dotenv.config({ path: ".env.local" });

let course: Course;
let student1: TestingUser | undefined;
let instructor1: TestingUser | undefined;

const student2Name = `${"Student".charAt(0).toUpperCase()}${"student".slice(1)} #${random()}studentTest`;
const student2Email = `$student-${random()}-${random()}student@pawtograder.net`;
const graderName = `${"Grader".charAt(0).toUpperCase()}${"grader".slice(1)} #${random()}graderTest`;
const graderEmail = `$grader-${random()}-${random()}grader@pawtograder.net`;
const instructor2Name = `${"Instructor".charAt(0).toUpperCase()}${"instructor".slice(1)} #${random()}instructorTest`;
const instructor2Email = `$instructor-${random()}-${random()}instructor@pawtograder.net`;

test.beforeAll(async () => {
  course = await createClass();
  student1 = await createUserInClass({
    role: "student",
    class_id: course.id
  });
  instructor1 = await createUserInClass({
    role: "instructor",
    class_id: course.id
  });
});

test.describe("Enrollments Page", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor1!, course);
    await page.getByRole("group").filter({ hasText: "Course Settings" }).locator("div").click();
    await expect(page.getByRole("menuitem", { name: "Enrollments" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Enrollments" }).click();
  });
  test("Instructors can view enrollments", async ({ page }) => {
    // Check Enrollments Page Contents
    await percySnapshot(page, "Enrollments Page");
    await expect(page.getByRole("heading", { name: "Enrollments" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Canvas Links" })).toBeVisible();
    await expect(
      page.getByText("Enrollments in this course are linked to the following Canvas sections:")
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync Canvas Enrollments" })).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Name" }).first()).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Email" }).first()).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Role" }).first()).toBeVisible();
    await expect(
      page.locator("th.chakra-table__columnHeader").filter({ hasText: "GitHub Username" }).first()
    ).toBeVisible();
    await expect(
      page.locator("th.chakra-table__columnHeader").filter({ hasText: "Canvas Link" }).first()
    ).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Tags" }).first()).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Actions" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Course Member" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import from CSV" })).toBeVisible();
    const student1EmailCell = await page.locator("td.chakra-table__cell").filter({ hasText: student1?.email }).first();
    await expect(student1EmailCell).toBeVisible();
    const student1NameCell = await page
      .locator("td.chakra-table__cell")
      .filter({ hasText: student1?.private_profile_name })
      .first();
    await expect(student1NameCell.getByText(student1?.private_profile_name ?? "")).toBeVisible();
    const student1RoleCell = await page.locator("td.chakra-table__cell").filter({ hasText: "Student" }).first();
    await expect(student1RoleCell.getByText("Student")).toBeVisible();
    const instructor1EmailCell = await page
      .locator("td.chakra-table__cell")
      .filter({ hasText: instructor1?.email })
      .first();
    await expect(instructor1EmailCell).toBeVisible();
    const instructor1NameCell = await page
      .locator("td.chakra-table__cell")
      .filter({ hasText: instructor1?.private_profile_name })
      .first();
    await expect(instructor1NameCell.getByText(instructor1?.private_profile_name ?? "")).toBeVisible();
    const instructor1RoleCell = await page.locator("td.chakra-table__cell").filter({ hasText: "Instructor" }).first();
    await expect(instructor1RoleCell.getByText("Instructor")).toBeVisible();
  });

  test("Instructors can add individual course members", async ({ page }) => {
    // Test Add Course Member Dialog With Student Role
    await page.getByRole("button", { name: "Add Course Member" }).click();
    await expect(page.getByLabel("Add Course Member Dialog")).toBeVisible();
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await expect(page.getByPlaceholder("Name")).toBeVisible();
    await expect(page.locator('select[name="role"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
    await page.getByPlaceholder("Email").fill(student2Email);
    await page.getByPlaceholder("Name").fill(student2Name);
    await page.locator('select[name="role"]').selectOption("student");
    await page.getByRole("button", { name: "Add" }).click();
    const student2EmailCell = await page.locator("td.chakra-table__cell").filter({ hasText: student2Email }).first();
    await expect(student2EmailCell).toBeVisible();
    const student2NameCell = await page.locator("td.chakra-table__cell").filter({ hasText: student2Name }).first();
    await expect(student2NameCell).toBeVisible();
    const student2RoleCell = await page.locator("td.chakra-table__cell").filter({ hasText: "Student" }).first();
    await expect(student2RoleCell).toBeVisible();

    // Test Add Course Member Dialog With Grader Role
    await page.getByRole("button", { name: "Add Course Member" }).click();
    await expect(page.getByLabel("Add Course Member Dialog")).toBeVisible();
    await page.getByPlaceholder("Email").fill(graderEmail);
    await page.getByPlaceholder("Name").fill(graderName);
    await page.locator('select[name="role"]').selectOption("grader");
    await page.getByRole("button", { name: "Add" }).click();
    const graderEmailCell = await page.locator("td.chakra-table__cell").filter({ hasText: graderEmail }).first();
    await expect(graderEmailCell).toBeVisible();
    const graderNameCell = await page.locator("td.chakra-table__cell").filter({ hasText: graderName }).first();
    await expect(graderNameCell).toBeVisible();
    const graderRoleCell = await page.locator("td.chakra-table__cell").filter({ hasText: "Grader" }).first();
    await expect(graderRoleCell).toBeVisible();

    // Test Add Course Member Dialog With Instructor Role
    await page.getByRole("button", { name: "Add Course Member" }).click();
    await expect(page.getByLabel("Add Course Member Dialog")).toBeVisible();
    await page.getByPlaceholder("Email").fill(instructor2Email);
    await page.getByPlaceholder("Name").fill(instructor2Name);
    await page.locator('select[name="role"]').selectOption("instructor");
    await page.getByRole("button", { name: "Add" }).click();
    const instructor2EmailCell = await page
      .locator("td.chakra-table__cell")
      .filter({ hasText: instructor2Email })
      .first();
    await expect(instructor2EmailCell).toBeVisible();
    const instructor2NameCell = await page
      .locator("td.chakra-table__cell")
      .filter({ hasText: instructor2Name })
      .first();
    await expect(instructor2NameCell).toBeVisible();
    const instructor2RoleCell = await page.locator("td.chakra-table__cell").filter({ hasText: "Instructor" }).first();
    await expect(instructor2RoleCell).toBeVisible();
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  test.skip("Instructors can add course members from CSV", async ({ page }) => {
    // TODO: Need a dummy test CSV file and a way to account for the different file pickers on different OS.
  });
});
