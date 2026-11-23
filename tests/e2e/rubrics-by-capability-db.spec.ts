/**
 * #1010: editing rubrics follows manage_rubrics (20261123150300_rubrics_by_capability.sql).
 *
 * Writing rubrics, rubric_parts, rubric_criteria, rubric_checks and rubric_check_references, and
 * saving through update_rubric_full, need manage_rubrics in the class. The default instructor role
 * holds it; the default grader role doesn't. Reading rubrics doesn't change.
 *
 * update_rubric_full also fills the assignment's empty link to the rubric, so a Head TA with
 * manage_rubrics but not manage_assignments can create one, and refuses a create for a round that
 * already has a rubric. A part, criterion or check can't move to another rubric, a rubric can't
 * move to another class, assignment or review round, and a part, criterion, check or reference must
 * use its rubric's assignment.
 *
 * PostgREST reports a blocked insert as an error, but an update or delete that RLS hides changes 0
 * rows without one, so each blocked write is checked and then confirmed through the service client.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { addDays } from "date-fns";
import { test, expect } from "../global-setup";
import {
  supabase,
  createClass,
  createUserInClass,
  createAuthenticatedClient,
  insertAssignment,
  type TestingUser
} from "./TestingUtils";

type WriteResult = { data: unknown[] | null; error: unknown };

function expectBlocked({ data, error }: WriteResult, what: string) {
  expect(error !== null || (data ?? []).length === 0, `${what} must be blocked`).toBe(true);
}

// An INSERT policy is checked before the primary key and foreign keys, so a working policy gives
// 42501 (and nothing else) for every insert below.
function expectRlsBlocked({ error }: WriteResult, what: string) {
  expect((error as { code?: string } | null)?.code, `${what} must be refused by RLS`).toBe("42501");
}

const RUBRIC_TABLES = [
  "rubrics",
  "rubric_parts",
  "rubric_criteria",
  "rubric_checks",
  "rubric_check_references"
] as const;
type RubricTable = (typeof RUBRIC_TABLES)[number];

test.describe("rubrics follow manage_rubrics (#1010)", () => {
  let classR: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;
  // One row per table, all on assignment's grading rubric, for the update and delete checks.
  const rowIds = {} as Record<RubricTable, number>;
  let partId: number;
  let criteriaId: number;
  let checkId: number;

  async function newAssignment(slug: string) {
    return insertAssignment({
      class_id: classR.id,
      due_date: addDays(new Date(), 14).toISOString(),
      assignment_slug: `e2e-rubric-${slug}-${Date.now().toString(36)}`
    });
  }

  test.beforeAll(async () => {
    classR = await createClass({ name: "E2E Rubrics By Capability R" });
    instructor = await createUserInClass({ role: "instructor", class_id: classR.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classR.id });
    headTa = await createUserInClass({ role: "grader", class_id: classR.id });
    assignment = await newAssignment("base");

    const rubricId = assignment.grading_rubric_id!;
    const base = { class_id: classR.id, assignment_id: assignment.id, rubric_id: rubricId };
    const { data: part, error: partError } = await supabase
      .from("rubric_parts")
      .insert({ ...base, name: "Fixture part", ordinal: 50 })
      .select("id")
      .single();
    expect(partError).toBeNull();
    partId = part!.id;
    const { data: criteria, error: criteriaError } = await supabase
      .from("rubric_criteria")
      .insert({ ...base, rubric_part_id: partId, name: "Fixture criterion", total_points: 4, is_additive: true })
      .select("id")
      .single();
    expect(criteriaError).toBeNull();
    criteriaId = criteria!.id;
    const { data: checks, error: checksError } = await supabase
      .from("rubric_checks")
      .insert([
        {
          ...base,
          rubric_criteria_id: criteriaId,
          name: "Fixture check A",
          ordinal: 0,
          is_annotation: false,
          points: 2
        },
        {
          ...base,
          rubric_criteria_id: criteriaId,
          name: "Fixture check B",
          ordinal: 1,
          is_annotation: false,
          points: 2
        }
      ])
      .select("id, ordinal")
      .order("ordinal");
    expect(checksError).toBeNull();
    checkId = checks![0].id;
    const { data: reference, error: referenceError } = await supabase
      .from("rubric_check_references")
      .insert({ ...base, referencing_rubric_check_id: checks![0].id, referenced_rubric_check_id: checks![1].id })
      .select("id")
      .single();
    expect(referenceError).toBeNull();
    Object.assign(rowIds, {
      rubrics: rubricId,
      rubric_parts: partId,
      rubric_criteria: criteriaId,
      rubric_checks: checkId,
      rubric_check_references: reference!.id
    });

    // A Head TA: a custom role (a copy of the default grader role) with manage_rubrics turned on.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classR.id, name: "Rubric TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_rubrics" })).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", headTa.user_id)
          .eq("class_id", classR.id)
      ).error
    ).toBeNull();
  });

  /** A row for each table that a writer would try to insert, on the given rubric. */
  function newRows(target: { class_id: number; assignment_id: number; rubric_id: number }) {
    return {
      rubrics: {
        class_id: target.class_id,
        assignment_id: target.assignment_id,
        name: "Inserted rubric",
        review_round: "meta-grading-review" as const
      },
      rubric_parts: { ...target, name: "Inserted part", ordinal: 90 },
      rubric_criteria: {
        ...target,
        rubric_part_id: partId,
        name: "Inserted criterion",
        total_points: 1,
        is_additive: true
      },
      rubric_checks: {
        ...target,
        rubric_criteria_id: criteriaId,
        name: "Inserted check",
        ordinal: 90,
        is_annotation: false,
        points: 1
      },
      rubric_check_references: {
        ...target,
        referencing_rubric_check_id: rowIds.rubric_checks,
        referenced_rubric_check_id: rowIds.rubric_checks
      }
    };
  }

  async function rowExists(table: RubricTable, id: number) {
    const { data, error } = await supabase.from(table).select("id").eq("id", id);
    expect(error).toBeNull();
    return (data ?? []).length === 1;
  }

  function payload(fields: { id?: number; assignment_id: number; review_round: string; name: string }) {
    return {
      ...fields,
      class_id: classR.id,
      parts: [
        {
          name: "Saved part",
          criteria: [{ name: "Saved criterion", total_points: 5, checks: [{ name: "Saved check", points: 5 }] }]
        }
      ]
    };
  }

  test("a default grader can't write any rubric table or save a rubric", async () => {
    const client = await createAuthenticatedClient(plainGrader);
    const rows = newRows({ class_id: classR.id, assignment_id: assignment.id, rubric_id: rowIds.rubrics });

    for (const table of RUBRIC_TABLES) {
      expectRlsBlocked(await client.from(table).insert(rows[table]).select("id"), `${table} insert`);

      expectBlocked(
        await client.from(table).update({ class_id: classR.id }).eq("id", rowIds[table]).select("id"),
        `${table} update`
      );

      // A policy denial: no error and no rows. A foreign-key error (23503) would mean a delete
      // policy let the grader through.
      const deleted = await client.from(table).delete().eq("id", rowIds[table]).select("id");
      expect(deleted.error, `${table} delete`).toBeNull();
      expect(deleted.data, `${table} delete`).toEqual([]);
      expect(await rowExists(table, rowIds[table]), `${table} row is still there`).toBe(true);
    }

    const { error } = await client.rpc("update_rubric_full", {
      p_rubric: payload({
        id: rowIds.rubrics,
        assignment_id: assignment.id,
        review_round: "grading-review",
        name: "Renamed by a grader"
      }) as never
    });
    expect(error?.message).toMatch(/Not authorized to edit rubrics/);
    const { data: rubric } = await supabase.from("rubrics").select("name").eq("id", rowIds.rubrics).single();
    expect(rubric!.name).not.toBe("Renamed by a grader");
  });

  test("a default grader still reads the rubric", async () => {
    const client = await createAuthenticatedClient(plainGrader);
    for (const table of RUBRIC_TABLES) {
      const { data, error } = await client.from(table).select("id").eq("id", rowIds[table]);
      expect(error, table).toBeNull();
      expect(data ?? [], `${table} is readable`).toHaveLength(1);
    }
  });

  test("a grader on a custom role with manage_rubrics saves a rubric and writes the tables", async () => {
    const own = await newAssignment("head-ta");
    const client = await createAuthenticatedClient(headTa);

    const { error } = await client.rpc("update_rubric_full", {
      p_rubric: payload({
        id: own.grading_rubric_id!,
        assignment_id: own.id,
        review_round: "grading-review",
        name: "Saved by the Head TA"
      }) as never
    });
    expect(error).toBeNull();
    const { data: rubric } = await supabase
      .from("rubrics")
      .select("name, rubric_parts(name)")
      .eq("id", own.grading_rubric_id!)
      .single();
    expect(rubric!.name).toBe("Saved by the Head TA");
    expect(rubric!.rubric_parts.map((p) => p.name)).toEqual(["Saved part"]);

    const { data: part, error: insertError } = await client
      .from("rubric_parts")
      .insert({
        class_id: classR.id,
        assignment_id: own.id,
        rubric_id: own.grading_rubric_id!,
        name: "Direct part",
        ordinal: 9
      })
      .select("id")
      .single();
    expect(insertError).toBeNull();
    const { data: updated } = await client
      .from("rubric_parts")
      .update({ name: "Direct part, renamed" })
      .eq("id", part!.id)
      .select("id");
    expect(updated ?? []).toHaveLength(1);
    const { data: deleted } = await client.from("rubric_parts").delete().eq("id", part!.id).select("id");
    expect(deleted ?? []).toHaveLength(1);

    // A criterion, check and reference whose parents are on the same rubric go through.
    const onFixture = { class_id: classR.id, assignment_id: assignment.id, rubric_id: rowIds.rubrics };
    const { data: criterion, error: criterionError } = await client
      .from("rubric_criteria")
      .insert({ ...onFixture, rubric_part_id: partId, name: "Head TA criterion", total_points: 1, is_additive: true })
      .select("id")
      .single();
    expect(criterionError).toBeNull();
    const { data: check, error: checkError } = await client
      .from("rubric_checks")
      .insert({
        ...onFixture,
        rubric_criteria_id: criterion!.id,
        name: "Head TA check",
        ordinal: 0,
        is_annotation: false,
        points: 1
      })
      .select("id")
      .single();
    expect(checkError).toBeNull();
    const { error: referenceError } = await client
      .from("rubric_check_references")
      .insert({ ...onFixture, referencing_rubric_check_id: check!.id, referenced_rubric_check_id: checkId })
      .select("id")
      .single();
    expect(referenceError).toBeNull();
  });

  test("a new rubric is linked to its assignment by update_rubric_full, without manage_assignments", async () => {
    const own = await newAssignment("meta");
    expect(own.meta_grading_rubric_id).toBeNull();
    const client = await createAuthenticatedClient(headTa);

    // The Head TA can't edit the assignment itself, so the link below must come from the function.
    const { data: assignmentWrite } = await client
      .from("assignments")
      .update({ title: "Renamed by the Head TA" })
      .eq("id", own.id)
      .select("id");
    expect(assignmentWrite ?? [], "the Head TA has no manage_assignments").toHaveLength(0);

    const { error } = await client.rpc("update_rubric_full", {
      p_rubric: payload({ assignment_id: own.id, review_round: "meta-grading-review", name: "Meta rubric" }) as never
    });
    expect(error).toBeNull();

    const { data: created } = await supabase
      .from("rubrics")
      .select("id")
      .eq("assignment_id", own.id)
      .eq("review_round", "meta-grading-review")
      .single();
    const { data: linked } = await supabase
      .from("assignments")
      .select("meta_grading_rubric_id")
      .eq("id", own.id)
      .single();
    expect(linked!.meta_grading_rubric_id).toBe(created!.id);

    // A second create for the same round (two editors who opened the empty round at once) is
    // refused and rolled back: no second rubric, and the link stays on the first.
    const { error: secondError } = await client.rpc("update_rubric_full", {
      p_rubric: payload({ assignment_id: own.id, review_round: "meta-grading-review", name: "Second meta" }) as never
    });
    expect(secondError?.code, "a create for a round that already has a rubric").toBe("23505");
    expect(secondError?.message).toContain("just created by someone else");
    expect(secondError?.hint, "the editor recognizes the round conflict by its hint").toBe("rubric_round_conflict");
    const { data: metaRubrics } = await supabase
      .from("rubrics")
      .select("id")
      .eq("assignment_id", own.id)
      .eq("review_round", "meta-grading-review");
    expect((metaRubrics ?? []).map((r) => r.id)).toEqual([created!.id]);
    const { data: stillLinked } = await supabase
      .from("assignments")
      .select("meta_grading_rubric_id")
      .eq("id", own.id)
      .single();
    expect(stillLinked!.meta_grading_rubric_id).toBe(created!.id);
  });

  // The editor treats only the round conflict as an expected refusal. Another duplicate key, here
  // the same reference listed twice, is a 23505 without that hint, so the editor reports it as an
  // unexpected error instead of telling the user someone else created the rubric.
  test("a duplicate reference in the payload is a 23505 without the round-conflict hint", async () => {
    const own = await newAssignment("dup-ref");
    const client = await createAuthenticatedClient(headTa);
    const base = payload({
      id: own.grading_rubric_id!,
      assignment_id: own.id,
      review_round: "grading-review",
      name: "Duplicate reference"
    });
    const reference = { referenced_rubric_check_id: checkId };
    const withDuplicate = {
      ...base,
      parts: [
        {
          ...base.parts[0],
          criteria: [
            {
              ...base.parts[0].criteria[0],
              checks: [{ name: "Saved check", points: 5, references: [reference, reference] }]
            }
          ]
        }
      ]
    };
    const { error } = await client.rpc("update_rubric_full", { p_rubric: withDuplicate as never });
    expect(error?.code, "the same reference twice").toBe("23505");
    expect(error?.hint ?? null).not.toBe("rubric_round_conflict");
    const { data: rubric } = await supabase.from("rubrics").select("name").eq("id", own.grading_rubric_id!).single();
    expect(rubric!.name, "the save was rolled back").not.toBe("Duplicate reference");
  });

  test("saving an existing rubric fills its assignment's empty link", async () => {
    // A rubric left unlinked, as the old two-step save could leave one.
    const own = await newAssignment("relink");
    const rubricId = own.grading_rubric_id!;
    expect((await supabase.from("assignments").update({ grading_rubric_id: null }).eq("id", own.id)).error).toBeNull();

    const client = await createAuthenticatedClient(headTa);
    const { error } = await client.rpc("update_rubric_full", {
      // A wrong round in the payload doesn't matter: the rubric's stored round picks the link.
      p_rubric: payload({
        id: rubricId,
        assignment_id: own.id,
        review_round: "self-review",
        name: "Relinked"
      }) as never
    });
    expect(error).toBeNull();
    const { data: linked } = await supabase
      .from("assignments")
      .select("grading_rubric_id, self_review_rubric_id")
      .eq("id", own.id)
      .single();
    expect(linked!.grading_rubric_id).toBe(rubricId);
    expect(linked!.self_review_rubric_id).toBe(own.self_review_rubric_id);
  });

  test("a part, criterion or check can't be moved to another rubric", async () => {
    // Another rubric in the same class, with a part and a criterion, so the policies alone would
    // allow the moves.
    const other = await newAssignment("move");
    const otherRubricId = other.grading_rubric_id!;
    const { data: otherPart, error: otherPartError } = await supabase
      .from("rubric_parts")
      .insert({
        class_id: classR.id,
        assignment_id: other.id,
        rubric_id: otherRubricId,
        name: "Other part",
        ordinal: 0
      })
      .select("id")
      .single();
    expect(otherPartError).toBeNull();
    const { data: otherCriterion, error: otherCriterionError } = await supabase
      .from("rubric_criteria")
      .insert({
        class_id: classR.id,
        assignment_id: other.id,
        rubric_id: otherRubricId,
        rubric_part_id: otherPart!.id,
        name: "Other criterion",
        total_points: 1,
        is_additive: true
      })
      .select("id")
      .single();
    expect(otherCriterionError).toBeNull();

    const client = await createAuthenticatedClient(headTa);
    const movePart = await client
      .from("rubric_parts")
      .update({ rubric_id: otherRubricId })
      .eq("id", partId)
      .select("id");
    expect((movePart.error as { code?: string } | null)?.code, "moving a part").toBe("23514");
    const moveCriterion = await client
      .from("rubric_criteria")
      .update({ rubric_id: otherRubricId, rubric_part_id: otherPart!.id })
      .eq("id", criteriaId)
      .select("id");
    expect((moveCriterion.error as { code?: string } | null)?.code, "moving a criterion").toBe("23514");
    const moveCheck = await client
      .from("rubric_checks")
      .update({ rubric_id: otherRubricId, rubric_criteria_id: otherCriterion!.id, assignment_id: other.id })
      .eq("id", checkId)
      .select("id");
    expect((moveCheck.error as { code?: string } | null)?.code, "moving a check").toBe("23514");

    const { data: part } = await supabase.from("rubric_parts").select("rubric_id").eq("id", partId).single();
    expect(part!.rubric_id).toBe(rowIds.rubrics);
    const { data: criterion } = await supabase
      .from("rubric_criteria")
      .select("rubric_id, rubric_part_id")
      .eq("id", criteriaId)
      .single();
    expect(criterion).toEqual({ rubric_id: rowIds.rubrics, rubric_part_id: partId });
    const { data: check } = await supabase
      .from("rubric_checks")
      .select("rubric_id, rubric_criteria_id")
      .eq("id", checkId)
      .single();
    expect(check).toEqual({ rubric_id: rowIds.rubrics, rubric_criteria_id: criteriaId });

    // Moving a criterion to another part of the same rubric still works.
    const base = { class_id: classR.id, assignment_id: assignment.id, rubric_id: rowIds.rubrics };
    const { data: secondPart, error: secondPartError } = await supabase
      .from("rubric_parts")
      .insert({ ...base, name: "Second fixture part", ordinal: 51 })
      .select("id")
      .single();
    expect(secondPartError).toBeNull();
    const { data: movable, error: movableError } = await supabase
      .from("rubric_criteria")
      .insert({ ...base, rubric_part_id: partId, name: "Movable criterion", total_points: 1, is_additive: true })
      .select("id")
      .single();
    expect(movableError).toBeNull();
    const { data: moved, error: moveError } = await client
      .from("rubric_criteria")
      .update({ rubric_part_id: secondPart!.id })
      .eq("id", movable!.id)
      .select("id");
    expect(moveError).toBeNull();
    expect(moved ?? []).toHaveLength(1);

    // And a check to another criterion of the same rubric.
    const { data: movableCheck, error: movableCheckError } = await supabase
      .from("rubric_checks")
      .insert({
        ...base,
        rubric_criteria_id: criteriaId,
        name: "Movable check",
        ordinal: 80,
        is_annotation: false,
        points: 1
      })
      .select("id")
      .single();
    expect(movableCheckError).toBeNull();
    const { data: movedCheck, error: moveCheckError } = await client
      .from("rubric_checks")
      .update({ rubric_criteria_id: movable!.id })
      .eq("id", movableCheck!.id)
      .select("id");
    expect(moveCheckError).toBeNull();
    expect(movedCheck ?? []).toHaveLength(1);
  });

  test("a rubric can't move to another class, assignment or review round", async () => {
    const own = await newAssignment("place");
    const other = await newAssignment("place-other");
    const rubricId = own.grading_rubric_id!;
    const client = await createAuthenticatedClient(headTa);

    const toAssignment = await client
      .from("rubrics")
      .update({ assignment_id: other.id })
      .eq("id", rubricId)
      .select("id");
    expect((toAssignment.error as { code?: string } | null)?.code, "another assignment").toBe("23514");
    const toRound = await client
      .from("rubrics")
      .update({ review_round: "self-review" })
      .eq("id", rubricId)
      .select("id");
    expect((toRound.error as { code?: string } | null)?.code, "another review round").toBe("23514");
    // The Head TA isn't in another class, so the service client tries this one: the trigger
    // refuses it for everyone.
    const otherClass = await createClass({ name: "E2E Rubrics By Capability place" });
    const toClass = await supabase.from("rubrics").update({ class_id: otherClass.id }).eq("id", rubricId).select("id");
    expect((toClass.error as { code?: string } | null)?.code, "another class").toBe("23514");

    const { data: rubric } = await supabase
      .from("rubrics")
      .select("class_id, assignment_id, review_round")
      .eq("id", rubricId)
      .single();
    expect(rubric).toEqual({ class_id: classR.id, assignment_id: own.id, review_round: "grading-review" });

    // Other fields still save.
    const { data: renamed, error: renameError } = await client
      .from("rubrics")
      .update({ name: "Renamed rubric" })
      .eq("id", rubricId)
      .select("id");
    expect(renameError).toBeNull();
    expect(renamed ?? []).toHaveLength(1);
  });

  test("a rubric check reference must use its rubric's assignment", async () => {
    const other = await newAssignment("ref");
    const client = await createAuthenticatedClient(headTa);
    const onFixture = { class_id: classR.id, rubric_id: rowIds.rubrics };

    const { data: fixtureChecks } = await supabase
      .from("rubric_checks")
      .select("id")
      .eq("rubric_criteria_id", criteriaId)
      .order("ordinal")
      .limit(2);
    const inserted = await client
      .from("rubric_check_references")
      .insert({
        ...onFixture,
        assignment_id: other.id,
        referencing_rubric_check_id: fixtureChecks![1].id,
        referenced_rubric_check_id: fixtureChecks![0].id
      })
      .select("id");
    expectRlsBlocked(inserted, "a reference with another assignment's id");

    const updated = await client
      .from("rubric_check_references")
      .update({ assignment_id: other.id })
      .eq("id", rowIds.rubric_check_references)
      .select("id");
    expectBlocked(updated, "moving a reference to another assignment");
    const { data: reference } = await supabase
      .from("rubric_check_references")
      .select("assignment_id")
      .eq("id", rowIds.rubric_check_references)
      .single();
    expect(reference!.assignment_id).toBe(assignment.id);
  });

  test("a rubric part, criterion or check must use its rubric's assignment", async () => {
    // The app loads parts and criteria by assignment_id, so a row filed under another assignment
    // would show up in that assignment's rubric.
    const other = await newAssignment("child-assignment");
    const client = await createAuthenticatedClient(headTa);
    const rows = newRows({ class_id: classR.id, assignment_id: other.id, rubric_id: rowIds.rubrics });

    for (const table of ["rubric_parts", "rubric_criteria", "rubric_checks"] as const) {
      const inserted = await client.from(table).insert(rows[table]).select("id");
      expectRlsBlocked(inserted, `a ${table} row with another assignment's id`);

      const updated = await client.from(table).update({ assignment_id: other.id }).eq("id", rowIds[table]).select("id");
      expectBlocked(updated, `moving a ${table} row to another assignment`);
      const { data: row } = await supabase.from(table).select("assignment_id").eq("id", rowIds[table]).single();
      expect(row!.assignment_id, table).toBe(assignment.id);
    }
  });

  test("an instructor still saves rubrics", async () => {
    const own = await newAssignment("instructor");
    const client = await createAuthenticatedClient(instructor);
    const { error } = await client.rpc("update_rubric_full", {
      p_rubric: payload({
        id: own.grading_rubric_id!,
        assignment_id: own.id,
        review_round: "grading-review",
        name: "Saved by the instructor"
      }) as never
    });
    expect(error).toBeNull();
    const { data: rubric } = await supabase.from("rubrics").select("name").eq("id", own.grading_rubric_id!).single();
    expect(rubric!.name).toBe("Saved by the instructor");
  });

  test("manage_rubrics in one class doesn't reach another class's rubrics", async () => {
    const otherClass = await createClass({ name: "E2E Rubrics By Capability Other" });
    const other = await insertAssignment({
      class_id: otherClass.id,
      due_date: addDays(new Date(), 14).toISOString(),
      assignment_slug: `e2e-rubric-other-${Date.now().toString(36)}`
    });
    const client = await createAuthenticatedClient(headTa);

    // Rows that claim the Head TA's class but sit on the other class's rubric or assignment.
    const pointedAtOther = newRows({
      class_id: classR.id,
      assignment_id: assignment.id,
      rubric_id: other.grading_rubric_id!
    });
    for (const table of RUBRIC_TABLES) {
      if (table === "rubrics") continue;
      expectRlsBlocked(
        await client.from(table).insert(pointedAtOther[table]).select("id"),
        `${table} on another class's rubric`
      );
    }
    expectRlsBlocked(
      await client
        .from("rubrics")
        .insert({ class_id: classR.id, assignment_id: other.id, name: "On another class's assignment" })
        .select("id"),
      "a rubric on another class's assignment"
    );

    // Rows on the Head TA's own rubric whose parent is the other class's part, criterion or check.
    const otherPart = other.rubricParts.find((p) => p.rubric_id === other.grading_rubric_id)!;
    const otherCheck = other.rubricChecks.find((c) => c.rubric_id === other.grading_rubric_id)!;
    const ownRubric = { class_id: classR.id, assignment_id: assignment.id, rubric_id: rowIds.rubrics };
    expectRlsBlocked(
      await client
        .from("rubric_criteria")
        .insert({
          ...ownRubric,
          rubric_part_id: otherPart.id,
          name: "Under a foreign part",
          total_points: 1,
          is_additive: true
        })
        .select("id"),
      "a criterion under another class's part"
    );
    expectRlsBlocked(
      await client
        .from("rubric_checks")
        .insert({
          ...ownRubric,
          rubric_criteria_id: otherCheck.rubric_criteria_id,
          name: "Under a foreign criterion",
          ordinal: 91,
          is_annotation: false,
          points: 1
        })
        .select("id"),
      "a check under another class's criterion"
    );
    expectRlsBlocked(
      await client
        .from("rubric_check_references")
        .insert({
          ...ownRubric,
          referencing_rubric_check_id: rowIds.rubric_checks,
          referenced_rubric_check_id: otherCheck.id
        })
        .select("id"),
      "a reference to another class's check"
    );

    // Rows in the other class itself.
    expectRlsBlocked(
      await client
        .from("rubric_parts")
        .insert({
          class_id: otherClass.id,
          assignment_id: other.id,
          rubric_id: other.grading_rubric_id!,
          name: "Other class part",
          ordinal: 9
        })
        .select("id"),
      "a part in the other class"
    );
    const { error } = await client.rpc("update_rubric_full", {
      p_rubric: {
        ...payload({
          id: other.grading_rubric_id!,
          assignment_id: other.id,
          review_round: "grading-review",
          name: "Renamed from another class"
        }),
        class_id: otherClass.id
      } as never
    });
    expect(error?.message).toMatch(/Not authorized to edit rubrics/);
  });
});
