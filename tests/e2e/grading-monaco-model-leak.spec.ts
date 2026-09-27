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
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Regression test for the production "[NNN] potential listener LEAK detected, having 200 listeners
// already" warning that surfaced after the submission view migrated to the Monaco grading editor
// (#565). Monaco is a process-wide singleton: every text model it creates registers a listener on a
// shared service, and that listener only goes away when the model is disposed. The grading page tears
// the editor down and rebuilds it on every file switch, so any model that escapes disposal accumulates
// across the whole SPA session until the count crosses Monaco's leak threshold.
//
// Two escapes were fixed in code-file-monaco.tsx: (1) the editor used a useId()-derived model-URI
// authority, which is stable per tree position, so a remount at the same position could adopt the
// previous mount's models instead of cleanly owning its own; (2) @monaco-editor/react auto-creates a
// throwaway model and attaches it before onMount, and we replaced it without ever disposing it.
//
// Rather than drive the count all the way to 200, this test switches files many times and asserts the
// number of *live* Monaco models stays bounded — with either bug it grows roughly one model per switch.

const FILES: { name: string; contents: string }[] = [
  { name: "alpha.py", contents: "# ALPHA_MARKER\nclass Alpha:\n    def run(self):\n        return 1\n" },
  { name: "bravo.py", contents: "# BRAVO_MARKER\nclass Bravo:\n    def run(self):\n        return 2\n" },
  {
    name: "charlie.ts",
    contents: "// CHARLIE_MARKER\nexport class Charlie {\n  run(): number {\n    return 3;\n  }\n}\n"
  },
  { name: "delta.ts", contents: "// DELTA_MARKER\nexport class Delta {\n  run(): number {\n    return 4;\n  }\n}\n" }
];

// A unique token present only in each file, used to confirm the editor has actually swapped to it
// (i.e. the new mount finished and created its models) before we trigger the next switch.
const TOKEN_BY_NAME: Record<string, string> = {
  "alpha.py": "ALPHA_MARKER",
  "bravo.py": "BRAVO_MARKER",
  "charlie.ts": "CHARLIE_MARKER",
  "delta.ts": "DELTA_MARKER"
};

let course: Course;
let instructor: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;
const fileIdByName = new Map<string, number>();

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Leak Student",
      email: "leak-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Leak Instructor",
      email: "leak-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Monaco Leak Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id,
    files: FILES
  });
  submission_id = res.submission_id;

  const { data: fileRows, error: filesError } = await supabase
    .from("submission_files")
    .select("id, name")
    .eq("submission_id", submission_id!);
  if (filesError) throw new Error(`Failed to load submission files: ${filesError.message}`);
  for (const row of fileRows ?? []) {
    fileIdByName.set(row.name, row.id);
  }
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Monaco grading viewer model leak", () => {
  test.setTimeout(180_000);

  test("switching files repeatedly does not accumulate Monaco models", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    const firstFile = "alpha.py";
    const firstId = fileIdByName.get(firstFile);
    expect(firstId, `file id for ${firstFile}`).toBeDefined();
    await page.goto(
      `/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files?file_id=${firstId}`,
      // This route keeps long-lived realtime/websocket connections open, so the "load" event is
      // unreliable; wait for the DOM instead and then for the editor itself below.
      { waitUntil: "domcontentloaded" }
    );

    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".view-line", { hasText: TOKEN_BY_NAME[firstFile] }).first()).toBeVisible({
      timeout: 30_000
    });

    // Monaco is loaded from the CDN by @monaco-editor/loader, which assigns the global `monaco`. Confirm
    // we can read the live model registry before relying on it for the assertion.
    const modelCount = () =>
      page.evaluate(() => {
        const m = (window as unknown as { monaco?: { editor: { getModels(): unknown[] } } }).monaco;
        return m ? m.editor.getModels().length : -1;
      });

    const baseline = await modelCount();
    expect(baseline, "window.monaco should be exposed so we can count models").toBeGreaterThan(0);

    // Switch through the files in the navigator many times. Each switch unmounts and remounts the editor
    // (the page swaps in a loading skeleton mid-switch), so a per-mount model leak compounds here.
    const order = ["bravo.py", "charlie.ts", "delta.ts", "alpha.py"];
    const ROUNDS = 4; // 16 switches total
    for (let round = 0; round < ROUNDS; round++) {
      for (const name of order) {
        const id = fileIdByName.get(name);
        expect(id, `file id for ${name}`).toBeDefined();
        await page.locator(`[data-file-navigator] [data-file-id="${id}"]`).first().click();
        // Wait for the editor to actually show this file — proves the new mount finished and created
        // its models, so the count we read at the end reflects settled state, not a mid-switch blip.
        await expect(page.locator(".view-line", { hasText: TOKEN_BY_NAME[name] }).first()).toBeVisible({
          timeout: 15_000
        });
      }
    }

    // Let any in-flight switch settle, then count. With the leak, the registry would hold roughly
    // `baseline + number_of_switches` models; fixed, it stays around one mount's worth.
    await page.waitForTimeout(500);
    const finalCount = await modelCount();

    const upperBound = baseline + FILES.length * 2;
    expect(
      finalCount,
      `live Monaco models after ${ROUNDS * order.length} switches (baseline ${baseline}); a value near ` +
        `baseline + switches indicates the model leak has regressed`
    ).toBeLessThanOrEqual(upperBound);
  });
});
