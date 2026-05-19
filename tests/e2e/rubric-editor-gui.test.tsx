/**
 * GUI-side coverage for the rubric editor (Phase 5).
 *
 * These tests rely on `data-testid` selectors that we added to the rubric
 * editor components so the suite is resilient to copy/layout changes:
 *
 *   - `rubric-gui-toggle` / `rubric-source-toggle` — view-mode buttons
 *   - `rubric-gui-pane` / `rubric-source-pane`     — editor panes
 *   - `rubric-save`                                — save button
 *   - `rubric-add-part`                            — top-level add part
 *   - `rubric-part-{ordinal}`                      — part card root
 *   - `rubric-add-criterion`                       — per-part add criterion menu
 *   - `rubric-add-criterion-template-{key}`        — template menu items
 *     (`blank`, `metPartialNotMet`, `multiOption`, `deductionOnlyAnnotation`)
 *   - `rubric-add-check`                           — per-criterion add check
 *
 * Tests are scoped to fresh assignments created in `test.beforeAll`. Each test
 * navigates as the instructor to `/course/{id}/manage/assignments/{id}/rubric`
 * and exercises a different GUI scenario.
 */
import { createAdminClient } from "@/utils/supabase/client";
import { Assignment, Course, RubricCheck } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import { expect, test } from "../global-setup";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, TestingUser } from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

let course: Course;
let instructor: TestingUser | undefined;
// One dedicated assignment per scenario so tests stay independent.
let dragAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
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
  // Provision one assignment per test so each starts from a clean slate.
  dragAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric GUI Drag Assignment"
  });
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

async function setMonacoValue(page: import("@playwright/test").Page, text: string) {
  await page.evaluate((value) => {
    const monaco = (window as { monaco?: typeof import("monaco-editor") }).monaco;
    if (!monaco) throw new Error("monaco is not exposed on window");
    // Pick the YAML model whose URI matches the rubric editor's `path` prop.
    const models = monaco.editor.getModels();
    const target =
      models.find((m) => m.uri.toString().includes("rubric-")) ?? models.find((m) => m.getLanguageId() === "yaml");
    if (!target) throw new Error("could not locate rubric monaco model");
    target.setValue(value);
  }, text);
}

async function getMonacoValue(page: import("@playwright/test").Page): Promise<string> {
  return await page.evaluate(() => {
    const monaco = (window as { monaco?: typeof import("monaco-editor") }).monaco;
    if (!monaco) throw new Error("monaco is not exposed on window");
    const models = monaco.editor.getModels();
    const target =
      models.find((m) => m.uri.toString().includes("rubric-")) ?? models.find((m) => m.getLanguageId() === "yaml");
    return target ? target.getValue() : "";
  });
}

async function selectGradingReviewTab(page: import("@playwright/test").Page) {
  await page.getByRole("tab", { name: /Grading Review/i }).click();
}

async function selectSelfReviewTab(page: import("@playwright/test").Page) {
  await page.getByRole("tab", { name: /^\s*Self Review/i }).click();
}

