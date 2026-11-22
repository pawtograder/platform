import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createClass, insertAssignment, supabase } from "@/tests/e2e/TestingUtils";

// sync_gradebook_column_from_assignment_trigger (#891): renaming an assignment renames the gradebook column
// whose score expression is exactly assignments("<slug>"), and changing total_points still updates its max_score.
test.describe("gradebook column follows its assignment", () => {
  let classId: number;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let n = 0;

  test.beforeAll(async () => {
    classId = (await createClass({ name: `E2E Gradebook Column Sync ${suffix}` })).id;
  });

  async function newAssignment() {
    n++;
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      name: `Column Sync ${n} ${suffix}`,
      assignment_slug: `cs${n}-${suffix}`
    });
    const { data: column, error } = await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("class_id", classId)
      .eq("score_expression", `assignments("${assignment.slug}")`)
      .single();
    if (error || !column) throw new Error(`No gradebook column for ${assignment.slug}: ${error?.message}`);
    return { assignmentId: assignment.id, columnId: column.id };
  }

  async function update(table: "assignments" | "gradebook_columns", id: number, values: Record<string, unknown>) {
    const { error } = await supabase.from(table).update(values).eq("id", id);
    if (error) throw new Error(`Failed to update ${table} ${id}: ${error.message}`);
  }

  async function column(id: number) {
    const { data, error } = await supabase.from("gradebook_columns").select("name, max_score").eq("id", id).single();
    if (error || !data) throw new Error(`Failed to read gradebook column ${id}: ${error?.message}`);
    return data;
  }

  test("a renamed assignment renames its column", async () => {
    const { assignmentId, columnId } = await newAssignment();
    await update("assignments", assignmentId, { title: `Renamed ${suffix}` });
    expect((await column(columnId)).name).toBe(`Renamed ${suffix}`);
  });

  test("a hand-renamed header follows the title again on the next rename", async () => {
    const { assignmentId, columnId } = await newAssignment();
    await update("gradebook_columns", columnId, { name: "Hand-written header" });
    await update("assignments", assignmentId, { title: `Renamed again ${suffix}` });
    expect((await column(columnId)).name).toBe(`Renamed again ${suffix}`);
  });

  test("a column whose expression an instructor changed keeps its name", async () => {
    const { assignmentId, columnId } = await newAssignment();
    const { data } = await supabase.from("assignments").select("slug").eq("id", assignmentId).single();
    await update("gradebook_columns", columnId, {
      name: "Curved",
      score_expression: `assignments("${data!.slug}") * 1.1`
    });
    await update("assignments", assignmentId, { title: `Not followed ${suffix}` });
    expect((await column(columnId)).name).toBe("Curved");
  });

  test("the matching column follows even when gradebook_column_id is unset", async () => {
    const { assignmentId, columnId } = await newAssignment();
    await update("assignments", assignmentId, { gradebook_column_id: null });
    await update("assignments", assignmentId, { title: `Unlinked ${suffix}` });
    expect((await column(columnId)).name).toBe(`Unlinked ${suffix}`);
  });

  test("changing total_points still updates the column's max_score", async () => {
    const { assignmentId, columnId } = await newAssignment();
    await update("assignments", assignmentId, { total_points: 42 });
    expect(Number((await column(columnId)).max_score)).toBe(42);
  });
});
