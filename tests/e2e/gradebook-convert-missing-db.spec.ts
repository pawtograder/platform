/**
 * "Convert Missing to 0" is one server-side statement
 * (supabase/migrations/20261125120100_gradebook_convert_missing_to_zero.sql): it converts only cells
 * that are still missing when it writes them, so a grade already entered is kept, and it queues the
 * converted rows for recalculation.
 */
import { expect, test } from "@playwright/test";
import { createClass, createUserInClass, supabase, type TestingUser } from "./TestingUtils";

test.describe("Convert Missing to 0", () => {
  test.describe.configure({ timeout: 120_000 });
  let classId: number;
  let gradebookId: number;
  let graded: TestingUser;
  let missing: TestingUser;

  test.beforeAll(async () => {
    const course = await createClass({ name: "E2E Gradebook Convert Missing" });
    classId = course.id;
    graded = await createUserInClass({ role: "student", class_id: classId, name: "Convert Graded Student" });
    missing = await createUserInClass({ role: "student", class_id: classId, name: "Convert Missing Student" });
    const { data, error } = await supabase.from("classes").select("gradebook_id").eq("id", classId).single();
    if (error || !data?.gradebook_id) throw new Error(`No gradebook for class ${classId}: ${error?.message}`);
    gradebookId = data.gradebook_id;
  });

  test("converts missing cells of a manual column and keeps entered grades", async () => {
    const { data: column, error: columnError } = await supabase
      .from("gradebook_columns")
      .insert({
        class_id: classId,
        gradebook_id: gradebookId,
        slug: "convert-missing-manual",
        name: "Convert Missing Manual",
        max_score: 10,
        released: false,
        sort_order: 0
      })
      .select("id")
      .single();
    expect(columnError).toBeNull();
    const columnId = column!.id;

    const cell = async (student: TestingUser) => {
      let row: { id: number; score: number | null; score_override: number | null; is_missing: boolean } | null = null;
      await expect
        .poll(async () => {
          const { data } = await supabase
            .from("gradebook_column_students")
            .select("id, score, score_override, is_missing")
            .eq("gradebook_column_id", columnId)
            .eq("student_id", student.private_profile_id)
            .eq("is_private", true)
            .maybeSingle();
          row = data;
          return data !== null;
        })
        .toBe(true);
      return row!;
    };

    const gradedCell = await cell(graded);
    const { error: gradeError } = await supabase.rpc("update_gradebook_column_student_with_recalc", {
      p_id: gradedCell.id,
      p_updates: { score: 7, is_missing: false }
    });
    expect(gradeError).toBeNull();

    const { data: converted, error } = await supabase.rpc("convert_gradebook_column_missing_to_zero", {
      p_column_id: columnId
    });
    expect(error).toBeNull();
    expect(converted).toBe(1);

    const after = await cell(missing);
    expect(after.score).toBe(0);
    expect(after.is_missing).toBe(false);
    expect((await cell(graded)).score).toBe(7);

    // Nothing is missing any more, so a second run converts nothing.
    const { data: again } = await supabase.rpc("convert_gradebook_column_missing_to_zero", { p_column_id: columnId });
    expect(again).toBe(0);
  });
});
