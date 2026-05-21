/**
 * GUI-side coverage for the rubric editor.
 *
 * Selectors are anchored via ARIA roles + names:
 *   - The instructor manage layout renders the page twice (mobile + desktop
 *     breakpoints) with display:none on the off-breakpoint copy. Scoping every
 *     query under the "Rubric Editor" region filters to the visible copy
 *     because display:none removes nodes from the accessibility tree.
 *   - Parts, criteria, and checks each carry an aria-label with their
 *     position and / or name so they can be addressed without test-ids.
 */
import { createAdminClient } from "@/utils/supabase/client";
import { Assignment, Course, RubricCheck } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import { expect, test } from "../global-setup";
import type { Page, Locator } from "@playwright/test";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, TestingUser } from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

let course: Course;
let instructor: TestingUser | undefined;
let templateAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
let optionsAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
let deductionAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
let viewToggleAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
let mutexAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
let referencesAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
let crossRoundAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;

const adminDb = () => createAdminClient<Database>();

test.beforeAll(async () => {
  course = await createClass();
  [instructor] = await createUsersInClass([
    {
      name: "Rubric GUI Instructor",
      email: "rubric-gui-instructor@pawtograder.net",
      role: "instructor",
      class_id: course!.id,
      useMagicLink: true
    }
  ]);
  templateAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI Template Assignment"
  });
  optionsAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI Options Assignment"
  });
  deductionAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI Deduction Assignment"
  });
  viewToggleAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI View Toggle Assignment"
  });
  mutexAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI Mutex Assignment"
  });
  referencesAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI References Assignment"
  });
  crossRoundAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI Cross Round Assignment"
  });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor]);
});

function rubricEditor(page: Page): Locator {
  return page.getByRole("region", { name: "Rubric Editor" });
}

function guiPane(page: Page): Locator {
  return rubricEditor(page).getByRole("region", { name: "Rubric GUI" });
}

function partAt(page: Page, displayIndex: number): Locator {
  return rubricEditor(page).getByRole("region", { name: new RegExp(`^Part ${displayIndex + 1}:`) });
}

function criterionByName(part: Locator, name: string): Locator {
  return part.getByRole("region", { name: `Criterion: ${name}` });
}

function checkByName(criterion: Locator, name: string): Locator {
  return criterion.getByRole("region", { name: `Check: ${name}` });
}

// The Part / Criterion / Check regions each contain a "Name" field followed by descendant
// regions that also have Name fields. `.first()` reliably targets the direct Name field
// because it appears before any nested region in DOM order.
function nameField(region: Locator): Locator {
  return region.getByLabel("Name").first();
}

async function clickSave(page: Page) {
  await rubricEditor(page).getByRole("button", { name: "Save" }).click();
  // The page mounts twice (mobile + desktop responsive copies). The hidden copy doesn't
  // reset hasUnsavedChanges on save, so asserting on the Save button's disabled state is
  // unreliable. Settle on network idle plus a small buffer and rely on the subsequent DB
  // assertions to catch save failures.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
}

async function waitForMonaco(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as { monaco?: unknown }).monaco)), { timeout: 15_000 })
    .toBe(true);
}

// `window.monaco` is exposed before the rubric editor has created its model, so a
// getModels() lookup immediately after waitForMonaco can intermittently find nothing
// ("could not locate rubric monaco model"). Poll until the rubric/YAML model exists.
async function waitForRubricModel(page: Page) {
  await waitForMonaco(page);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const monaco = (window as { monaco?: typeof import("monaco-editor") }).monaco;
          if (!monaco) return false;
          const models = monaco.editor.getModels();
          return Boolean(
            models.find((m) => m.uri.toString().includes("rubric-")) ?? models.find((m) => m.getLanguageId() === "yaml")
          );
        }),
      { timeout: 15_000 }
    )
    .toBe(true);
}

async function setMonacoValue(page: Page, text: string) {
  await waitForRubricModel(page);
  await page.evaluate((value) => {
    const monaco = (window as { monaco?: typeof import("monaco-editor") }).monaco;
    if (!monaco) throw new Error("monaco is not exposed on window");
    const models = monaco.editor.getModels();
    const target =
      models.find((m) => m.uri.toString().includes("rubric-")) ?? models.find((m) => m.getLanguageId() === "yaml");
    if (!target) throw new Error("could not locate rubric monaco model");
    target.setValue(value);
  }, text);
}

