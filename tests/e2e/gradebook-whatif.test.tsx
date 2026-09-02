import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import type { Page } from "@playwright/test";
import dotenv from "dotenv";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import {
  createAssignmentsAndGradebookColumns,
  createClass,
  createUsersInClass,
  loginAsUser,
  setCourseFeature,
  TestingUser
} from "./TestingUtils";
import { assertStudentPageAccessible } from "./axeStudentA11y";

dotenv.config({ path: ".env.local", quiet: true });

let course: Course;
let student: TestingUser;

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function getGradeCard(page: Page, gradeName: string) {
  return page.getByRole("article", { name: `Grade for ${gradeName}` });
}

async function gotoStudentGradebook(page: Page) {
  await loginAsUser(page, student, course);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(`/course/${course.id}/gradebook`, { waitUntil: "networkidle" });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }
  if (lastError) {
    throw lastError;
  }
  await expect(page.getByRole("region", { name: "Student Gradebook" })).toBeVisible();
  await assertStudentPageAccessible(page, "student gradebook what-if");
}

test.setTimeout(180_000);
test.describe("Gradebook What-If", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    course = await createClass({
      name: "Gradebook What If Course"
    });

    const users = await createUsersInClass([
      {
        name: "WhatIf Student",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    student = users[0];

    // The helper sets up assignment, manual, and calculated gradebook columns used by the what-if UI.
    await createAssignmentsAndGradebookColumns({
      class_id: course.id,
      numAssignments: 2,
      numManualGradedColumns: 0,
      manualGradedColumnSlugs: ["participation"],
      groupConfig: "individual"
    });

    await setCourseFeature(course.id, COURSE_FEATURES.GRADEBOOK_WHAT_IF, true);
  });

  test("enables editing for manual what-if cards", async ({ page }) => {
    await gotoStudentGradebook(page);

    const participationCard = getGradeCard(page, "Participation");
    await expect(participationCard).toBeVisible();

    const participationBefore = normalizeText(await participationCard.innerText());
    const targetValue = participationBefore.includes("100/100") ? "0" : "100";

    await participationCard.click();
    const whatIfInput = participationCard.locator('input[type="number"]');
    await expect(whatIfInput).toBeVisible();
    await whatIfInput.fill(targetValue);
    await whatIfInput.press("Enter");

    await expect(participationCard).toContainText(targetValue === "100" ? "100/100" : "0/100");
  });

  test("updates dependent final-grade simulation and restores baseline on clear", async ({ page }) => {
    await gotoStudentGradebook(page);

    const participationCard = getGradeCard(page, "Participation");
    const finalCard = getGradeCard(page, "Final Grade");
    await expect(participationCard).toBeVisible();
    await expect(finalCard).toBeVisible();

    const finalBefore = normalizeText(await finalCard.innerText());
    const participationBefore = normalizeText(await participationCard.innerText());
    const targetValue = participationBefore.includes("100/100") ? "0" : "100";

    await participationCard.click();
    const whatIfInput = participationCard.locator('input[type="number"]');
    await expect(whatIfInput).toBeVisible();
    await whatIfInput.fill(targetValue);
    await whatIfInput.press("Enter");

    await expect(async () => {
      const finalAfterSet = normalizeText(await finalCard.innerText());
      expect(finalAfterSet).not.toBe(finalBefore);
    }).toPass();

    await participationCard.click();
    await expect(whatIfInput).toBeVisible();
    await whatIfInput.fill("");
    await whatIfInput.press("Enter");

    await expect(async () => {
      const finalAfterClear = normalizeText(await finalCard.innerText());
      expect(finalAfterClear).toBe(finalBefore);
    }).toPass();
  });

  test("keeps calculated cards read-only", async ({ page }) => {
    await gotoStudentGradebook(page);

    const finalCard = getGradeCard(page, "Final Grade");
    const averageAssignmentsCard = getGradeCard(page, "Average Assignments");
    await expect(finalCard).toBeVisible();
    await expect(averageAssignmentsCard).toBeVisible();

    await finalCard.click();
    await expect(finalCard.locator('input[type="number"]')).toHaveCount(0);

    await averageAssignmentsCard.click();
    await expect(averageAssignmentsCard.locator('input[type="number"]')).toHaveCount(0);
  });

  test("what-if editing and group disclosure are keyboard operable (WCAG 2.1.1)", async ({ page }) => {
    await gotoStudentGradebook(page);

    // Group headers are real disclosure buttons: focusable, Enter toggles, state announced.
    const groupToggle = page.getByRole("button", { name: /assignments\.\.\./i }).first();
    await expect(groupToggle).toBeVisible();
    const expandedBefore = await groupToggle.getAttribute("aria-expanded");
    await groupToggle.focus();
    await page.keyboard.press("Enter");
    await expect(groupToggle).toHaveAttribute("aria-expanded", expandedBefore === "true" ? "false" : "true");

    // The what-if editor opens from an explicit button (not just the card click target),
    // moves focus into the input, and Escape returns focus to the button that opened it.
    const participationCard = getGradeCard(page, "Participation");
    const editButton = participationCard.getByRole("button", { name: /edit hypothetical grade for participation/i });
    await expect(editButton).toBeVisible();
    await editButton.focus();
    await page.keyboard.press("Enter");

    const whatIfInput = participationCard.locator('input[type="number"]');
    await expect(whatIfInput).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editButton).toBeFocused();
  });

  test("supports assignment-card simulation and cascades to final grade", async ({ page }) => {
    await gotoStudentGradebook(page);

    const finalCard = getGradeCard(page, "Final Grade");
    const assignmentCard = page.getByRole("article", { name: /Grade for Test Assignment 1/ }).first();
    await expect(finalCard).toBeVisible();
    await expect(assignmentCard).toBeVisible();

    const finalBefore = normalizeText(await finalCard.innerText());
    const assignmentBefore = normalizeText(await assignmentCard.innerText());
    const assignmentTarget = assignmentBefore.includes("100/100") ? "0" : "100";

    await assignmentCard.click();
    const whatIfInput = assignmentCard.locator('input[type="number"]');
    await expect(whatIfInput).toBeVisible();
    await whatIfInput.fill(assignmentTarget);
    await whatIfInput.press("Enter");

    await expect(assignmentCard).toContainText(assignmentTarget === "100" ? "100/100" : "0/100");
    await expect(async () => {
      const finalAfter = normalizeText(await finalCard.innerText());
      expect(finalAfter).not.toBe(finalBefore);
    }).toPass();
  });
});
