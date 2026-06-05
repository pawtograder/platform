import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  setGradingEditorPreference,
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Verifies the folder-tree left pane and keyboard navigation that replace the old flat file list
// (issues #288 and #103a). Asserts both UI state (active highlight, URL file_id) and that keystrokes
// are NOT stolen while the grader is typing in a comment box.

let course: Course;
let instructor: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;

// Nested files added on top of the pre-baked sample.java so the tree has real folders to render.
const NESTED_FILES = [
  { name: "src/main/Alpha.java", contents: "class Alpha { int a() { return 1; } }\n" },
  { name: "src/main/Beta.java", contents: "class Beta { int b() { return 2; } }\n" },
  { name: "src/test/AlphaTest.java", contents: "class AlphaTest { void t() {} }\n" },
  { name: "README.md", contents: "# Readme\n" }
];

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Tree Student",
      email: "tree-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Tree Instructor",
      email: "tree-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Tree Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = res.submission_id;

  const { error } = await supabase.from("submission_files").insert(
    NESTED_FILES.map((f) => ({
      name: f.name,
      contents: f.contents,
      class_id: course.id,
      submission_id: submission_id!,
      profile_id: student!.private_profile_id
    }))
  );
  if (error) throw new Error(`Failed to insert nested files: ${error.message}`);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

async function openFiles(page: Parameters<typeof loginAsUser>[0]) {
  await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
  await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByLabel("File navigator")).toBeVisible();
}

test.describe("File-tree navigation (#288 / #103a)", () => {
  test.setTimeout(120_000);

  test("renders folders and files; folders collapse and expand", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    const nav = page.getByLabel("File navigator");
    // Folder rows + nested file basenames are present (all folders start expanded).
    await expect(nav.getByText("src", { exact: true })).toBeVisible();
    await expect(nav.getByText("Alpha.java", { exact: true })).toBeVisible();
    await expect(nav.getByText("AlphaTest.java", { exact: true })).toBeVisible();
    await expect(nav.getByText("README.md", { exact: true })).toBeVisible();

    // Collapsing the top "src" folder hides its descendants.
    await nav.getByText("src", { exact: true }).click();
    await expect(nav.getByText("Alpha.java", { exact: true })).toBeHidden();
    // README.md (a root file) stays visible.
    await expect(nav.getByText("README.md", { exact: true })).toBeVisible();
    // Re-expanding brings them back.
    await nav.getByText("src", { exact: true }).click();
    await expect(nav.getByText("Alpha.java", { exact: true })).toBeVisible();
  });

  test("clicking a file activates it (URL file_id + single bright highlight)", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    const nav = page.getByLabel("File navigator");
    await nav.getByText("Beta.java", { exact: true }).click();

    // Content shows and the URL reflects the selection.
    await expect(page.getByText("class Beta")).toBeVisible();
    const { data: betaFile } = await supabase
      .from("submission_files")
      .select("id")
      .eq("submission_id", submission_id!)
      .eq("name", "src/main/Beta.java")
      .single();
    await expect.poll(() => new URL(page.url()).searchParams.get("file_id")).toBe(String(betaFile!.id));

    // Exactly one active row, and it is the file we picked.
    await expect(nav.locator("[data-active='true']")).toHaveCount(1);
    await expect(nav.locator(`[data-active='true'][data-file-id='${betaFile!.id}']`)).toBeVisible();
  });

  test("arrow / j-k keys move between adjacent files in tree order", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    const nav = page.getByLabel("File navigator");

    // Resolve the file ids for the two adjacent files we will hop between.
    const { data: files } = await supabase
      .from("submission_files")
      .select("id, name")
      .eq("submission_id", submission_id!)
      .in("name", ["src/main/Alpha.java", "src/main/Beta.java"]);
    const alphaId = files!.find((f) => f.name === "src/main/Alpha.java")!.id;
    const betaId = files!.find((f) => f.name === "src/main/Beta.java")!.id;

    // Select Alpha.java, focus the pane, then ArrowDown moves to the next file (Beta.java).
    await nav.getByText("Alpha.java", { exact: true }).click();
    await expect(nav.locator(`[data-active='true'][data-file-id='${alphaId}']`)).toBeVisible();
    await nav.click();
    await page.keyboard.press("ArrowDown");
    await expect(nav.locator(`[data-active='true'][data-file-id='${betaId}']`)).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("file_id")).toBe(String(betaId));

    // k (up) returns to Alpha.java.
    await page.keyboard.press("k");
    await expect(nav.locator(`[data-active='true'][data-file-id='${alphaId}']`)).toBeVisible();
  });

  test("GUARD: keystrokes are ignored while typing in a comment box", async ({ page }) => {
    // The free-text comment popup ("Leave a comment") lives in the classic plain/starry-night viewer,
    // so opt this grader out of the now-default Monaco editor before loading the page.
    await setGradingEditorPreference(instructor!.user_id, false);
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    const nav = page.getByLabel("File navigator");
    await nav.click();
    const activeBefore = await nav.locator("[data-active='true']").getAttribute("data-file-id");

    // Open a free-text comment box on a line via the annotation popup.
    await page.getByText("public static void main(").click({ button: "right" });
    await page.getByRole("option", { name: "Leave a comment" }).click();
    const commentBox = page.getByRole("textbox", { name: "Add a comment about this line" });
    await commentBox.click();
    await commentBox.fill("jjjj kkkk"); // these keys must NOT navigate files

    await expect(commentBox).toHaveValue("jjjj kkkk");
    // Active file is unchanged — the global nav handler bailed inside the textbox.
    await expect(nav.locator("[data-active='true']")).toHaveAttribute("data-file-id", activeBefore!);
  });
});
