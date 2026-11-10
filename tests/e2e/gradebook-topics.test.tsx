/**
 * Gradebook topics, end to end, with Argos screenshots, on a CS 2100-style course whose quiz
 * sessions are groups and whose topics are assessed in several attempts
 * (tests/e2e/gradebookColumnGroupsFixtures.ts): Suggest topics, the topic view, a generated
 * standing, and the student view.
 */
import dotenv from "dotenv";
import { expect, test } from "../global-setup";
import { createCs2100StyleGradebook, waitForGradebookRecalculation } from "./gradebookColumnGroupsFixtures";
import {
  GRADEBOOK_VIEWPORT,
  headerUnits,
  openColumnMenu,
  openInstructorGradebook,
  tableRegion,
  waitForToastsGone,
  waitForVirtualizerIdle
} from "./gradebookTableHelpers";
import { loginAsUser, supabase } from "./TestingUtils";
import { visualScreenshot } from "./VisualTestUtils";

dotenv.config({ path: ".env.local", quiet: true });

test.setTimeout(480_000);

test.describe("Gradebook topics (CS 2100-style course)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: GRADEBOOK_VIEWPORT });
  let fixture: Awaited<ReturnType<typeof createCs2100StyleGradebook>>;

  test.beforeAll(async () => {
    // The fixture waits for the recalculation worker, which runs on a one-minute cron.
    test.setTimeout(480_000);
    fixture = await createCs2100StyleGradebook();
  });

  test("Suggest topics finds every topic, recovers the glob-missed attempt, and blocks on a duplicate", async ({
    page
  }) => {
    await loginAsUser(page, fixture.instructor, fixture.course);
    await openInstructorGradebook(page, fixture.course.id);
    // Quiz sessions are the groups before any topic exists.
    expect(await headerUnits(page)).toEqual(["4 Quiz 9/22...", "6 Quiz 10/15..."]);
    await visualScreenshot(page, "gradebook-topics-sessions-before");

    await page.getByRole("button", { name: "Suggest Topics" }).click();
    const dialog = page.getByRole("dialog", { name: "Suggest topics" });
    await expect(dialog.getByText("Coupling, Cohesion, and Encapsulation", { exact: true })).toBeVisible();
    for (const topic of ["Git", "Functions and Documentation", "Stakeholder-value Matrices"]) {
      await expect(dialog.getByText(topic, { exact: true })).toBeVisible();
    }
    // 3cce is not read by max(gradebook_columns("cce*")); Suggest proposes it by name.
    await expect(dialog.getByText("not read by the standing; matched by name").first()).toBeVisible();
    await expect(dialog.getByText("duplicate attempt")).toHaveCount(2);
    await expect(dialog.getByText(/Uncheck one column for: Stakeholder-value Matrices: attempt 2/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Create topics" })).toBeDisabled();
    // Frame the topic with the duplicate, the part of the dialog that needs a decision.
    await dialog.getByText("duplicate attempt").first().scrollIntoViewIfNeeded();
    await visualScreenshot(page, "gradebook-topics-suggest", { element: dialog });

    // Drop the stray second "Attempt 2" (slug 2svm), which the standing does not read.
    const strays = dialog.getByRole("checkbox", { name: "Attempt 2: Stakeholder-value Matrices" });
    await strays.last().click({ force: true });
    await expect(dialog.getByRole("button", { name: "Create topics" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Create topics" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const { data: topics } = await supabase
      .from("gradebook_topics")
      .select("name, standing_rule, standing_column_id")
      .eq("class_id", fixture.course.id)
      .order("name");
    expect(topics?.map((t) => t.name)).toEqual([
      "Coupling, Cohesion, and Encapsulation",
      "Functions and Documentation",
      "Git",
      "Stakeholder-value Matrices"
    ]);
    // Applying keeps the instructor's own standing expressions.
    expect(topics?.every((t) => t.standing_rule === null && t.standing_column_id !== null)).toBe(true);
  });

  test("the topic view collapses each topic to its standing and expands to its attempts", async ({ page }) => {
    await loginAsUser(page, fixture.instructor, fixture.course);
    await openInstructorGradebook(page, fixture.course.id);
    // Each topic sits where its standing column is; the session group keeps only the stray 2svm.
    expect(await headerUnits(page)).toEqual([
      "1 Quiz 10/15...",
      "Git",
      "Functions and Documentation",
      "Coupling, Cohesion, and Encapsulation",
      "Stakeholder-value Matrices"
    ]);
    await visualScreenshot(page, "gradebook-topics-view-collapsed");

    // Switch CCE to a generated best-of standing: the third attempt the glob missed now counts.
    // A second of slack for client/DB clock skew; earlier recalculations finished long before.
    const beforeStanding = new Date(Date.now() - 1000);
    await tableRegion(page)
      .getByRole("button", { name: "Topic options for Coupling, Cohesion, and Encapsulation" })
      .click();
    await page.getByRole("menuitem", { name: "Standing: best attempt" }).click();
    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("gradebook_columns")
          .select("score_expression")
          .eq("class_id", fixture.course.id)
          .eq("slug", "topic_cce")
          .single();
        return data?.score_expression ?? "";
      })
      .toContain('gradebook_columns("3cce")');
    await waitForGradebookRecalculation(fixture.course.id, beforeStanding);
    await expect.poll(() => headerUnits(page)).toContain("Coupling, Cohesion, and Encapsulation (best attempt)");

    await tableRegion(page).getByRole("button", { name: "Expand all groups" }).click();
    await waitForToastsGone(page);
    await waitForVirtualizerIdle(page);
    await visualScreenshot(page, "gradebook-topics-view-expanded");

    // The group view is one toggle away.
    await tableRegion(page).getByRole("button", { name: "Show groups" }).click();
    await waitForVirtualizerIdle(page);
    // Topics never change group membership.
    expect(await headerUnits(page)).toEqual(["4 Quiz 9/22...", "6 Quiz 10/15..."]);
  });

  test("every instructor surface for topics", async ({ page }) => {
    await loginAsUser(page, fixture.instructor, fixture.course);
    await page.goto(`/course/${fixture.course.id}/manage/course/feature-flags`);
    await visualScreenshot(page, "gradebook-topics-feature-flag-card", {
      element: page.locator(".chakra-card__root").filter({ hasText: "Gradebook topics" })
    });

    await openInstructorGradebook(page, fixture.course.id);
    await tableRegion(page).getByRole("button", { name: "Expand all groups" }).click();
    await waitForVirtualizerIdle(page);

    // The column menu carries Topic… next to Group….
    await openColumnMenu(page, "HW1");
    await expect(page.getByRole("menuitem", { name: "Topic…" })).toBeVisible();
    await visualScreenshot(page, "gradebook-topics-column-menu");

    // Topic… for a column: an existing topic and an attempt number (blank = the next one).
    await page.getByRole("menuitem", { name: "Topic…" }).click();
    const topicDialog = page.getByRole("dialog", { name: /Topic for .HW1./ });
    await topicDialog.getByLabel("Topic").selectOption({ label: "Git" });
    await expect(topicDialog.getByLabel("Attempt number")).toBeVisible();
    await visualScreenshot(page, "gradebook-topics-column-topic-dialog", { element: topicDialog });
    await topicDialog.getByLabel("Topic").selectOption("new");
    await topicDialog.getByLabel("New topic name").fill("Recursion");
    await visualScreenshot(page, "gradebook-topics-column-new-topic-dialog", { element: topicDialog });
    await topicDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(topicDialog).toBeHidden();

    // The topic header menu: standing rule, rename, delete.
    await tableRegion(page).getByRole("button", { name: "Topic options for Git" }).click();
    await expect(page.getByRole("menuitem", { name: "Standing: keep the column's own expression" })).toBeDisabled();
    await visualScreenshot(page, "gradebook-topics-topic-menu");
    await page.getByRole("menuitem", { name: "Rename topic" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename topic" });
    await renameDialog.getByLabel("Topic name").fill("Version control");
    await visualScreenshot(page, "gradebook-topics-rename-dialog", { element: renameDialog });
    await renameDialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("students see one card per topic, expandable to their attempts", async ({ page }) => {
    await loginAsUser(page, fixture.students[0], fixture.course);
    await page.goto(`/course/${fixture.course.id}/gradebook`);
    const region = page.getByRole("region", { name: "Student Gradebook" });
    await expect(region).toBeVisible({ timeout: 60_000 });
    const cce = region.getByRole("button", { name: /Coupling, Cohesion, and Encapsulation\.\.\./ });
    await expect(cce).toBeVisible();
    await expect(
      region.getByRole("article", { name: "Grade for Coupling, Cohesion, and Encapsulation Topic Max Score" })
    ).toBeVisible();
    await visualScreenshot(page, "gradebook-topics-student-collapsed");

    await cce.click();
    await expect(region.getByRole("article", { name: "Grade for Attempt 3: Coupling" })).toBeVisible();
    await visualScreenshot(page, "gradebook-topics-student-expanded");
  });
});
