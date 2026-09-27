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

// Exercises cross-file "go to definition" in the Monaco grading viewer for Java, Python, and
// TypeScript. The submission carries, per language, two files where file A references a symbol
// defined in file B via a valid class/module path. Symbols are produced by the server-side indexer
// (the same `index-submission` edge function used at ingestion), which we invoke directly here so
// the test also covers the edge function + index table end-to-end — no GitHub clone required.

// Each file B embeds a unique marker comment next to its definition; navigation success = that
// marker becoming visible in the editor (it appears in no other file).
const FILES: { name: string; contents: string }[] = [
  {
    name: "com/example/Main.java",
    contents: `package com.example;

public class Main {
  public static void main(String[] args) {
    JavaHelper helper = new JavaHelper();
    System.out.println(helper.answer());
  }
}
`
  },
  {
    name: "com/example/JavaHelper.java",
    contents: `package com.example;

// JAVA_DEFINITION_TARGET
public class JavaHelper {
  public int answer() {
    return 42;
  }
}
`
  },
  {
    name: "main.py",
    contents: `from pyhelper import PyHelper


def main():
    helper = PyHelper()
    print(helper.answer())
`
  },
  {
    name: "pyhelper.py",
    contents: `# PY_DEFINITION_TARGET
class PyHelper:
    def answer(self):
        return 42
`
  },
  {
    name: "main.ts",
    contents: `import { TsHelper } from "./tshelper";

const helper: TsHelper = new TsHelper();
console.log(helper.answer());
`
  },
  {
    name: "tshelper.ts",
    contents: `// TS_DEFINITION_TARGET
export class TsHelper {
  answer(): number {
    return 42;
  }
}
`
  }
];

const CASES = [
  { lang: "Java", aName: "com/example/Main.java", token: "JavaHelper", marker: "JAVA_DEFINITION_TARGET" },
  { lang: "Python", aName: "main.py", token: "PyHelper", marker: "PY_DEFINITION_TARGET" },
  { lang: "TypeScript", aName: "main.ts", token: "TsHelper", marker: "TS_DEFINITION_TARGET" }
];

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
      name: "GTD Student",
      email: "gtd-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "GTD Instructor",
      email: "gtd-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Go To Definition Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id,
    files: FILES
  });
  submission_id = res.submission_id;

  // Build the server-side symbol index for the submission (exercises the edge function + table).
  const { data, error } = await supabase.functions.invoke("index-submission", {
    body: { submission_id }
  });
  if (error) throw new Error(`index-submission failed: ${error.message}`);
  expect((data as { indexed: number }).indexed).toBeGreaterThan(0);

  // Map file names to ids so tests can deep-link to a specific file via ?file_id=.
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

test.describe("Cross-file go to definition (Monaco grading viewer)", () => {
  test.setTimeout(120_000);

  for (const { lang, aName, token, marker } of CASES) {
    test(`${lang}: F12 on a cross-file reference jumps to the defining file`, async ({ page }) => {
      await loginAsUser(page, instructor!, course);

      const fileId = fileIdByName.get(aName);
      expect(fileId, `file id for ${aName}`).toBeDefined();
      await page.goto(
        `/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files?file_id=${fileId}`
      );

      // Wait for the Monaco editor to mount with file A's content.
      const editor = page.locator(".monaco-editor").first();
      await expect(editor).toBeVisible();
      await expect(editor.locator(".view-line", { hasText: token }).first()).toBeVisible();

      // Place the cursor inside the referenced symbol, then trigger Go to Definition.
      await editor.getByText(token, { exact: true }).first().click();
      const editorInput = page.locator(".monaco-editor textarea.inputarea").first();
      await expect(editorInput).toBeFocused();
      await page.keyboard.press("F12");

      // The editor should switch to the defining file and reveal its definition — the unique marker
      // (present only in file B) becomes visible.
      await expect(page.locator(".view-line", { hasText: marker })).toBeVisible({ timeout: 15_000 });
    });
  }
});
