import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { addDays } from "date-fns";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, supabase, TestingUser } from "./TestingUtils";

test.setTimeout(120_000);

const GRADER_REPO = "pawtograder-playground/test-e2e-repo-file-editor";

const VALID_PAWTOGRADER = `build:
  preset: java-gradle
  cmd: ./gradlew test
  artifacts: []
  linter:
    preset: checkstyle
    policy: warn
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
`;

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
      const model = models.find((m) => m.uri.toString().includes(pathHint)) ?? models[models.length - 1];
      model.setValue(text);
    },
    { text, pathHint }
  );
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
    const region = page.getByRole("group", { name: "Edit config files" });
    await expect(region).toBeVisible({ timeout: 30_000 });
    // Wait for Monaco to mount and load the fetched content.
    await expect.poll(async () => page.evaluate(() => !!(window as unknown as { monaco?: unknown }).monaco)).toBe(true);

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

    const region = page.getByRole("group", { name: "Edit config files" });
    await expect(region).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => page.evaluate(() => !!(window as unknown as { monaco?: unknown }).monaco)).toBe(true);

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
