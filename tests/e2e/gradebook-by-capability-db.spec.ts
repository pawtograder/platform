/**
 * #1010: arranging the gradebook follows manage_gradebook (20261119120200_gradebook_by_capability.sql).
 *
 * Adding, editing and deleting gradebook columns, deleting cells and row state, renaming and
 * deleting column groups and topics, and the RPCs that reorder, auto-layout, group, import and
 * release columns need manage_gradebook in the class. The default instructor role holds it; the
 * default grader role doesn't. Reading the gradebook and overriding a cell stay as they are.
 *
 * PostgREST reports a blocked insert as an error, but an update or delete that RLS hides changes 0
 * rows without one, so each blocked write is checked and then confirmed through the service client.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { test, expect } from "../global-setup";
import { supabase, createClass, createUserInClass, createAuthenticatedClient, type TestingUser } from "./TestingUtils";

type WriteResult = { data: unknown[] | null; error: unknown };

function expectBlocked({ data, error }: WriteResult, what: string) {
  expect(error !== null || (data ?? []).length === 0, `${what} must be blocked`).toBe(true);
}

// An INSERT policy and the functions' own checks refuse with 42501 (and nothing else).
function expectRefused({ error }: { error: unknown }, what: string) {
  expect((error as { code?: string } | null)?.code, `${what} must be refused`).toBe("42501");
}

test.describe("gradebook changes follow manage_gradebook (#1010)", () => {
  let classG: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let student: TestingUser;
  let gradebookId: number;
  let otherGradebookId: number;
  // Fixture rows the grader tries to change; the Head TA test makes its own.
  let columnId: number;
  let instructorOnlyColumnId: number;
  let groupId: number;
  let topicId: number;
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  async function gradebookOf(class_id: number) {
    const { data, error } = await supabase.from("classes").select("gradebook_id").eq("id", class_id).single();
    expect(error).toBeNull();
    expect(data!.gradebook_id).not.toBeNull();
    return data!.gradebook_id!;
  }

  async function insertColumn(slug: string, extra: { instructor_only?: boolean } = {}) {
    const { data, error } = await supabase
      .from("gradebook_columns")
      .insert({
        class_id: classG.id,
        gradebook_id: gradebookId,
        slug: `${slug}-${suffix}`,
        name: `Fixture ${slug}`,
        max_score: 10,
        ...extra
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function columnIds() {
    const { data, error } = await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("gradebook_id", gradebookId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("id");
    expect(error).toBeNull();
    return (data ?? []).map((c) => c.id);
  }

  // Row-state rows only appear when a recalculation is queued, so the delete tests make one.
  async function seedRowState() {
    const { error } = await supabase
      .from("gradebook_row_recalc_state")
      .upsert(
        { class_id: classG.id, gradebook_id: gradebookId, student_id: student.private_profile_id, is_private: true },
        { onConflict: "class_id,gradebook_id,student_id,is_private" }
      );
    expect(error).toBeNull();
  }

  async function rowStateCount() {
    const { data, error } = await supabase
      .from("gradebook_row_recalc_state")
      .select("student_id")
      .eq("class_id", classG.id);
    expect(error).toBeNull();
    return (data ?? []).length;
  }

  async function privateCell(column_id: number) {
    const { data, error } = await supabase
      .from("gradebook_column_students")
      .select("id, student_id, score, score_override")
      .eq("gradebook_column_id", column_id)
      .eq("student_id", student.private_profile_id)
      .eq("is_private", true)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function countOf(table: "gradebook_columns" | "gradebook_column_groups" | "gradebook_topics", id: number) {
    const { data, error } = await supabase.from(table).select("id").eq("id", id);
    expect(error).toBeNull();
    return (data ?? []).length;
  }

  test.beforeAll(async () => {
    classG = await createClass({ name: "E2E Gradebook By Capability" });
    instructor = await createUserInClass({ role: "instructor", class_id: classG.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classG.id });
    headTa = await createUserInClass({ role: "grader", class_id: classG.id });
    student = await createUserInClass({ role: "student", class_id: classG.id });
    gradebookId = await gradebookOf(classG.id);
    otherGradebookId = await gradebookOf((await createClass({ name: "E2E Gradebook By Capability Other" })).id);

    columnId = await insertColumn("fixture");
    instructorOnlyColumnId = await insertColumn("fixture-io", { instructor_only: true });

    // The service role passes gradebook_require_instructor, so these build the group and topic.
    const { data: group, error: groupError } = await supabase.rpc("gradebook_column_group_create", {
      p_gradebook_id: gradebookId,
      p_name: `Fixture group ${suffix}`,
      p_column_ids: [columnId]
    });
    expect(groupError).toBeNull();
    groupId = group as number;
    const { data: topic, error: topicError } = await supabase.rpc("gradebook_topic_create", {
      p_gradebook_id: gradebookId,
      p_name: `Fixture topic ${suffix}`
    });
    expect(topicError).toBeNull();
    topicId = topic as number;

    // A Head TA: a custom role (a copy of the default grader role) with manage_gradebook turned on.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classG.id, name: "Gradebook TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_gradebook" })).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", headTa.user_id)
          .eq("class_id", classG.id)
      ).error
    ).toBeNull();
  });

  test("a default grader can't add, edit or delete columns, cells, groups or topics", async () => {
    const client = await createAuthenticatedClient(plainGrader);

    expectRefused(
      await client
        .from("gradebook_columns")
        .insert({
          class_id: classG.id,
          gradebook_id: gradebookId,
          slug: `grader-${suffix}`,
          name: "Added by a grader",
          max_score: 10
        })
        .select("id"),
      "column insert"
    );

    expectBlocked(
      await client.from("gradebook_columns").update({ name: "Renamed by a grader" }).eq("id", columnId).select("id"),
      "column update"
    );
    const { data: column } = await supabase.from("gradebook_columns").select("name").eq("id", columnId).single();
    expect(column!.name).toBe("Fixture fixture");

    expectBlocked(await client.from("gradebook_columns").delete().eq("id", columnId).select("id"), "column delete");
    expect(await countOf("gradebook_columns", columnId)).toBe(1);

    const cell = await privateCell(columnId);
    expectBlocked(
      await client.from("gradebook_column_students").delete().eq("id", cell.id).select("id"),
      "cell delete"
    );
    const { data: cellAfter } = await supabase.from("gradebook_column_students").select("id").eq("id", cell.id);
    expect(cellAfter ?? []).toHaveLength(1);

    await seedRowState();
    const rowStateBefore = await rowStateCount();
    expect(rowStateBefore, "a row-state row to refuse").toBeGreaterThan(0);
    expectBlocked(
      await client.from("gradebook_row_recalc_state").delete().eq("class_id", classG.id).select("student_id"),
      "row state delete"
    );
    expect(await rowStateCount()).toBe(rowStateBefore);

    for (const [table, id] of [
      ["gradebook_column_groups", groupId],
      ["gradebook_topics", topicId]
    ] as const) {
      expectBlocked(
        await client.from(table).update({ name: "Renamed by a grader" }).eq("id", id).select("id"),
        `${table} rename`
      );
      const { data: row } = await supabase.from(table).select("name").eq("id", id).single();
      expect(row!.name, `${table} keeps its name`).not.toBe("Renamed by a grader");
      expectBlocked(await client.from(table).delete().eq("id", id).select("id"), `${table} delete`);
      expect(await countOf(table, id), `${table} row is still there`).toBe(1);
    }
  });

  test("a default grader can't call the gradebook RPCs", async () => {
    const client = await createAuthenticatedClient(plainGrader);
    const order = await columnIds();

    expectRefused(
      await client.rpc("gradebook_columns_reorder", { p_ordered_column_ids: [...order].reverse() }),
      "reorder"
    );
    expect(await columnIds()).toEqual(order);
    expectRefused(await client.rpc("gradebook_auto_layout", { p_gradebook_id: gradebookId }), "auto-layout");
    expectRefused(
      await client.rpc("gradebook_column_group_create", {
        p_gradebook_id: gradebookId,
        p_name: "Grader group",
        p_column_ids: [columnId]
      }),
      "group create"
    );
    expectRefused(
      await client.rpc("gradebook_topic_create", { p_gradebook_id: gradebookId, p_name: "Grader topic" }),
      "topic create"
    );

    const cell = await privateCell(columnId);
    expectRefused(
      await client.rpc("import_gradebook_scores", {
        p_class_id: classG.id,
        p_updates: [{ gradebook_column_id: columnId, entries: [{ student_id: cell.student_id, score: 9 }] }]
      }),
      "import"
    );
    expect((await privateCell(columnId)).score).toBe(cell.score);

    expectRefused(
      await client.rpc("release_instructor_only_gradebook_column", { p_column_id: instructorOnlyColumnId }),
      "release"
    );
    const { data: io } = await supabase
      .from("gradebook_columns")
      .select("instructor_only, released")
      .eq("id", instructorOnlyColumnId)
      .single();
    expect(io).toEqual({ instructor_only: true, released: false });
  });

  test("a default grader still reads the gradebook and overrides a cell", async () => {
    const client = await createAuthenticatedClient(plainGrader);
    for (const [table, id] of [
      ["gradebook_columns", columnId],
      ["gradebook_column_groups", groupId],
      ["gradebook_topics", topicId]
    ] as const) {
      const { data, error } = await client.from(table).select("id").eq("id", id);
      expect(error, table).toBeNull();
      expect(data ?? [], `${table} is readable`).toHaveLength(1);
    }

    const cell = await privateCell(columnId);
    const { error } = await client.rpc("update_gradebook_column_student_with_recalc", {
      p_id: cell.id,
      p_updates: { score_override: 7 }
    });
    expect(error).toBeNull();
    expect(Number((await privateCell(columnId)).score_override)).toBe(7);
  });

  test("a grader on a custom role with manage_gradebook can do each of these", async () => {
    const client = await createAuthenticatedClient(headTa);

    // Columns: add, edit, release, then delete its cells and the column.
    const { data: added, error: addError } = await client
      .from("gradebook_columns")
      .insert({
        class_id: classG.id,
        gradebook_id: gradebookId,
        slug: `head-ta-${suffix}`,
        name: "Added by the Head TA",
        max_score: 10
      })
      .select("id")
      .single();
    expect(addError).toBeNull();
    const ownColumnId = added!.id;
    const { data: edited } = await client
      .from("gradebook_columns")
      .update({ name: "Edited by the Head TA" })
      .eq("id", ownColumnId)
      .select("id");
    expect(edited ?? []).toHaveLength(1);
    const { data: released } = await client
      .from("gradebook_columns")
      .update({ released: true })
      .eq("id", ownColumnId)
      .select("id");
    expect(released ?? []).toHaveLength(1);

    // Import a score into the fixture column.
    const cell = await privateCell(columnId);
    const { error: importError } = await client.rpc("import_gradebook_scores", {
      p_class_id: classG.id,
      p_updates: [{ gradebook_column_id: columnId, entries: [{ student_id: cell.student_id, score: 9 }] }]
    });
    expect(importError).toBeNull();
    expect(Number((await privateCell(columnId)).score)).toBe(9);

    // Reorder and auto-layout.
    const order = await columnIds();
    const reversed = [...order].reverse();
    expect((await client.rpc("gradebook_columns_reorder", { p_ordered_column_ids: reversed })).error).toBeNull();
    expect((await client.rpc("gradebook_auto_layout", { p_gradebook_id: gradebookId })).error).toBeNull();

    // Groups and topics: create, rename, delete.
    const { data: group, error: groupError } = await client.rpc("gradebook_column_group_create", {
      p_gradebook_id: gradebookId,
      p_name: `Head TA group ${suffix}`,
      p_column_ids: [ownColumnId]
    });
    expect(groupError).toBeNull();
    const { data: topic, error: topicError } = await client.rpc("gradebook_topic_create", {
      p_gradebook_id: gradebookId,
      p_name: `Head TA topic ${suffix}`
    });
    expect(topicError).toBeNull();
    for (const [table, id] of [
      ["gradebook_column_groups", group as number],
      ["gradebook_topics", topic as number]
    ] as const) {
      const { data: renamed } = await client
        .from(table)
        .update({ name: `Renamed by the Head TA ${suffix}` })
        .eq("id", id)
        .select("id");
      expect(renamed ?? [], `${table} rename`).toHaveLength(1);
      const { data: deleted } = await client.from(table).delete().eq("id", id).select("id");
      expect(deleted ?? [], `${table} delete`).toHaveLength(1);
    }

    // Release an instructor-only column.
    const ioColumnId = await insertColumn("head-ta-io", { instructor_only: true });
    expect(
      (await client.rpc("release_instructor_only_gradebook_column", { p_column_id: ioColumnId })).error
    ).toBeNull();
    const { data: io } = await supabase
      .from("gradebook_columns")
      .select("instructor_only, released")
      .eq("id", ioColumnId)
      .single();
    expect(io).toEqual({ instructor_only: false, released: true });

    const { data: cellsDeleted } = await client
      .from("gradebook_column_students")
      .delete()
      .eq("gradebook_column_id", ownColumnId)
      .select("id");
    expect((cellsDeleted ?? []).length).toBeGreaterThan(0);
    const { data: columnDeleted } = await client.from("gradebook_columns").delete().eq("id", ownColumnId).select("id");
    expect(columnDeleted ?? []).toHaveLength(1);

    await seedRowState();
    const { data: rowStateDeleted } = await client
      .from("gradebook_row_recalc_state")
      .delete()
      .eq("class_id", classG.id)
      .select("student_id");
    expect((rowStateDeleted ?? []).length, "row state delete").toBeGreaterThan(0);
  });

  test("manage_gradebook in one class doesn't reach another class's gradebook", async () => {
    const client = await createAuthenticatedClient(headTa);

    // A column that claims the Head TA's class but sits on the other class's gradebook.
    expectRefused(
      await client
        .from("gradebook_columns")
        .insert({
          class_id: classG.id,
          gradebook_id: otherGradebookId,
          slug: `cross-${suffix}`,
          name: "On another class's gradebook",
          max_score: 10
        })
        .select("id"),
      "a column on another class's gradebook"
    );
    // An ungrouped column, so only the policy (not the group foreign key) can refuse the move.
    expectRefused(
      await client
        .from("gradebook_columns")
        .update({ gradebook_id: otherGradebookId })
        .eq("id", instructorOnlyColumnId)
        .select("id"),
      "moving a column to another class's gradebook"
    );
    const { data: column } = await supabase
      .from("gradebook_columns")
      .select("gradebook_id")
      .eq("id", instructorOnlyColumnId)
      .single();
    expect(column!.gradebook_id).toBe(gradebookId);

    expectRefused(
      await client.rpc("gradebook_topic_create", { p_gradebook_id: otherGradebookId, p_name: "Other class topic" }),
      "a topic in the other class"
    );
    expectRefused(await client.rpc("gradebook_auto_layout", { p_gradebook_id: otherGradebookId }), "other layout");
  });

  test("an instructor still adds a column and calls the RPCs", async () => {
    const client = await createAuthenticatedClient(instructor);
    const { data: added, error } = await client
      .from("gradebook_columns")
      .insert({
        class_id: classG.id,
        gradebook_id: gradebookId,
        slug: `instructor-${suffix}`,
        name: "Added by the instructor",
        max_score: 10
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect((await client.rpc("gradebook_auto_layout", { p_gradebook_id: gradebookId })).error).toBeNull();
    expect(
      (await client.rpc("gradebook_columns_reorder", { p_ordered_column_ids: await columnIds() })).error
    ).toBeNull();
    // A column's cells don't cascade, so they go first, as in the Head TA test.
    const { error: cellsError } = await client
      .from("gradebook_column_students")
      .delete()
      .eq("gradebook_column_id", added!.id);
    expect(cellsError).toBeNull();
    const { data: deleted, error: deleteError } = await client
      .from("gradebook_columns")
      .delete()
      .eq("id", added!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted ?? []).toHaveLength(1);
  });
});