async function getMonacoValue(page: Page): Promise<string> {
  await waitForMonaco(page);
  return await page.evaluate(() => {
    const monaco = (window as { monaco?: typeof import("monaco-editor") }).monaco;
    if (!monaco) throw new Error("monaco is not exposed on window");
    const models = monaco.editor.getModels();
    const target =
      models.find((m) => m.uri.toString().includes("rubric-")) ?? models.find((m) => m.getLanguageId() === "yaml");
    if (!target) throw new Error("could not locate rubric monaco model");
    return target.getValue();
  });
}

async function pickReferenceTarget(check: Locator, namePattern: RegExp) {
  // The reference picker is a native <select>. selectOption() needs an exact label or value;
  // we look up the matching option's value first, then select by value.
  const select = check.getByLabel("Select reference target");
  const optionValue = await select.locator("option").filter({ hasText: namePattern }).first().getAttribute("value");
  if (!optionValue) throw new Error(`No reference target matched ${namePattern}`);
  await select.selectOption(optionValue);
}

async function selectGradingReviewTab(page: Page) {
  // Anchored regex so it doesn't match "Meta Grading Review".
  const tab = rubricEditor(page).getByRole("tab", {
    name: /^\s*Grading Review(\*?\s*\(Unsaved Changes\))?\s*$/i
  });
  await tab.click();
  // Wait for the tab indicator to flip before letting the test interact with the editor.
  // Without this, follow-up locators like partAt(0) can resolve against the previously
  // selected tab's still-mounted DOM (the click fires React's onValueChange synchronously
  // but the state-update + re-render cascade isn't guaranteed to complete before the next
  // Playwright action queries the DOM).
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function selectSelfReviewTab(page: Page) {
  const tab = rubricEditor(page).getByRole("tab", {
    name: /^\s*Self Review(\*?\s*\(Unsaved Changes\))?\s*$/i
  });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

// Refetch the assignment's grading_rubric_id - it may be set asynchronously by a trigger
// after insertAssignment returns.
async function gradingRubricIdFor(assignmentId: number): Promise<number> {
  const supabase = adminDb();
  const { data, error } = await supabase
    .from("assignments")
    .select("grading_rubric_id")
    .eq("id", assignmentId)
    .single();
  if (error) throw error;
  if (!data.grading_rubric_id) throw new Error(`grading_rubric_id is null for assignment ${assignmentId}`);
  return data.grading_rubric_id;
}

test.describe("Rubric editor GUI", () => {
  test("View toggle is reversible and preserves edits", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${viewToggleAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    // Default view is GUI.
    await expect(guiPane(page)).toBeVisible();

    // Toggle to source - Monaco editor pane becomes visible.
    await rubricEditor(page).getByRole("button", { name: "YAML source" }).click();
    await expect(rubricEditor(page).getByRole("region", { name: "Rubric YAML Source" })).toBeVisible();

    // Toggle back to GUI.
    await rubricEditor(page).getByRole("button", { name: "GUI" }).click();
    await expect(guiPane(page)).toBeVisible();

    // Edit the first part's name in GUI.
    const firstPart = partAt(page, 0);
    await firstPart.scrollIntoViewIfNeeded();
    await nameField(firstPart).fill("Edited Part Name");

    // Toggle to source and assert YAML reflects the edit.
    await rubricEditor(page).getByRole("button", { name: "YAML source" }).click();
    const yaml = await getMonacoValue(page);
    expect(yaml).toContain("Edited Part Name");

    // Toggle back to GUI - the edited name still shows. The part's aria-label has the new name.
    await rubricEditor(page).getByRole("button", { name: "GUI" }).click();
    const editedPart = rubricEditor(page).getByRole("region", { name: /^Part 1: Edited Part Name/ });
    await expect(nameField(editedPart)).toHaveValue("Edited Part Name");
  });

  test("Quick-add met/partial/not met template creates 3 checks with expected shape", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${templateAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    const firstPart = partAt(page, 0);
    await firstPart.scrollIntoViewIfNeeded();
    await firstPart.getByRole("button", { name: "Add criterion" }).click();
    await page.getByRole("menuitem", { name: "Met / partial / not met" }).click();

    const criterion = criterionByName(firstPart, "Met / partial / not met");
    await expect(criterion).toBeVisible();
    await expect(checkByName(criterion, "Met")).toBeVisible();
    await expect(checkByName(criterion, "Partially met")).toBeVisible();
    await expect(checkByName(criterion, "Not met")).toBeVisible();

    await clickSave(page);

    const gradingRubricId = await gradingRubricIdFor(templateAssignment!.id);
    const supabase = adminDb();
    type CriterionRow = {
      id: number;
      name: string;
      is_additive: boolean;
      is_deduction_only: boolean;
      min_checks_per_submission: number | null;
      max_checks_per_submission: number | null;
    };
    let criteriaRows: CriterionRow[] = [];
    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("rubric_criteria")
            .select("id, name, is_additive, is_deduction_only, min_checks_per_submission, max_checks_per_submission")
            .eq("rubric_id", gradingRubricId)
            .eq("name", "Met / partial / not met");
          criteriaRows = (data as CriterionRow[] | null) ?? [];
          return criteriaRows.length;
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0);
    const c = criteriaRows[0];
    expect(c.is_additive).toBe(false);
    expect(c.is_deduction_only).toBe(false);
    expect(c.min_checks_per_submission).toBe(1);
    expect(c.max_checks_per_submission).toBe(1);

    type CheckRow = { name: string; points: number; ordinal: number };
    let checkRows: CheckRow[] = [];
    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("rubric_checks")
            .select("name, points, ordinal")
            .eq("rubric_criteria_id", c.id)
            .order("ordinal", { ascending: true });
          checkRows = (data as CheckRow[] | null) ?? [];
          return checkRows.length;
        },
        { timeout: 10_000 }
      )
      .toBe(3);
    expect(checkRows.map((ch) => ch.name)).toEqual(["Met", "Partially met", "Not met"]);
    expect(checkRows.map((ch) => ch.points)).toEqual([2, 1, 0]);
  });

  test("Multi-option check editing persists options to DB", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${optionsAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    // Add a brand-new criterion using the multi-option template - simpler than fishing the
    // seeded criterion out and reconfiguring it.
    const firstPart = partAt(page, 0);
    await firstPart.scrollIntoViewIfNeeded();
    await firstPart.getByRole("button", { name: "Add criterion" }).click();
    await page.getByRole("menuitem", { name: /^Multi-option check/ }).click();

    const criterion = criterionByName(firstPart, "Multi-option check");
    await expect(criterion).toBeVisible();
    const check = checkByName(criterion, "Select one option");
    await expect(check).toBeVisible();

    // The template seeds three options. Rename them and the points via per-row aria-labels.
    const optionLabels = ["Excellent", "Adequate", "Poor"];
    const optionPoints = [3, 2, 1];
    for (let i = 0; i < 3; i++) {
      await check.getByLabel(`Option ${i + 1} label`).fill(optionLabels[i]);
      await check.getByLabel(`Option ${i + 1} points`).fill(String(optionPoints[i]));
    }

    await clickSave(page);
    await page.reload();
    await selectGradingReviewTab(page);

    const reloadedCriterion = criterionByName(partAt(page, 0), "Multi-option check");
    const reloadedCheck = checkByName(reloadedCriterion, "Select one option");
    for (let i = 0; i < 3; i++) {
      await expect(reloadedCheck.getByLabel(`Option ${i + 1} label`)).toHaveValue(optionLabels[i]);
    }

    const gradingRubricId = await gradingRubricIdFor(optionsAssignment!.id);
    const supabase = adminDb();
    const { data: criteria } = await supabase
      .from("rubric_criteria")
      .select("id")
      .eq("rubric_id", gradingRubricId)
      .eq("name", "Multi-option check");
    expect(criteria?.length).toBeGreaterThan(0);
    const { data: checks } = await supabase
      .from("rubric_checks")
      .select("data")
      .eq("rubric_criteria_id", criteria![0].id);
    expect(checks?.length).toBeGreaterThan(0);
    const dataValue = checks![0].data as { options?: { label: string; points: number }[] } | null;
    expect(dataValue?.options?.map((o) => o.label)).toEqual(optionLabels);
    expect(dataValue?.options?.map((o) => o.points)).toEqual(optionPoints);
  });

  test("Deduction-only criterion flag flows to DB", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${deductionAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    // Use the dedicated single-check deduction-only template so we know its name.
    const firstPart = partAt(page, 0);
    await firstPart.scrollIntoViewIfNeeded();
    await firstPart.getByRole("button", { name: "Add criterion" }).click();
    await page.getByRole("menuitem", { name: /^Penalty-only annotation/ }).click();

    const criterion = criterionByName(firstPart, "Penalty-only annotations");
    await expect(criterion).toBeVisible();

    await clickSave(page);

    const gradingRubricId = await gradingRubricIdFor(deductionAssignment!.id);
    const supabase = adminDb();
    const { data: criteria } = await supabase
      .from("rubric_criteria")
      .select("name, is_additive, is_deduction_only")
      .eq("rubric_id", gradingRubricId)
      .eq("name", "Penalty-only annotations");
    expect(criteria?.length).toBeGreaterThan(0);
    expect(criteria![0].is_additive).toBe(false);
    expect(criteria![0].is_deduction_only).toBe(true);
  });

  test("Switching to GUI fails when YAML has both is_individual_grading and is_assign_to_student", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${mutexAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    // Go to source view, paste a YAML doc that violates the mutex.
    await rubricEditor(page).getByRole("button", { name: "YAML source" }).click();
    const invalidYaml = [
      "name: Mutex Test",
      "parts:",
      "  - name: Bad Part",
      "    is_individual_grading: true",
      "    is_assign_to_student: true",
      "    criteria:",
      "      - name: Crit",
      "        checks:",
      "          - name: Check",
      "            points: 0",
      "            is_required: false",
      "            is_annotation: false",
      "            is_comment_required: false",
      "            student_visibility: always"
    ].join("\n");
    await setMonacoValue(page, invalidYaml);

    // setMonacoValue already waited for Monaco and wrote the model. The editor's onChange
    // then commits that text to React state (rebuilding the handleViewModeChange closure the
    // GUI button reads) and debounces a parse 1s later. Clicking GUI before that settles runs
    // against the stale (empty/valid) YAML, wrongly succeeds, and switches to GUI — making the
    // source region disappear. Wait out the 1s change-debounce so the click sees the committed
    // mutex-violating YAML and correctly refuses to switch.
    await page.waitForTimeout(1500);

    // Try to toggle back to GUI - it should fail and stay in source mode.
    await rubricEditor(page).getByRole("button", { name: "GUI" }).click();
    // Source pane is still the active region.
    await expect(rubricEditor(page).getByRole("region", { name: "Rubric YAML Source" })).toBeVisible();
    // No part regions exist (GUI never rendered).
    await expect(rubricEditor(page).getByRole("region", { name: /^Part 1:/ })).toHaveCount(0);
  });

  test("References round-trip through GUI and YAML", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${referencesAssignment!.id}/rubric`);

    // First add and save a check on the self-review side so the grading-review side can reference it.
    await selectSelfReviewTab(page);
    const srPart = partAt(page, 0);
    await srPart.scrollIntoViewIfNeeded();
    await srPart.getByRole("button", { name: "Add criterion" }).click();
    await page.getByRole("menuitem", { name: "Blank checkbox criterion" }).click();
    const srCriterion = criterionByName(srPart, "New criterion");
    await nameField(srCriterion).fill("Self Target Criterion");
    const srCriterionRenamed = criterionByName(srPart, "Self Target Criterion");
    const srCheck = checkByName(srCriterionRenamed, "New check");
    await nameField(srCheck).fill("Self Target Check");
    await clickSave(page);

    // Reload so the grading-review side sees the freshly saved self-review check.
    await page.reload();
    // Now grading-review: add a check and link it to the saved self-review check.
    await selectGradingReviewTab(page);
    const grPart = partAt(page, 0);
    await grPart.scrollIntoViewIfNeeded();
    await grPart.getByRole("button", { name: "Add criterion" }).click();
    await page.getByRole("menuitem", { name: "Blank checkbox criterion" }).click();
    const grCriterion = criterionByName(grPart, "New criterion");
    await nameField(grCriterion).fill("Grading Linked Criterion");
    const grCriterionRenamed = criterionByName(grPart, "Grading Linked Criterion");
    const grCheck = checkByName(grCriterionRenamed, "New check");
    await nameField(grCheck).fill("Grading Linked Check");
    const grCheckRenamed = checkByName(grCriterionRenamed, "Grading Linked Check");

    // Expand References and add a reference.
    await grCheckRenamed.getByRole("button", { name: /^References/ }).click();
    await grCheckRenamed.getByRole("button", { name: /Add reference/i }).click();
    // The picker lists target checks by name + round.
    await pickReferenceTarget(grCheckRenamed, /Self Target Check/);
    await grCheckRenamed.getByRole("button", { name: /^Add$/ }).click();

    await clickSave(page);

    // Verify in DB - poll for the reference row to give the save sequence time to settle.
    const supabase = adminDb();
    type RefRow = { referencing_rubric_check_id: number; referenced_rubric_check_id: number };
    let refRows: RefRow[] = [];
    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("rubric_check_references")
            .select("referencing_rubric_check_id, referenced_rubric_check_id")
            .eq("assignment_id", referencesAssignment!.id);
          refRows = (data as RefRow[] | null) ?? [];
          return refRows.length;
        },
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);
    const checkNames = await supabase
      .from("rubric_checks")
      .select("id, name")
      .in(
        "id",
        refRows.flatMap((r) => [r.referencing_rubric_check_id, r.referenced_rubric_check_id])
      );
    const nameById = new Map((checkNames.data ?? []).map((c) => [c.id, c.name]));
    expect(refRows.some((r) => nameById.get(r.referencing_rubric_check_id) === "Grading Linked Check")).toBe(true);
    expect(refRows.some((r) => nameById.get(r.referenced_rubric_check_id) === "Self Target Check")).toBe(true);

    // YAML round-trip: reload so the in-memory rubric is freshly hydrated from DB (including
    // the newly-created reference row), then switch to source view.
    await page.reload();
    await selectGradingReviewTab(page);
    await rubricEditor(page).getByRole("button", { name: "YAML source" }).click();
    const yaml = await getMonacoValue(page);
    expect(yaml).toContain("Grading Linked Check");
    expect(yaml).toMatch(/references:\s*\n[\s\S]*Self Target Check/);
  });

  test("Cross-round save with unsaved sibling tab does not create the reference", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${crossRoundAssignment!.id}/rubric`);

    // Add and save a self-review check first.
    await selectSelfReviewTab(page);
    const srPart = partAt(page, 0);
    await srPart.scrollIntoViewIfNeeded();
    await srPart.getByRole("button", { name: "Add criterion" }).click();
    await page.getByRole("menuitem", { name: "Blank checkbox criterion" }).click();
    const srCriterion = criterionByName(srPart, "New criterion");
    await nameField(srCriterion).fill("Sibling Target Criterion");
    const srCriterionRenamed = criterionByName(srPart, "Sibling Target Criterion");
    const srCheck = checkByName(srCriterionRenamed, "New check");
    await nameField(srCheck).fill("Sibling Target Check");
    await clickSave(page);
    // Reload so the grading-review side has fresh sibling rubric data.
    await page.reload();
    await selectSelfReviewTab(page);

    // Now dirty the self-review tab (do NOT save).
    await nameField(checkByName(partAt(page, 0), "Sibling Target Check")).fill("Sibling Target Check EDITED");
    // Switch to grading-review WITHOUT saving the dirty self-review edit.
    await selectGradingReviewTab(page);
    const grPart = partAt(page, 0);
    await grPart.scrollIntoViewIfNeeded();
    await grPart.getByRole("button", { name: "Add criterion" }).click();
    await page.getByRole("menuitem", { name: "Blank checkbox criterion" }).click();
    const grCriterion = criterionByName(grPart, "New criterion");
    await nameField(grCriterion).fill("Grading Referencing Criterion");
    const grCriterionRenamed = criterionByName(grPart, "Grading Referencing Criterion");
    const grCheck = checkByName(grCriterionRenamed, "New check");
    await nameField(grCheck).fill("Grading Referencing Check");
    const grCheckRenamed = checkByName(grCriterionRenamed, "Grading Referencing Check");

    await grCheckRenamed.getByRole("button", { name: /^References/ }).click();
    await grCheckRenamed.getByRole("button", { name: /Add reference/i }).click();
    // The sibling tab is dirty - the picker should disable that target option.
    const targetSelect = grCheckRenamed.getByLabel("Select reference target");
    const targetOption = targetSelect.locator("option").filter({ hasText: /Sibling Target Check/ });
    await expect(targetOption.first()).toBeDisabled();

    // Save grading-review. Since the user cannot pick the disabled option, no reference row
    // should be created.
    await rubricEditor(page).getByRole("button", { name: "Cancel" }).first().click();
    await clickSave(page);

    const supabase = adminDb();
    const { data: refs } = await supabase
      .from("rubric_check_references")
      .select("referencing_rubric_check_id, referenced_rubric_check_id")
      .eq("assignment_id", crossRoundAssignment!.id);
    expect(refs?.length ?? 0).toBe(0);
  });
});
