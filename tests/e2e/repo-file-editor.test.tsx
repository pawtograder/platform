import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { addDays } from "date-fns";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, supabase, TestingUser } from "./TestingUtils";

test.setTimeout(120_000);

const GRADER_REPO = "pawtograder-playground/test-e2e-repo-file-editor";

// Valid against the bundled assignment-action v4 schema (lib/schemas/pawtograder.schema.json):
// `grader`, `build` and `submissionFiles` are required, and a regular graded unit needs
// name/tests/points/testCount.
const VALID_PAWTOGRADER = `grader: overlay
build:
  preset: java-gradle
  cmd: ./gradlew test
  artifacts: []
  linter:
    preset: checkstyle
    policy: fail
submissionFiles:
  files:
    - "**/*.java"
  testFiles: []
gradedParts:
  - name: Part 1
    gradedUnits:
      - name: Unit 1
        tests: "[T1.1]"
        points: 10
        testCount: 1
`;

/** The schema modeline assignment-action scaffolds into pawtograder.yml, for a given git ref. */
const modeline = (ref: string) =>
  `# yaml-language-server: $schema=https://raw.githubusercontent.com/pawtograder/assignment-action/refs/${ref}/pawtograder.schema.json\n`;

const VALID_WORKFLOW = `name: Grade
on:
  push:
    branches: [main]
jobs:
  grade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

// CORS headers so the cross-origin (localhost:3000 -> 127.0.0.1:54321) fetch + preflight pass.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*"
};

let course: Course;
let instructor: TestingUser;
let assignment: Assignment;

test.beforeAll(async () => {
  course = (await createClass({ name: "Repo File Editor Course" })) as Course;
  [instructor] = await createUsersInClass([
    { role: "instructor", class_id: course.id, name: "Repo Editor Instructor", useMagicLink: true }
  ]);
  assignment = await insertAssignment({
    class_id: course.id,
    name: "Repo Editor Assignment",
    due_date: addDays(new Date(), 7).toISOString()
  });
  // The autograder page only mounts the editor when a grader repo is configured.
  const { error } = await supabase.from("autograder").update({ grader_repo: GRADER_REPO }).eq("id", assignment.id);
  if (error) throw new Error(`Failed to set grader_repo: ${error.message}`);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor]);
});

/** Set the active Monaco model's value (fires the editor onChange -> React state). */
async function setEditorValue(page: import("@playwright/test").Page, text: string, pathHint: string) {
  await page.evaluate(
    ({ text, pathHint }) => {
      const monaco = (window as unknown as { monaco?: typeof import("monaco-editor") }).monaco;
      if (!monaco) throw new Error("monaco not available on window");
      const models = monaco.editor.getModels();
      const model = models.find((m) => m.uri.toString().includes(pathHint));
      if (!model) throw new Error(`No Monaco model found for path hint: ${pathHint}`);
      model.setValue(text);
    },
    { text, pathHint }
  );
}

/**
 * Wait for the "Edit config files" panel and return it, clearing any first-login interstitial that
 * shows up on the way. The welcome modal is aria-modal, so while it is open the rest of the page is
 * hidden from the accessibility tree and `getByRole` finds nothing.
 */
async function openConfigEditor(page: import("@playwright/test").Page) {
  const region = page.getByRole("group", { name: "Edit config files" });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await region.isVisible({ timeout: 1000 }).catch(() => false)) break;
    const dismiss = page.locator("button", { hasText: /^(OK|Got it|Close)$/ }).first();
    if (await dismiss.isVisible({ timeout: 1000 }).catch(() => false)) {
      await dismiss.click({ timeout: 5000, force: true }).catch(() => page.keyboard.press("Escape"));
    }
    await page.waitForTimeout(500);
  }
  await expect(region).toBeVisible({ timeout: 15_000 });
  // Wait for Monaco to mount and load the fetched content.
  await expect.poll(async () => page.evaluate(() => !!(window as unknown as { monaco?: unknown }).monaco)).toBe(true);
  return region;
}

test.describe("Repo file editor", () => {
  test.describe.configure({ mode: "serial" });

  test("pawtograder.yml: invalid blocks save, valid commits with correct payload", async ({ page }) => {
    let lastWrite: Record<string, unknown> | null = null;

    await page.route("**/functions/v1/repository-get-file", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
      const body = JSON.parse(route.request().postData() || "{}");
      const content = String(body.path).includes("workflows") ? VALID_WORKFLOW : VALID_PAWTOGRADER;
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ content, sha: "sha-abc" })
      });
    });
    await page.route("**/functions/v1/repository-write-file", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
      lastWrite = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ commit_sha: "c1", content_sha: "sha-def" })
      });
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/autograder`);

    // Scope to the "Edit config files" panel on the autograder page.
    const region = await openConfigEditor(page);

    // Introduce an invalid pawtograder.yml -> structural guard blocks save.
    await setEditorValue(page, "gradedParts: not-an-array\n", "pawtograder.yml");
    await expect(region.getByTestId("repo-file-editor-errors")).toBeVisible({ timeout: 15_000 });
    await expect(region.getByTestId("repo-file-editor-save")).toBeDisabled();

    // Fix it -> save becomes enabled and commits.
    await setEditorValue(page, VALID_PAWTOGRADER, "pawtograder.yml");
    await expect(region.getByTestId("repo-file-editor-errors")).toHaveCount(0, { timeout: 15_000 });
    const saveBtn = region.getByTestId("repo-file-editor-save");
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // The write went through with a well-formed payload (path, loaded sha, commit message).
    await expect.poll(() => lastWrite, { timeout: 15_000 }).not.toBeNull();
    expect(lastWrite!.path).toBe("pawtograder.yml");
    expect(lastWrite!.sha).toBe("sha-abc");
    expect(String(lastWrite!.message).length).toBeGreaterThan(0);
  });

  // Regression: the file's `# yaml-language-server: $schema=<url>` modeline takes priority over the
  // editor's fileMatch association, and resolving it used to hit the (disabled) schema request
  // service — blocking every save with "No schema request service available". The bundled schema is
  // now also registered under the modeline's URL.
  test("pawtograder.yml: a v4 schema modeline resolves to the bundled schema", async ({ page }) => {
    await page.route("**/functions/v1/repository-get-file", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
      const body = JSON.parse(route.request().postData() || "{}");
      const content = String(body.path).includes("workflows")
        ? VALID_WORKFLOW
        : modeline("tags/v4") + VALID_PAWTOGRADER;
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ content, sha: "sha-abc" })
      });
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/autograder`);

    const region = await openConfigEditor(page);

    // The modeline resolves locally: no schema-request error, no unresolved-schema notice, and the
    // file (valid for v4) is committable.
    await setEditorValue(page, modeline("tags/v4") + VALID_PAWTOGRADER, "pawtograder.yml");
    await expect(region.getByTestId("repo-file-editor-errors")).toHaveCount(0, { timeout: 20_000 });
    await expect(region.getByTestId("repo-file-editor-schema-warning")).toHaveCount(0);
    await expect(region.getByTestId("repo-file-editor-save")).toBeEnabled();

    // And the schema really is in force: v4 sets additionalProperties: false, so an unknown
    // top-level key is flagged (the structural guard alone would not catch this).
    await setEditorValue(
      page,
      modeline("tags/v4") + VALID_PAWTOGRADER + "totallyUnknownKey: true\n",
      "pawtograder.yml"
    );
    const errors = region.getByTestId("repo-file-editor-errors");
    await expect(errors).toBeVisible({ timeout: 20_000 });
    await expect(errors).toContainText("totallyUnknownKey");
    await expect(errors).not.toContainText("No schema request service available");
    await expect(region.getByTestId("repo-file-editor-save")).toBeDisabled();
  });

  // A modeline pinning a version the bundled schema does not describe (v3 predates the `grader`
  // key) must not be validated against v4's rules, and must not block committing either.
  test("pawtograder.yml: an unbundled schema version warns without blocking the save", async ({ page }) => {
    await page.route("**/functions/v1/repository-get-file", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
      const body = JSON.parse(route.request().postData() || "{}");
      const content = String(body.path).includes("workflows")
        ? VALID_WORKFLOW
        : modeline("tags/v3") + VALID_PAWTOGRADER;
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ content, sha: "sha-abc" })
      });
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/autograder`);

    const region = await openConfigEditor(page);

    await setEditorValue(page, modeline("tags/v3") + VALID_PAWTOGRADER, "pawtograder.yml");
    await expect(region.getByTestId("repo-file-editor-schema-warning")).toBeVisible({ timeout: 20_000 });
    await expect(region.getByTestId("repo-file-editor-errors")).toHaveCount(0);
    await expect(region.getByTestId("repo-file-editor-save")).toBeEnabled();
  });

  test("workflow file: schema flags an unknown top-level key", async ({ page }) => {
    await page.route("**/functions/v1/repository-get-file", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
      const body = JSON.parse(route.request().postData() || "{}");
      const content = String(body.path).includes("workflows") ? VALID_WORKFLOW : VALID_PAWTOGRADER;
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ content, sha: "sha-abc" })
      });
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/autograder`);

    const region = await openConfigEditor(page);

    // Switch the editor to the workflow file (loads the GitHub Actions schema).
    await region.getByLabel("Select file to edit").selectOption(".github/workflows/grade.yml");
    // Wait for the async load to settle (commit message reflects the new file) so the
    // injected content below isn't clobbered by the in-flight load.
    await expect(region.getByRole("textbox", { name: "Commit message" })).toHaveValue(/grade\.yml/, {
      timeout: 15_000
    });
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (window as unknown as { monaco?: typeof import("monaco-editor") })
            .monaco!.editor.getModels()
            .some((m) => m.uri.toString().includes("workflows"))
        )
      )
      .toBe(true);

    // An unknown top-level key violates the workflow schema (additionalProperties: false);
    // the yaml language server flags it, the editor surfaces it, and save is blocked.
    await setEditorValue(page, "totallyUnknownKey: true\non: push\njobs: {}\n", "workflows");
    await expect(region.getByTestId("repo-file-editor-errors")).toBeVisible({ timeout: 20_000 });
    await expect(region.getByTestId("repo-file-editor-save")).toBeDisabled();
  });
});
