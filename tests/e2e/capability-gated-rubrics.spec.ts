/**
 * #1010: editing rubrics needs manage_rubrics (20261121200100_rubrics_by_capability.sql). Without
 * it the Configure Rubric nav item is hidden, and opening the rubric page by URL sends you back to
 * the assignment page. A Head TA on a custom role with manage_rubrics sees it and can save a rubric.
 * Instructors see no change.
 *
 * The default instructor role holds manage_rubrics, the default grader role doesn't.
 */
import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  insertAssignment,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("rubric editing gated by manage_rubrics", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let headTa: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Rubric Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `E2E Rubric Gates ${suffix}`,
      assignment_slug: `e2e-rub-${suffix}`
    });

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Rubric TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_rubrics" })).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", headTa.user_id)
          .eq("class_id", course.id)
      ).error
    ).toBeNull();
  });

  const assignmentUrl = () => `/course/${course.id}/manage/assignments/${assignment.id}`;

  // The page's capability lookup. Registered before navigating, so it can't miss the response.
  const capabilityLookup = (page: Page) =>
    page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200);

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  // ClassCapabilitiesProvider adds data-capabilities-loaded in the same render that applies the
  // answer. It also adds it, with no capabilities, after the lookup fails a few times, so this first
  // waits for a successful lookup. "Manage Groups" showing means the nav has rendered.
  async function openGroupsPage(page: Page) {
    const capabilities = capabilityLookup(page);
    await gotoCourseUrlWhenHeadingVisible(page, `${assignmentUrl()}/groups`, "Configure Groups");
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]').first()).toBeAttached();
    await expect(page.getByRole("link", { name: "Manage Groups" }).first()).toBeVisible();
  }

  // The manage layout renders the page twice (mobile and desktop); the region picks the visible copy.
  const rubricEditor = (page: Page) => page.getByRole("region", { name: "Rubric Editor" });

  test("a grader doesn't see Configure Rubric", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await openGroupsPage(page);
    await expect(page.getByRole("link", { name: "Configure Rubric" })).toHaveCount(0);
  });

  test("a grader who opens the rubric page by URL is sent back to the assignment page", async ({ page }) => {
    await loginAsUser(page, grader, course);
    const capabilities = capabilityLookup(page);
    await page.goto(`${assignmentUrl()}/rubric`);
    await capabilities;
    await expect(page).toHaveURL(new RegExp(`${assignmentUrl()}$`));
    await expect(rubricEditor(page)).toHaveCount(0);
  });

  test("a Head TA with manage_rubrics who opens the rubric page by URL gets the editor", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await page.goto(`${assignmentUrl()}/rubric`);
    await expect(rubricEditor(page)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`${assignmentUrl()}/rubric$`));
  });

  test("an instructor still sees Configure Rubric", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openGroupsPage(page);
    await expect(page.getByRole("link", { name: "Configure Rubric" }).first()).toBeVisible();
  });

  test("a Head TA with manage_rubrics sees Configure Rubric and saves an edit", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await openGroupsPage(page);
    await page.getByRole("link", { name: "Configure Rubric" }).first().click();

    await rubricEditor(page)
      .getByRole("tab", { name: /^\s*Grading Review(\*?\s*\(Unsaved Changes\))?\s*$/i })
      .click();
    const firstPart = rubricEditor(page).getByRole("region", { name: /^Part 1:/ });
    await firstPart.scrollIntoViewIfNeeded();
    const newName = `Head TA part ${Date.now().toString(36)}`;
    await firstPart.getByLabel("Name").first().fill(newName);
    await rubricEditor(page).getByRole("button", { name: "Save" }).click();

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("rubric_parts")
            .select("name")
            .eq("rubric_id", assignment.grading_rubric_id!);
          return (data ?? []).map((part) => part.name);
        },
        { timeout: 30_000 }
      )
      .toContain(newName);
  });

  // Editing an existing rubric after switching round tabs still saves to it: only a draft that
  // started as a new rubric is refused when one now exists.
  test("a Head TA's edit still saves after switching round tabs and back", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await page.goto(`${assignmentUrl()}/rubric`);
    const gradingTab = rubricEditor(page).getByRole("tab", {
      name: /^\s*Grading Review\s*(\*\s*\(Unsaved Changes\))?\s*$/i
    });
    const selfReviewTab = rubricEditor(page).getByRole("tab", {
      name: /^\s*Self Review\s*(\*\s*\(Unsaved Changes\))?\s*$/i
    });
    await gradingTab.click();
    await selfReviewTab.click();
    await expect(selfReviewTab).toHaveAttribute("aria-selected", "true");
    await gradingTab.click();
    await expect(gradingTab).toHaveAttribute("aria-selected", "true");

    const firstPart = rubricEditor(page).getByRole("region", { name: /^Part 1:/ });
    await firstPart.scrollIntoViewIfNeeded();
    const newName = `Head TA tab part ${Date.now().toString(36)}`;
    await firstPart.getByLabel("Name").first().fill(newName);
    await rubricEditor(page).getByRole("button", { name: "Save" }).click();

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("rubric_parts")
            .select("name")
            .eq("rubric_id", assignment.grading_rubric_id!);
          return (data ?? []).map((part) => part.name);
        },
        { timeout: 30_000 }
      )
      .toContain(newName);
  });

  // A save that finishes after the user switched rounds clears only the round it saved. The round
  // on screen keeps its new-rubric draft, its Save button and its guard, so it can't save over a
  // rubric someone else created for that round in the meantime.
  test("a save that finishes on another round leaves that round's new-rubric draft guarded", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await page.goto(`${assignmentUrl()}/rubric`);
    const tab = (label: string) =>
      rubricEditor(page).getByRole("tab", {
        name: new RegExp(`^\\s*${label}\\s*(\\*\\s*\\(Unsaved Changes\\))?\\s*$`, "i")
      });
    const gradingTab = tab("Grading Review");
    const metaTab = tab("Meta Grading Review");
    const saveButton = rubricEditor(page).getByRole("button", { name: "Save" });
    const suffix = Date.now().toString(36);

    // Round B (meta-grading) has no rubric: start a new one.
    await metaTab.click();
    await expect(metaTab).toHaveAttribute("aria-selected", "true");
    await rubricEditor(page).getByRole("button", { name: "Create New Rubric" }).click();
    // The new draft keeps its default name; the preview beside the editor shows it.
    const draftPreview = page.getByText(/^Meta Grading Review Rubric for /);
    await expect(draftPreview).toBeVisible();

    // Round A (grading): edit, then hold its save until the user is back on round B.
    await gradingTab.click();
    await expect(gradingTab).toHaveAttribute("aria-selected", "true");
    const firstPart = rubricEditor(page).getByRole("region", { name: /^Part 1:/ });
    await firstPart.scrollIntoViewIfNeeded();
    const savedName = `Head TA saved part ${suffix}`;
    await firstPart.getByLabel("Name").first().fill(savedName);

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/rpc/update_rubric_full*", async (route) => {
      await released;
      await route.continue();
    });
    const saveRequest = page.waitForRequest((r) => r.url().includes("/rpc/update_rubric_full"));
    await saveButton.click();
    await saveRequest;

    await metaTab.click();
    await expect(metaTab).toHaveAttribute("aria-selected", "true");
    await expect(draftPreview).toBeVisible();

    const saveResponse = page.waitForResponse((r) => r.url().includes("/rpc/update_rubric_full"));
    release();
    expect((await saveResponse).ok()).toBe(true);
    await expect(rubricEditor(page).getByRole("button", { name: "Saving..." })).toHaveCount(0, { timeout: 30_000 });
    await page.unroute("**/rpc/update_rubric_full*");

    const { data: parts } = await supabase
      .from("rubric_parts")
      .select("name")
      .eq("rubric_id", assignment.grading_rubric_id!);
    expect((parts ?? []).map((part) => part.name)).toContain(savedName);

    // Round B is untouched: still unsaved, still savable, still its own draft.
    await expect(metaTab).toHaveText(/Unsaved Changes/);
    await expect(saveButton).toBeEnabled();
    await expect(draftPreview).toBeVisible();

    // Someone else creates round B's rubric. Saving the draft is refused and theirs stays.
    const otherName = `Other editor meta ${suffix}`;
    const { data: other, error: otherError } = await supabase
      .from("rubrics")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        review_round: "meta-grading-review",
        name: otherName
      })
      .select("id")
      .single();
    expect(otherError).toBeNull();
    expect(
      (await supabase.from("assignments").update({ meta_grading_rubric_id: other!.id }).eq("id", assignment.id)).error
    ).toBeNull();

    await saveButton.click();
    await expect(page.getByText("Cannot save rubric")).toBeVisible({ timeout: 30_000 });
    const { data: metaRubrics } = await supabase
      .from("rubrics")
      .select("id, name")
      .eq("assignment_id", assignment.id)
      .eq("review_round", "meta-grading-review");
    expect(metaRubrics).toEqual([{ id: other!.id, name: otherName }]);
  });
});