test.describe("Rubric editor GUI", () => {
  test("View toggle is reversible and preserves edits", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${viewToggleAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    // Default view is GUI.
    await expect(page.getByTestId("rubric-gui-pane")).toBeVisible();

    // Toggle to source — Monaco editor pane becomes visible.
    await page.getByTestId("rubric-source-toggle").click();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();

    // Toggle back to GUI.
    await page.getByTestId("rubric-gui-toggle").click();
    await expect(page.getByTestId("rubric-gui-pane")).toBeVisible();

    // Edit the first part's name in GUI.
    const firstPart = page.getByTestId("rubric-part-0");
    await firstPart.scrollIntoViewIfNeeded();
    const nameInput = firstPart.getByLabel("Name").first();
    await nameInput.fill("Edited Part Name");

    // Toggle to source and assert YAML reflects the edit.
    await page.getByTestId("rubric-source-toggle").click();
    const yaml = await getMonacoValue(page);
    expect(yaml).toContain("Edited Part Name");

    // Toggle back to GUI — the edited name still shows.
    await page.getByTestId("rubric-gui-toggle").click();
    await expect(page.getByTestId("rubric-gui-pane")).toBeVisible();
    await expect(page.getByTestId("rubric-part-0").getByLabel("Name").first()).toHaveValue("Edited Part Name");
  });

  test("Drag-and-drop reorders a part and persists after save", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${dragAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    // The default grading-review rubric has two parts: "Grading Review Part 1" and "Grading Review Part 2".
    const part0 = page.getByTestId("rubric-part-0");
    const part1 = page.getByTestId("rubric-part-1");
    await expect(part0).toBeVisible();
    await expect(part1).toBeVisible();
    await expect(part0.getByLabel("Name").first()).toHaveValue("Grading Review Part 1");
    await expect(part1.getByLabel("Name").first()).toHaveValue("Grading Review Part 2");

    // Keyboard-drive @dnd-kit reorder: focus the second part's grip and use Space + ArrowUp + Space.
    const handle = page.getByRole("button", { name: /Drag part Grading Review Part 2/i });
    await handle.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Space");

    // Visual order should now have Part 2 first.
    await expect(page.getByTestId("rubric-part-0").getByLabel("Name").first()).toHaveValue("Grading Review Part 2");
    await expect(page.getByTestId("rubric-part-1").getByLabel("Name").first()).toHaveValue("Grading Review Part 1");

    await page.getByTestId("rubric-save").click();
    await expect(page.getByText("Rubric Saved")).toBeVisible({ timeout: 15_000 });

    // Reload and assert order persisted both in the UI and DB.
    await page.reload();
    await selectGradingReviewTab(page);
    await expect(page.getByTestId("rubric-part-0").getByLabel("Name").first()).toHaveValue("Grading Review Part 2");
    await expect(page.getByTestId("rubric-part-1").getByLabel("Name").first()).toHaveValue("Grading Review Part 1");

    const supabase = adminDb();
    const { data: parts, error } = await supabase
      .from("rubric_parts")
      .select("id, name, ordinal")
      .eq("rubric_id", dragAssignment!.grading_rubric_id!)
      .order("ordinal", { ascending: true });
    expect(error).toBeNull();
    expect(parts?.map((p) => p.name)).toEqual(["Grading Review Part 2", "Grading Review Part 1"]);
  });

  test("Quick-add met/partial/not met template creates 3 checks with expected shape", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${templateAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    const firstPart = page.getByTestId("rubric-part-0");
    await firstPart.scrollIntoViewIfNeeded();
    await firstPart.getByTestId("rubric-add-criterion").first().click();
    await page.getByTestId("rubric-add-criterion-template-metPartialNotMet").click();

    // The newly added criterion is the last one in the part. The template names are stable.
    await expect(firstPart.getByText("Met / partial / not met").first()).toBeVisible();
    await expect(firstPart.locator('input[value="Met"]').first()).toBeVisible();
    await expect(firstPart.locator('input[value="Partially met"]').first()).toBeVisible();
    await expect(firstPart.locator('input[value="Not met"]').first()).toBeVisible();

    await page.getByTestId("rubric-save").click();
    await expect(page.getByText("Rubric Saved")).toBeVisible({ timeout: 15_000 });

    const supabase = adminDb();
    const { data: criteria } = await supabase
      .from("rubric_criteria")
      .select("id, name, is_additive, is_deduction_only, min_checks_per_submission, max_checks_per_submission")
      .eq("rubric_id", templateAssignment!.grading_rubric_id!)
      .eq("name", "Met / partial / not met");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBeGreaterThan(0);
    const criterion = criteria![0];
    expect(criterion.is_additive).toBe(false);
    expect(criterion.is_deduction_only).toBe(false);
    expect(criterion.min_checks_per_submission).toBe(1);
    expect(criterion.max_checks_per_submission).toBe(1);

    const { data: checks } = await supabase
      .from("rubric_checks")
      .select("name, points, ordinal")
      .eq("rubric_criteria_id", criterion.id)
      .order("ordinal", { ascending: true });
    expect(checks).toHaveLength(3);
    expect(checks?.map((c) => c.name)).toEqual(["Met", "Partially met", "Not met"]);
    expect(checks?.map((c) => c.points)).toEqual([2, 1, 0]);
  });

  test("Multi-option check editing persists options to DB", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${optionsAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    const firstPart = page.getByTestId("rubric-part-0");
    await firstPart.scrollIntoViewIfNeeded();
    // Add a fresh check to the seeded first criterion.
    await firstPart.getByTestId("rubric-add-check").first().click();

    // The newly-added check is the last one; rename it.
    const newCheckName = firstPart.locator('input[placeholder="Check name"]').last();
    await newCheckName.fill("Options check");

    // Switch check type to Multi-option for the newly added check.
    await firstPart.getByRole("radio", { name: "Multi-option" }).last().click();

    // The component seeds two default options. Add a third for a total of three.
    await firstPart
      .getByRole("button", { name: /Add option/i })
      .last()
      .click();

    const optionLabels = ["Excellent", "Adequate", "Poor"];
    const optionPoints = [3, 2, 1];

    // Rename the three placeholder option labels in order. The most-recently-added
    // check is at the bottom of the part, so `.last()` consistently targets it.
    await firstPart.locator('input[value="Option 1"]').last().fill(optionLabels[0]);
    await firstPart.locator('input[value="Option 2"]').last().fill(optionLabels[1]);
    await firstPart.locator('input[value="Option 3"]').last().fill(optionLabels[2]);

    // Set points by walking from each renamed label to the next number input.
    for (let i = 0; i < 3; i++) {
      const labelInput = firstPart.locator(`input[value="${optionLabels[i]}"]`).last();
      const pointsInput = labelInput.locator("xpath=following::input[@type='number'][1]");
      await pointsInput.fill(String(optionPoints[i]));
    }

    await page.getByTestId("rubric-save").click();
    await expect(page.getByText("Rubric Saved")).toBeVisible({ timeout: 15_000 });

    // Reload and verify the option block is still there.
    await page.reload();
    await selectGradingReviewTab(page);
    await expect(page.locator('input[value="Excellent"]').first()).toBeVisible();
    await expect(page.locator('input[value="Adequate"]').first()).toBeVisible();
    await expect(page.locator('input[value="Poor"]').first()).toBeVisible();

    const supabase = adminDb();
    const { data: checkRow } = await supabase
      .from("rubric_checks")
      .select("name, data")
      .eq("rubric_id", optionsAssignment!.grading_rubric_id!)
      .eq("name", "Options check")
      .maybeSingle();
    expect(checkRow).not.toBeNull();
    const data = checkRow!.data as { options?: { label: string; points: number }[] } | null;
    expect(data?.options).toBeDefined();
    expect(data!.options!.map((o) => o.label).sort()).toEqual([...optionLabels].sort());
  });

  test("Deduction-only criterion flag flows to DB", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${deductionAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    const firstPart = page.getByTestId("rubric-part-0");
    await firstPart.scrollIntoViewIfNeeded();
    // The first seeded criterion in Part 1 is "Grading Review Criteria". Switch its scoring mode.
    await firstPart.getByRole("radio", { name: "Deduction only" }).first().click();

    await page.getByTestId("rubric-save").click();
    await expect(page.getByText("Rubric Saved")).toBeVisible({ timeout: 15_000 });

    const supabase = adminDb();
    const { data: criteria } = await supabase
      .from("rubric_criteria")
      .select("name, is_additive, is_deduction_only")
      .eq("rubric_id", deductionAssignment!.grading_rubric_id!)
      .eq("name", "Grading Review Criteria");
    expect(criteria).toBeDefined();
    expect(criteria!.length).toBeGreaterThan(0);
    expect(criteria![0].is_additive).toBe(false);
    expect(criteria![0].is_deduction_only).toBe(true);
  });

  test("Switching to GUI fails when YAML has both is_individual_grading and is_assign_to_student", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${mutexAssignment!.id}/rubric`);
    await selectGradingReviewTab(page);

    // Capture the current YAML, then hand-edit it to be invalid.
    await page.getByTestId("rubric-source-toggle").click();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();

    // Compose YAML that sets both mutually-exclusive flags on a part.
    const invalidYaml = [
      "name: Grading Rubric",
      "review_round: grading-review",
      "parts:",
      "  - name: Bad Part",
      "    is_individual_grading: true",
      "    is_assign_to_student: true",
      "    criteria:",
      "      - name: Criterion 1",
      "        total_points: 1",
      "        is_additive: true",
      "        checks:",
      "          - name: Check 1",
      "            points: 1",
      ""
    ].join("\n");
    await setMonacoValue(page, invalidYaml);

    // Try to switch back to GUI — should be rejected and stay in source mode.
    await page.getByTestId("rubric-gui-toggle").click();
    // Either a validation toast appears or the GUI silently refuses; assert the source pane is still active.
    await expect(page.getByTestId("rubric-source-pane")).toBeVisible();
    // The GUI pane should NOT have rendered.
    await expect(page.getByTestId("rubric-gui-pane")).toHaveCount(0);
  });

  test("References round-trip through GUI and YAML", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${referencesAssignment!.id}/rubric`);

    // Seed: save the self-review rubric first so its check ids are real, then save grading-review.
    await selectSelfReviewTab(page);
    // The default empty self-review needs a part + criterion + check. Add a minimal structure via GUI.
    await page.getByTestId("rubric-add-part").click();
    const newPart = page.getByTestId("rubric-part-0");
    await newPart.getByLabel("Name").first().fill("Self Review Part");
    await newPart.getByTestId("rubric-add-criterion").click();
    await page.getByTestId("rubric-add-criterion-template-blank").click();
    // Rename criterion + first check to make them findable.
    await newPart.locator('input[value="New criterion"]').first().fill("Self Criterion");
    await newPart.locator('input[value="New check"]').first().fill("Self Target Check");
    await page.getByTestId("rubric-save").click();
    await expect(page.getByText("Rubric Saved")).toBeVisible({ timeout: 15_000 });

    // Switch to grading-review and add a reference from its first check.
    await selectGradingReviewTab(page);
    const gradingPart = page.getByTestId("rubric-part-0");
    await gradingPart.scrollIntoViewIfNeeded();
    // Expand the References collapsible on the first check.
    await gradingPart
      .getByRole("button", { name: /References/i })
      .first()
      .click();
    await gradingPart
      .getByRole("button", { name: /Add reference/i })
      .first()
      .click();
    const refSelect = gradingPart.getByLabel("Select reference target").first();
    // Select by matching the visible option text. We pick whichever option contains "Self Target Check".
    const optionValue = await refSelect.evaluate((sel: HTMLSelectElement) => {
      const opt = Array.from(sel.options).find((o) => o.textContent?.includes("Self Target Check"));
      return opt ? opt.value : "";
    });
    expect(optionValue).not.toBe("");
    await refSelect.selectOption(optionValue);
    await gradingPart.getByRole("button", { name: /^Add$/ }).first().click();

    await page.getByTestId("rubric-save").click();
    await expect(page.getByText("Rubric Saved")).toBeVisible({ timeout: 15_000 });

    // Reload and verify the reference is still visible in the GUI.
    await page.reload();
    await selectGradingReviewTab(page);
    await page
      .getByTestId("rubric-part-0")
      .getByRole("button", { name: /References/i })
      .first()
      .click();
    await expect(page.getByText(/Self Target Check/).first()).toBeVisible();

    // Switch to source and confirm the YAML has a `references:` block in name-keyed form.
    await page.getByTestId("rubric-source-toggle").click();
    const yaml = await getMonacoValue(page);
    expect(yaml).toMatch(/references:/);
    expect(yaml).toContain("Self Target Check");
    expect(yaml).toContain("self-review");

    // Switch back to GUI — reference still there.
    await page.getByTestId("rubric-gui-toggle").click();
    await page
      .getByTestId("rubric-part-0")
      .getByRole("button", { name: /References/i })
      .first()
      .click();
    await expect(page.getByText(/Self Target Check/).first()).toBeVisible();

    // DB verification.
    const supabase = adminDb();
    const { data: refs } = await supabase
      .from("rubric_check_references")
      .select("id, referencing_rubric_check_id, referenced_rubric_check_id")
      .eq("rubric_id", referencesAssignment!.grading_rubric_id!);
    expect(refs).toBeDefined();
    expect(refs!.length).toBeGreaterThan(0);
  });

  test("Cross-round save with unsaved sibling tab does not create the reference", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course!.id}/manage/assignments/${crossRoundAssignment!.id}/rubric`);

    // Build & save self-review first so its check has a real id we can target.
    await selectSelfReviewTab(page);
    await page.getByTestId("rubric-add-part").click();
    const srPart = page.getByTestId("rubric-part-0");
    await srPart.getByLabel("Name").first().fill("Self Review Part");
    await srPart.getByTestId("rubric-add-criterion").click();
    await page.getByTestId("rubric-add-criterion-template-blank").click();
    await srPart.locator('input[value="New check"]').first().fill("Sibling Target Check");
    await page.getByTestId("rubric-save").click();
    await expect(page.getByText("Rubric Saved")).toBeVisible({ timeout: 15_000 });

    // Now: dirty the self-review tab (unsaved edit) and DO NOT save.
    await srPart.locator('input[value="Sibling Target Check"]').first().fill("Sibling Target Check Edited");
    // Confirm the tab label reflects the unsaved state.
    await expect(page.getByRole("tab", { name: /Self Review.*Unsaved/i })).toBeVisible();

    // Switch to grading-review and attempt to add a reference targeting the self-review check.
    await selectGradingReviewTab(page);
    const gradingPart = page.getByTestId("rubric-part-0");
    await gradingPart.scrollIntoViewIfNeeded();
    await gradingPart
      .getByRole("button", { name: /References/i })
      .first()
      .click();
    await gradingPart
      .getByRole("button", { name: /Add reference/i })
      .first()
      .click();
    // The matching option in the typeahead should be present but disabled with a "save tab first" hint;
    // the explicit Add button is also disabled. We force the reference into the YAML to exercise the
    // server-side rejection path instead.
    await gradingPart
      .getByRole("button", { name: /Cancel/i })
      .first()
      .click();

    // Manually add the reference via the source view (bypasses the disabled UI).
    await page.getByTestId("rubric-source-toggle").click();
    const yaml = await getMonacoValue(page);
    // Inject a references block onto the first check by string-replacing the first " points:" line.
    const injected = yaml.replace(
      /(\bpoints:\s*\d+\s*\n)/,
      `$1            references:\n              - review_round: self-review\n                check: Sibling Target Check Edited\n`
    );
    await setMonacoValue(page, injected);

    // Save grading-review. We expect a warning toast about the unsaved sibling tab and NO new reference row.
    await page.getByTestId("rubric-save").click();
    // The save itself succeeds (rubric body still saves), but the references portion warns.
    await expect(page.getByText(/Reference target unsaved/i)).toBeVisible({ timeout: 15_000 });

    const supabase = adminDb();
    const { data: refs } = await supabase
      .from("rubric_check_references")
      .select("id")
      .eq("rubric_id", crossRoundAssignment!.grading_rubric_id!);
    expect(refs ?? []).toHaveLength(0);
  });
});
