/**
 * Gradebook Calculation Correctness Tests
 *
 * Tests gradebook score calculations against manually computed expected values.
 * Covers 5 production usage patterns with release/unrelease workflows.
 *
 * Each fixture creates its own isolated class, students, and gradebook columns.
 * Assertions verify both instructor-visible (is_private=true) and
 * student-visible (is_private=false) scores.
 *
 * Production patterns modeled:
 *   Fixture 1 — Weighted average (mean) with cascading final grade
 *   Fixture 2 — Topic max score with multiple manual attempts
 *   Fixture 3 — Countif for lab participation and skill tracking
 *   Fixture 4 — Instructor-only columns with frozen snapshot on release
 *   Fixture 5 — Score override precedence on manual and calculated columns
 */

import { Course } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { createClass, createUsersInClass, loginAsUser, TestingUser, supabase } from "./TestingUtils";

dotenv.config({ path: ".env.local" });

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

async function getGradebookId(class_id: number): Promise<number> {
  const { data, error } = await supabase.from("gradebooks").select("id").eq("class_id", class_id).single();
  if (error || !data) throw new Error(`No gradebook for class ${class_id}: ${error?.message}`);
  return data.id;
}

/** Create a gradebook column (manual or calculated). Returns column id. */
async function createColumn(opts: {
  class_id: number;
  name: string;
  slug: string;
  max_score: number;
  score_expression?: string | null;
  instructor_only?: boolean;
  sort_order?: number;
  dependencies?: { gradebook_columns?: number[]; assignments?: number[] } | null;
}): Promise<number> {
  const gbId = await getGradebookId(opts.class_id);
  const { data, error } = await supabase
    .from("gradebook_columns")
    .insert({
      class_id: opts.class_id,
      gradebook_id: gbId,
      name: opts.name,
      slug: opts.slug,
      max_score: opts.max_score,
      score_expression: opts.score_expression ?? null,
      instructor_only: opts.instructor_only ?? false,
      sort_order: opts.sort_order ?? 0,
      released: false,
      dependencies: opts.dependencies ?? null
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create column ${opts.slug}: ${error?.message}`);
  return data.id;
}

/** Resolve gradebook_column IDs for a set of slug patterns (glob). */
async function resolveColumnIds(class_id: number, slugPatterns: string[]): Promise<number[]> {
  const { data } = await supabase.from("gradebook_columns").select("id, slug").eq("class_id", class_id);
  if (!data) return [];
  const { minimatch } = await import("minimatch");
  const ids = new Set<number>();
  for (const col of data) {
    if (!col.slug) continue;
    for (const pattern of slugPatterns) {
      if (minimatch(col.slug, pattern)) {
        ids.add(col.id);
      }
    }
  }
  return Array.from(ids);
}

/** Get the private row ID for a (column, student) pair. */
async function getRowId(
  class_id: number,
  column_slug: string,
  student_id: string,
  is_private: boolean
): Promise<number> {
  const { data: col } = await supabase
    .from("gradebook_columns")
    .select("id")
    .eq("class_id", class_id)
    .eq("slug", column_slug)
    .single();
  if (!col) throw new Error(`Column ${column_slug} not found in class ${class_id}`);
  const { data: row, error } = await supabase
    .from("gradebook_column_students")
    .select("id")
    .eq("gradebook_column_id", col.id)
    .eq("student_id", student_id)
    .eq("is_private", is_private)
    .single();
  if (error || !row) throw new Error(`Row not found: ${column_slug}/${student_id}/${is_private}: ${error?.message}`);
  return row.id;
}

/** Wait for a gradebook_column_students record to exist (triggers create them async). */
async function waitForRow(class_id: number, column_slug: string, student_id: string, is_private: boolean) {
  await expect(async () => {
    const id = await getRowId(class_id, column_slug, student_id, is_private);
    expect(id).toBeTruthy();
  }).toPass({ timeout: 30_000 });
}

/** Set score on a PRIVATE row of a manual column. */
async function setScore(class_id: number, column_slug: string, student_id: string, score: number) {
  const rowId = await getRowId(class_id, column_slug, student_id, true);
  const { error } = await supabase.from("gradebook_column_students").update({ score }).eq("id", rowId);
  if (error) throw new Error(`setScore failed for ${column_slug}: ${error.message}`);
}

/** Set score_override on a PRIVATE row. */
async function setOverride(class_id: number, column_slug: string, student_id: string, score_override: number) {
  const rowId = await getRowId(class_id, column_slug, student_id, true);
  const { error } = await supabase.from("gradebook_column_students").update({ score_override }).eq("id", rowId);
  if (error) throw new Error(`setOverride failed for ${column_slug}: ${error.message}`);
}

/** Release a column (triggers sync private->public for manual; triggers recalc for dependents). */
async function releaseColumn(class_id: number, column_slug: string) {
  const { error } = await supabase
    .from("gradebook_columns")
    .update({ released: true })
    .eq("class_id", class_id)
    .eq("slug", column_slug);
  if (error) throw new Error(`Release failed for ${column_slug}: ${error.message}`);
}

/** Unrelease a column (clears public rows for manual columns; triggers recalc for dependents). */
async function unreleaseColumn(class_id: number, column_slug: string) {
  const { error } = await supabase
    .from("gradebook_columns")
    .update({ released: false })
    .eq("class_id", class_id)
    .eq("slug", column_slug);
  if (error) throw new Error(`Unrelease failed for ${column_slug}: ${error.message}`);
}

/** Clear stuck recalculation states, enqueue all calculated rows, and kick the worker. */
async function kickRecalculation(class_id: number) {
  // Clear any stuck recalculating states
  await supabase
    .from("gradebook_row_recalc_state")
    .update({ is_recalculating: false })
    .eq("class_id", class_id)
    .eq("is_recalculating", true);

  // Enqueue recalculation for all calculated column rows in the class.
  // Score changes on manual columns don't auto-enqueue dependent calculated rows,
  // so we need to push them into the PGMQ queue ourselves.
  const { data: calcRows } = await supabase
    .from("gradebook_column_students")
    .select("class_id, gradebook_id, student_id, is_private, gradebook_columns!inner(score_expression)")
    .eq("class_id", class_id)
    .not("gradebook_columns.score_expression", "is", null);

  if (calcRows && calcRows.length > 0) {
    const batch = calcRows.map((r) => ({
      class_id: r.class_id,
      gradebook_id: r.gradebook_id,
      student_id: r.student_id,
      is_private: r.is_private
    }));
    // Deduplicate by unique key
    const seen = new Set<string>();
    const deduped = batch.filter((r) => {
      const key = `${r.class_id}:${r.gradebook_id}:${r.student_id}:${r.is_private}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await supabase.rpc("enqueue_gradebook_row_recalculation_batch", {
      p_rows: deduped as unknown as Record<string, unknown>[]
    });
  }

  await supabase.rpc("invoke_gradebook_recalculation_background_task").then(
    () => {},
    () => {}
  );
  const edgeSecret = process.env.EDGE_FUNCTION_SECRET || process.env.EDGE_FUNCTION_SECRET_OVERRIDE;
  if (edgeSecret) {
    await supabase.functions
      .invoke("gradebook-column-recalculate", { headers: { "x-edge-function-secret": edgeSecret } })
      .catch(() => {});
  } else {
    console.debug("[kickRecalculation] No EDGE_FUNCTION_SECRET; relying on background task only");
  }
}

/**
 * Poll until a gradebook_column_students row matches the expected score.
 * Periodically kicks the recalculation worker to handle slow pg_net.
 */
async function waitForScore(opts: {
  class_id: number;
  student_id: string;
  column_slug: string;
  is_private: boolean;
  expected: number;
  /** Number of decimal places for toBeCloseTo (default 2 → ±0.005) */
  precision?: number;
  timeout?: number;
}) {
  const precision = opts.precision ?? 2;
  const timeout = opts.timeout ?? 90_000;
  let kickCount = 0;

  await expect(async () => {
    if (kickCount < 8) {
      kickCount++;
      await kickRecalculation(opts.class_id);
    }
    const { data: col } = await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("class_id", opts.class_id)
      .eq("slug", opts.column_slug)
      .single();
    expect(col).toBeTruthy();

    const { data, error } = await supabase
      .from("gradebook_column_students")
      .select("score, score_override")
      .eq("gradebook_column_id", col!.id)
      .eq("student_id", opts.student_id)
      .eq("is_private", opts.is_private)
      .single();
    if (error) throw new Error(error.message);

    const effective = data?.score_override ?? data?.score;
    expect(effective).not.toBeNull();
    expect(effective).toBeCloseTo(opts.expected, precision);
  }).toPass({ timeout });
}

/** Poll until a gradebook_column_students row has null effective score (unreleased/cleared). */
async function waitForNullScore(opts: {
  class_id: number;
  student_id: string;
  column_slug: string;
  is_private: boolean;
  timeout?: number;
}) {
  const timeout = opts.timeout ?? 90_000;
  let kickCount = 0;

  await expect(async () => {
    if (kickCount < 8) {
      kickCount++;
      await kickRecalculation(opts.class_id);
    }
    const { data: col } = await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("class_id", opts.class_id)
      .eq("slug", opts.column_slug)
      .single();
    expect(col).toBeTruthy();

    const { data, error } = await supabase
      .from("gradebook_column_students")
      .select("score, score_override")
      .eq("gradebook_column_id", col!.id)
      .eq("student_id", opts.student_id)
      .eq("is_private", opts.is_private)
      .single();
    if (error) throw new Error(error.message);

    const effective = data?.score_override ?? data?.score;
    expect(effective).toBeNull();
  }).toPass({ timeout });
}

/** Create a Supabase client authenticated as a specific student for RLS checks. */
async function createStudentClient(student: TestingUser) {
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Ensure the user has a known password (magic-link users get a random one at creation)
  const knownPassword = student.password;
  await supabase.auth.admin.updateUserById(student.user_id, { password: knownPassword });
  const client = createClient<Database>(process.env.SUPABASE_URL!, anonKey!);
  const { error } = await client.auth.signInWithPassword({ email: student.email, password: knownPassword });
  if (error) throw new Error(`Student login failed: ${error.message}`);
  return client;
}

// ────────────────────────────────────────────────────────────────────
// FIXTURE 1: Weighted Average Course
//
// Models the most common prod pattern: assignment columns → weighted
// mean → weighted final grade with participation.
//
// Columns:
//   leaf-hw1 (manual, max=100)
//   leaf-hw2 (manual, max=100)
//   leaf-hw3 (manual, max=100)
//   leaf-part (manual, max=100)
//   calc-hw-avg = mean(gradebook_columns("leaf-hw*"))   [weighted mean]
//   calc-final  = gradebook_columns("calc-hw-avg") * 0.7
//                + gradebook_columns("leaf-part") * 0.3
//
// Scores (private rows):
//   Alice: hw1=80, hw2=90, hw3=100, part=70
//   Bob:   hw1=60, hw2=80, hw3=70,  part=90
//
// Expected instructor (private) values:
//   Alice hw-avg = 100*(80+90+100)/(100+100+100) = 90
//   Alice final  = 90*0.7 + 70*0.3 = 84
//   Bob   hw-avg = 100*(60+80+70)/300 = 70
//   Bob   final  = 70*0.7 + 90*0.3 = 76
// ────────────────────────────────────────────────────────────────────

test.describe("Fixture 1: Weighted Average Course", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  let course: Course;
  let alice: TestingUser;
  let bob: TestingUser;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Calc Test — Weighted Average" });
    const suffix = Math.random().toString(36).slice(2, 6);
    const users = await createUsersInClass([
      {
        name: "Alice Avg",
        email: `alice-avg-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Bob Avg",
        email: `bob-avg-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Instr Avg",
        email: `instr-avg-${suffix}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    alice = users[0];
    bob = users[1];
    instructor = users[2];

    // Create manual leaf columns
    await createColumn({ class_id: course.id, name: "HW 1", slug: "leaf-hw1", max_score: 100, sort_order: 1 });
    await createColumn({ class_id: course.id, name: "HW 2", slug: "leaf-hw2", max_score: 100, sort_order: 2 });
    await createColumn({ class_id: course.id, name: "HW 3", slug: "leaf-hw3", max_score: 100, sort_order: 3 });
    await createColumn({
      class_id: course.id,
      name: "Participation",
      slug: "leaf-part",
      max_score: 100,
      sort_order: 4
    });

    // Wait for student rows to be created by the insert trigger
    for (const student of [alice, bob]) {
      for (const slug of ["leaf-hw1", "leaf-hw2", "leaf-hw3", "leaf-part"]) {
        await waitForRow(course.id, slug, student.private_profile_id, true);
      }
    }

    // Create calculated columns with explicit dependencies
    const hwDepIds = await resolveColumnIds(course.id, ["leaf-hw*"]);
    await createColumn({
      class_id: course.id,
      name: "HW Average",
      slug: "calc-hw-avg",
      max_score: 100,
      score_expression: "mean(gradebook_columns('leaf-hw*'))",
      dependencies: { gradebook_columns: hwDepIds },
      sort_order: 5
    });

    const finalDepIds = await resolveColumnIds(course.id, ["calc-hw-avg", "leaf-part"]);
    await createColumn({
      class_id: course.id,
      name: "Final Grade",
      slug: "calc-final",
      max_score: 100,
      score_expression: "gradebook_columns('calc-hw-avg') * 0.7 + gradebook_columns('leaf-part') * 0.3",
      dependencies: { gradebook_columns: finalDepIds },
      sort_order: 6
    });

    // Wait for calculated column rows
    for (const student of [alice, bob]) {
      await waitForRow(course.id, "calc-hw-avg", student.private_profile_id, true);
      await waitForRow(course.id, "calc-final", student.private_profile_id, true);
      await waitForRow(course.id, "calc-hw-avg", student.private_profile_id, false);
      await waitForRow(course.id, "calc-final", student.private_profile_id, false);
    }

    // Set scores on manual columns (private rows)
    await setScore(course.id, "leaf-hw1", alice.private_profile_id, 80);
    await setScore(course.id, "leaf-hw2", alice.private_profile_id, 90);
    await setScore(course.id, "leaf-hw3", alice.private_profile_id, 100);
    await setScore(course.id, "leaf-part", alice.private_profile_id, 70);

    await setScore(course.id, "leaf-hw1", bob.private_profile_id, 60);
    await setScore(course.id, "leaf-hw2", bob.private_profile_id, 80);
    await setScore(course.id, "leaf-hw3", bob.private_profile_id, 70);
    await setScore(course.id, "leaf-part", bob.private_profile_id, 90);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([alice, bob, instructor]);
  });

  test("baseline: student public scores are null before any release", async () => {
    // Before any column is released, public (student-visible) rows of manual columns
    // should have null scores. This proves release is required to populate them.
    await waitForNullScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "leaf-hw1",
      is_private: false
    });
    await waitForNullScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "leaf-part",
      is_private: false
    });
    await waitForNullScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "leaf-hw1",
      is_private: false
    });
  });

  test("instructor sees correct private calculated scores", async () => {
    // Alice hw-avg = 100*(80+90+100)/300 = 90
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: true,
      expected: 90
    });
    // Alice final = 90*0.7 + 70*0.3 = 63 + 21 = 84
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-final",
      is_private: true,
      expected: 84
    });

    // Bob hw-avg = 100*(60+80+70)/300 = 70
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: true,
      expected: 70
    });
    // Bob final = 70*0.7 + 90*0.3 = 49 + 27 = 76
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-final",
      is_private: true,
      expected: 76
    });
  });

  test("release hw1 + participation: student sees partial hw average", async () => {
    await releaseColumn(course.id, "leaf-hw1");
    await releaseColumn(course.id, "leaf-part");

    // Public hw1 now has scores, hw2/hw3 are still null.
    // calc-hw-avg public = mean of [hw1_only]:
    //   Alice: 100*80/100 = 80
    //   Bob:   100*60/100 = 60
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 80
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 60
    });

    // calc-final public = hw_avg*0.7 + part*0.3:
    //   Alice: 80*0.7 + 70*0.3 = 56 + 21 = 77
    //   Bob:   60*0.7 + 90*0.3 = 42 + 27 = 69
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 77
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 69
    });

    // Instructor private scores unchanged
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: true,
      expected: 90
    });
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-final",
      is_private: true,
      expected: 84
    });
  });

  test("release hw2: student hw average updates", async () => {
    await releaseColumn(course.id, "leaf-hw2");

    // Public mean now includes hw1 + hw2:
    //   Alice: 100*(80+90)/200 = 85
    //   Bob:   100*(60+80)/200 = 70
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 85
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 70
    });

    // Final updates:
    //   Alice: 85*0.7 + 70*0.3 = 59.5 + 21 = 80.5
    //   Bob:   70*0.7 + 90*0.3 = 49 + 27 = 76
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 80.5
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 76
    });
  });

  test("unrelease hw1: student average drops to hw2-only", async () => {
    await unreleaseColumn(course.id, "leaf-hw1");

    // Public mean now includes only hw2 (hw1 cleared, hw3 never released):
    //   Alice: 100*90/100 = 90
    //   Bob:   100*80/100 = 80
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 90
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 80
    });

    // Final:
    //   Alice: 90*0.7 + 70*0.3 = 63 + 21 = 84
    //   Bob:   80*0.7 + 90*0.3 = 56 + 27 = 83
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 84
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 83
    });

    // Instructor private scores unchanged through all releases
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-final",
      is_private: true,
      expected: 84
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-final",
      is_private: true,
      expected: 76
    });
  });

  test("release all three HW: student matches instructor hw average", async () => {
    await releaseColumn(course.id, "leaf-hw1");
    await releaseColumn(course.id, "leaf-hw3");

    // All three HW now released:
    //   Alice: 100*(80+90+100)/300 = 90  →  final = 90*0.7+70*0.3 = 84
    //   Bob:   100*(60+80+70)/300  = 70  →  final = 70*0.7+90*0.3 = 76
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 90
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-hw-avg",
      is_private: false,
      expected: 70
    });

    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 84
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-final",
      is_private: false,
      expected: 76
    });
  });

  test("student UI shows released grades", async ({ page }) => {
    await loginAsUser(page, alice, course);
    await page.goto(`/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");

    // Wait for the gradebook region to appear, then expand all groups
    await expect(page.getByText("Expand All")).toBeVisible({ timeout: 30_000 });
    await page.getByText("Expand All").click();
    // Wait a tick for state update to propagate
    await page.waitForTimeout(500);

    // Student gradebook should show released columns as cards
    await expect(page.getByRole("article", { name: "Grade for HW 1" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("article", { name: "Grade for HW 2" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("article", { name: "Grade for HW 3" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("article", { name: "Grade for Participation" })).toBeVisible({ timeout: 10_000 });

    // Final grade card should show the student-visible value (84 for Alice).
    const finalCard = page.getByRole("article", { name: "Grade for Final Grade" });
    await expect(finalCard).toBeVisible({ timeout: 10_000 });
    await expect(finalCard).toContainText(/84(\.0+)?/);
  });
});

// ────────────────────────────────────────────────────────────────────
// FIXTURE 2: Topic Max Score with Multiple Attempts
//
// Models the Class 503/507 pattern: multiple manual quiz attempts per
// topic, with max() selecting the best attempt.
//
// Columns:
//   classes-1, classes-2   (manual, max=4 each)
//   lists-1, lists-2       (manual, max=4 each)
//   topic-classes = max(gradebook_columns("classes*"))
//   topic-lists   = max(gradebook_columns("lists*"))
//   topic-avg     = (gradebook_columns("topic-classes").score
//                  + gradebook_columns("topic-lists").score) / 2
//
// Scores:
//   Alice: classes-1=3, classes-2=4, lists-1=2, lists-2=3
//   Bob:   classes-1=2, classes-2=1, lists-1=4, lists-2=4
//
// Expected (private):
//   Alice: topic-classes=4, topic-lists=3, topic-avg=3.5
//   Bob:   topic-classes=2, topic-lists=4, topic-avg=3
// ────────────────────────────────────────────────────────────────────

test.describe("Fixture 2: Topic Max Score", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  let course: Course;
  let alice: TestingUser;
  let bob: TestingUser;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Calc Test — Topic Max" });
    const suffix = Math.random().toString(36).slice(2, 6);
    const users = await createUsersInClass([
      {
        name: "Alice Tmax",
        email: `alice-tmax-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Bob Tmax",
        email: `bob-tmax-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Instr Tmax",
        email: `instr-tmax-${suffix}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    alice = users[0];
    bob = users[1];
    instructor = users[2];

    // Create manual attempt columns
    await createColumn({
      class_id: course.id,
      name: "Quiz: Classes Attempt 1",
      slug: "classes-1",
      max_score: 4,
      sort_order: 1
    });
    await createColumn({
      class_id: course.id,
      name: "Quiz: Classes Attempt 2",
      slug: "classes-2",
      max_score: 4,
      sort_order: 2
    });
    await createColumn({
      class_id: course.id,
      name: "Quiz: Lists Attempt 1",
      slug: "lists-1",
      max_score: 4,
      sort_order: 3
    });
    await createColumn({
      class_id: course.id,
      name: "Quiz: Lists Attempt 2",
      slug: "lists-2",
      max_score: 4,
      sort_order: 4
    });

    for (const student of [alice, bob]) {
      for (const slug of ["classes-1", "classes-2", "lists-1", "lists-2"]) {
        await waitForRow(course.id, slug, student.private_profile_id, true);
      }
    }

    // Create calculated topic max columns
    const classesDepIds = await resolveColumnIds(course.id, ["classes-*"]);
    await createColumn({
      class_id: course.id,
      name: "Classes Topic Max",
      slug: "topic-classes",
      max_score: 4,
      score_expression: "max(gradebook_columns('classes*'))",
      dependencies: { gradebook_columns: classesDepIds },
      sort_order: 5
    });

    const listsDepIds = await resolveColumnIds(course.id, ["lists-*"]);
    await createColumn({
      class_id: course.id,
      name: "Lists Topic Max",
      slug: "topic-lists",
      max_score: 4,
      score_expression: "max(gradebook_columns('lists*'))",
      dependencies: { gradebook_columns: listsDepIds },
      sort_order: 6
    });

    const topicDepIds = await resolveColumnIds(course.id, ["topic-classes", "topic-lists"]);
    await createColumn({
      class_id: course.id,
      name: "Topic Average",
      slug: "topic-avg",
      max_score: 4,
      score_expression: "(gradebook_columns('topic-classes').score + gradebook_columns('topic-lists').score) / 2",
      dependencies: { gradebook_columns: topicDepIds },
      sort_order: 7
    });

    for (const student of [alice, bob]) {
      for (const slug of ["topic-classes", "topic-lists", "topic-avg"]) {
        await waitForRow(course.id, slug, student.private_profile_id, true);
        await waitForRow(course.id, slug, student.private_profile_id, false);
      }
    }

    // Set scores
    await setScore(course.id, "classes-1", alice.private_profile_id, 3);
    await setScore(course.id, "classes-2", alice.private_profile_id, 4);
    await setScore(course.id, "lists-1", alice.private_profile_id, 2);
    await setScore(course.id, "lists-2", alice.private_profile_id, 3);

    await setScore(course.id, "classes-1", bob.private_profile_id, 2);
    await setScore(course.id, "classes-2", bob.private_profile_id, 1);
    await setScore(course.id, "lists-1", bob.private_profile_id, 4);
    await setScore(course.id, "lists-2", bob.private_profile_id, 4);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([alice, bob, instructor]);
  });

  test("instructor sees correct topic max scores", async () => {
    // Alice: max(3,4)=4, max(2,3)=3, avg=(4+3)/2=3.5
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-classes",
      is_private: true,
      expected: 4
    });
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-lists",
      is_private: true,
      expected: 3
    });
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-avg",
      is_private: true,
      expected: 3.5
    });

    // Bob: max(2,1)=2, max(4,4)=4, avg=(2+4)/2=3
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-classes",
      is_private: true,
      expected: 2
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-lists",
      is_private: true,
      expected: 4
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-avg",
      is_private: true,
      expected: 3
    });
  });

  test("release attempt 1 only: student topic max uses single attempt", async () => {
    await releaseColumn(course.id, "classes-1");
    await releaseColumn(course.id, "lists-1");

    // Student topic-classes: max of [classes-1_only] since classes-2 is unreleased
    //   Alice: max(3) = 3
    //   Bob:   max(2) = 2
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-classes",
      is_private: false,
      expected: 3
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-classes",
      is_private: false,
      expected: 2
    });

    // Student topic-lists: max of [lists-1_only]
    //   Alice: max(2) = 2
    //   Bob:   max(4) = 4
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-lists",
      is_private: false,
      expected: 2
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-lists",
      is_private: false,
      expected: 4
    });

    // Student topic-avg: (classes_max + lists_max) / 2
    //   Alice: (3+2)/2 = 2.5
    //   Bob:   (2+4)/2 = 3
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-avg",
      is_private: false,
      expected: 2.5
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-avg",
      is_private: false,
      expected: 3
    });
  });

  test("release attempt 2 (higher for Alice): student topic max updates", async () => {
    await releaseColumn(course.id, "classes-2");
    await releaseColumn(course.id, "lists-2");

    // Student topic-classes: max(3, 4) = 4 for Alice, max(2, 1) = 2 for Bob
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-classes",
      is_private: false,
      expected: 4
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-classes",
      is_private: false,
      expected: 2
    });

    // Student topic-lists: max(2, 3) = 3 for Alice, max(4, 4) = 4 for Bob
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-lists",
      is_private: false,
      expected: 3
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-lists",
      is_private: false,
      expected: 4
    });

    // Student topic-avg: (4+3)/2=3.5 Alice, (2+4)/2=3 Bob — matches instructor
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-avg",
      is_private: false,
      expected: 3.5
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-avg",
      is_private: false,
      expected: 3
    });
  });

  test("unrelease attempt 1: student topic max falls to attempt 2 only", async () => {
    await unreleaseColumn(course.id, "classes-1");

    // Student topic-classes: max of [classes-2 only]
    //   Alice: max(4) = 4 (still highest)
    //   Bob:   max(1) = 1 (lost attempt-1 which was higher)
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-classes",
      is_private: false,
      expected: 4
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-classes",
      is_private: false,
      expected: 1
    });

    // Bob topic-avg changes: (1+4)/2 = 2.5
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-avg",
      is_private: false,
      expected: 2.5
    });

    // Alice topic-avg unchanged: (4+3)/2 = 3.5
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "topic-avg",
      is_private: false,
      expected: 3.5
    });

    // Instructor private scores unchanged throughout
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-classes",
      is_private: true,
      expected: 2
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "topic-avg",
      is_private: true,
      expected: 3
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// FIXTURE 3: Countif Lab + Skill Tracking
//
// Models Class 24/500 pattern: lab completion counts and skill-based
// assessment with countif().
//
// Columns:
//   lab-1..lab-4 (manual, max=1)
//   skill-a, skill-b, skill-c (manual, max=2)
//   calc-lab-count    = countif(gradebook_columns("lab*"),
//                               f(x) = x.score > 0)
//   calc-meets-count  = countif(gradebook_columns("skill*"),
//                               f(x) = x.score == 2)
//   calc-approach-count = countif(gradebook_columns("skill*"),
//                                 f(x) = x.score == 1)
//
// Scores:
//   Alice: lab1=1, lab2=1, lab3=0, lab4=1, skillA=2, skillB=1, skillC=2
//   Bob:   lab1=1, lab2=0, lab3=1, lab4=0, skillA=0, skillB=2, skillC=1
//
// Expected (private):
//   Alice: lab-count=3, meets=2, approach=1
//   Bob:   lab-count=2, meets=1, approach=1
// ────────────────────────────────────────────────────────────────────

test.describe("Fixture 3: Countif Lab + Skill Tracking", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  let course: Course;
  let alice: TestingUser;
  let bob: TestingUser;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Calc Test — Countif" });
    const suffix = Math.random().toString(36).slice(2, 6);
    const users = await createUsersInClass([
      {
        name: "Alice Count",
        email: `alice-cnt-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Bob Count",
        email: `bob-cnt-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Instr Count",
        email: `instr-cnt-${suffix}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    alice = users[0];
    bob = users[1];
    instructor = users[2];

    // Lab columns
    for (let i = 1; i <= 4; i++) {
      await createColumn({ class_id: course.id, name: `Lab ${i}`, slug: `lab-${i}`, max_score: 1, sort_order: i });
    }
    // Skill columns
    await createColumn({ class_id: course.id, name: "Skill A", slug: "skill-a", max_score: 2, sort_order: 5 });
    await createColumn({ class_id: course.id, name: "Skill B", slug: "skill-b", max_score: 2, sort_order: 6 });
    await createColumn({ class_id: course.id, name: "Skill C", slug: "skill-c", max_score: 2, sort_order: 7 });

    for (const student of [alice, bob]) {
      for (const slug of ["lab-1", "lab-2", "lab-3", "lab-4", "skill-a", "skill-b", "skill-c"]) {
        await waitForRow(course.id, slug, student.private_profile_id, true);
      }
    }

    // Calculated columns
    const labDepIds = await resolveColumnIds(course.id, ["lab-*"]);
    await createColumn({
      class_id: course.id,
      name: "Labs Completed",
      slug: "calc-lab-count",
      max_score: 4,
      score_expression: "countif(gradebook_columns('lab*'), f(x) = x.score > 0)",
      dependencies: { gradebook_columns: labDepIds },
      sort_order: 8
    });

    const skillDepIds = await resolveColumnIds(course.id, ["skill-*"]);
    await createColumn({
      class_id: course.id,
      name: "Skills Meeting",
      slug: "calc-meets-count",
      max_score: 3,
      score_expression: "countif(gradebook_columns('skill*'), f(x) = x.score == 2)",
      dependencies: { gradebook_columns: skillDepIds },
      sort_order: 9
    });
    await createColumn({
      class_id: course.id,
      name: "Skills Approaching",
      slug: "calc-approach-count",
      max_score: 3,
      score_expression: "countif(gradebook_columns('skill*'), f(x) = x.score == 1)",
      dependencies: { gradebook_columns: skillDepIds },
      sort_order: 10
    });

    for (const student of [alice, bob]) {
      for (const slug of ["calc-lab-count", "calc-meets-count", "calc-approach-count"]) {
        await waitForRow(course.id, slug, student.private_profile_id, true);
        await waitForRow(course.id, slug, student.private_profile_id, false);
      }
    }

    // Set scores
    await setScore(course.id, "lab-1", alice.private_profile_id, 1);
    await setScore(course.id, "lab-2", alice.private_profile_id, 1);
    await setScore(course.id, "lab-3", alice.private_profile_id, 0);
    await setScore(course.id, "lab-4", alice.private_profile_id, 1);
    await setScore(course.id, "skill-a", alice.private_profile_id, 2);
    await setScore(course.id, "skill-b", alice.private_profile_id, 1);
    await setScore(course.id, "skill-c", alice.private_profile_id, 2);

    await setScore(course.id, "lab-1", bob.private_profile_id, 1);
    await setScore(course.id, "lab-2", bob.private_profile_id, 0);
    await setScore(course.id, "lab-3", bob.private_profile_id, 1);
    await setScore(course.id, "lab-4", bob.private_profile_id, 0);
    await setScore(course.id, "skill-a", bob.private_profile_id, 0);
    await setScore(course.id, "skill-b", bob.private_profile_id, 2);
    await setScore(course.id, "skill-c", bob.private_profile_id, 1);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([alice, bob, instructor]);
  });

  test("instructor sees correct countif values", async () => {
    // Alice: labs with score>0 → lab1,lab2,lab4 → 3
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: true,
      expected: 3
    });
    // Alice: skills==2 → skillA, skillC → 2
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-meets-count",
      is_private: true,
      expected: 2
    });
    // Alice: skills==1 → skillB → 1
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-approach-count",
      is_private: true,
      expected: 1
    });

    // Bob: labs with score>0 → lab1,lab3 → 2
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: true,
      expected: 2
    });
    // Bob: skills==2 → skillB → 1
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-meets-count",
      is_private: true,
      expected: 1
    });
    // Bob: skills==1 → skillC → 1
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-approach-count",
      is_private: true,
      expected: 1
    });
  });

  test("release labs 1-3: student lab count reflects released labs only", async () => {
    await releaseColumn(course.id, "lab-1");
    await releaseColumn(course.id, "lab-2");
    await releaseColumn(course.id, "lab-3");

    // Public lab-count: countif over [lab1, lab2, lab3] (lab4 unreleased → null, skipped)
    //   Alice: scores [1, 1, 0] → score>0 matches 2 (lab1, lab2)
    //   Bob:   scores [1, 0, 1] → score>0 matches 2 (lab1, lab3)
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: false,
      expected: 2
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: false,
      expected: 2
    });
  });

  test("release lab 4: Alice lab count increases", async () => {
    await releaseColumn(course.id, "lab-4");

    // Now all labs released:
    //   Alice: [1,1,0,1] → 3
    //   Bob:   [1,0,1,0] → 2
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: false,
      expected: 3
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: false,
      expected: 2
    });
  });

  test("unrelease lab 1: student lab count drops", async () => {
    await unreleaseColumn(course.id, "lab-1");

    // Labs released: lab2, lab3, lab4 (lab1 cleared)
    //   Alice: [null,1,0,1] → score>0 matches 2 (lab2, lab4)
    //   Bob:   [null,0,1,0] → score>0 matches 1 (lab3)
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: false,
      expected: 2
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: false,
      expected: 1
    });

    // Instructor unchanged
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: true,
      expected: 3
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-lab-count",
      is_private: true,
      expected: 2
    });
  });

  test("release skills: student sees correct skill counts", async () => {
    await releaseColumn(course.id, "skill-a");
    await releaseColumn(course.id, "skill-b");
    await releaseColumn(course.id, "skill-c");

    // All skills released — student matches instructor
    //   Alice: meets=2 (skillA=2, skillC=2), approach=1 (skillB=1)
    //   Bob:   meets=1 (skillB=2), approach=1 (skillC=1)
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-meets-count",
      is_private: false,
      expected: 2
    });
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-approach-count",
      is_private: false,
      expected: 1
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-meets-count",
      is_private: false,
      expected: 1
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-approach-count",
      is_private: false,
      expected: 1
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// FIXTURE 4: Instructor-Only Columns
//
// Tests RLS visibility, frozen snapshot on release, and that post-
// release modifications to the instructor row don't propagate.
//
// Columns:
//   hw-total      (manual, max=100)
//   curve-adj     (manual, max=20, instructor_only=true)
//   curved-total  (calculated, max=120, instructor_only=true)
//       = gradebook_columns("hw-total").score
//       + gradebook_columns("curve-adj").score
//
// Scores:
//   Alice: hw-total=85, curve-adj=10 → curved-total=95
//   Bob:   hw-total=70, curve-adj=15 → curved-total=85
// ────────────────────────────────────────────────────────────────────

test.describe("Fixture 4: Instructor-Only Columns", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  let course: Course;
  let alice: TestingUser;
  let bob: TestingUser;
  let instructor: TestingUser;
  let curveAdjColId: number;
  let curvedTotalColId: number;

  test.beforeAll(async () => {
    course = await createClass({ name: "Calc Test — Instructor Only" });
    const suffix = Math.random().toString(36).slice(2, 6);
    const users = await createUsersInClass([
      {
        name: "Alice IO",
        email: `alice-io-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Bob IO",
        email: `bob-io-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Instr IO",
        email: `instr-io-${suffix}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    alice = users[0];
    bob = users[1];
    instructor = users[2];

    await createColumn({ class_id: course.id, name: "HW Total", slug: "hw-total", max_score: 100, sort_order: 1 });

    curveAdjColId = await createColumn({
      class_id: course.id,
      name: "Curve Adjustment",
      slug: "curve-adj",
      max_score: 20,
      instructor_only: true,
      sort_order: 2
    });

    for (const student of [alice, bob]) {
      await waitForRow(course.id, "hw-total", student.private_profile_id, true);
      await waitForRow(course.id, "curve-adj", student.private_profile_id, true);
    }

    const depIds = await resolveColumnIds(course.id, ["hw-total", "curve-adj"]);
    curvedTotalColId = await createColumn({
      class_id: course.id,
      name: "Curved Total",
      slug: "curved-total",
      max_score: 120,
      score_expression: "gradebook_columns('hw-total').score + gradebook_columns('curve-adj').score",
      instructor_only: true,
      dependencies: { gradebook_columns: depIds },
      sort_order: 3
    });

    for (const student of [alice, bob]) {
      await waitForRow(course.id, "curved-total", student.private_profile_id, true);
      await waitForRow(course.id, "curved-total", student.private_profile_id, false);
    }

    // Set scores
    await setScore(course.id, "hw-total", alice.private_profile_id, 85);
    await setScore(course.id, "curve-adj", alice.private_profile_id, 10);
    await setScore(course.id, "hw-total", bob.private_profile_id, 70);
    await setScore(course.id, "curve-adj", bob.private_profile_id, 15);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([alice, bob, instructor]);
  });

  test("instructor sees calculated curved total", async () => {
    // Alice: 85 + 10 = 95
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "curved-total",
      is_private: true,
      expected: 95
    });
    // Bob: 70 + 15 = 85
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "curved-total",
      is_private: true,
      expected: 85
    });
  });

  test("student cannot see instructor-only columns via RLS before release", async () => {
    const studentClient = await createStudentClient(alice);

    // Column should be invisible
    const { data: colData } = await studentClient
      .from("gradebook_columns")
      .select("id")
      .eq("id", curveAdjColId)
      .maybeSingle();
    expect(colData).toBeNull();

    // Cell rows should be invisible
    const { data: cellData } = await studentClient
      .from("gradebook_column_students")
      .select("id")
      .eq("gradebook_column_id", curveAdjColId)
      .eq("student_id", alice.private_profile_id)
      .maybeSingle();
    expect(cellData).toBeNull();

    // Curved total also invisible
    const { data: calcColData } = await studentClient
      .from("gradebook_columns")
      .select("id")
      .eq("id", curvedTotalColId)
      .maybeSingle();
    expect(calcColData).toBeNull();

    await studentClient.auth.signOut();
  });

  test("release curve-adj: student sees frozen snapshot", async () => {
    // Ensure is_recalculating is cleared — the sync trigger requires it
    await kickRecalculation(course.id);
    await releaseColumn(course.id, "curve-adj");

    // After release, public row gets a frozen copy of the private row.
    //   Alice: curve-adj public.score = 10 (snapshot)
    //   Bob:   curve-adj public.score = 15 (snapshot)
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "curve-adj",
      is_private: false,
      expected: 10
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "curve-adj",
      is_private: false,
      expected: 15
    });

    // Student can now see the column via RLS
    const studentClient = await createStudentClient(alice);
    const { data: colData } = await studentClient
      .from("gradebook_columns")
      .select("id")
      .eq("id", curveAdjColId)
      .maybeSingle();
    expect(colData?.id).toBe(curveAdjColId);

    const { data: cellData } = await studentClient
      .from("gradebook_column_students")
      .select("score")
      .eq("gradebook_column_id", curveAdjColId)
      .eq("student_id", alice.private_profile_id)
      .eq("is_private", false)
      .maybeSingle();
    expect(cellData?.score).toBe(10);

    await studentClient.auth.signOut();
  });

  test("post-release instructor edit does NOT change student snapshot", async () => {
    // Instructor updates curve-adj for Alice from 10 → 18
    await setScore(course.id, "curve-adj", alice.private_profile_id, 18);

    // Private row updated
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "curve-adj",
      is_private: true,
      expected: 18
    });

    // Instructor's curved-total recalculates: 85+18 = 103
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "curved-total",
      is_private: true,
      expected: 103
    });

    // Student's curve-adj public row is FROZEN at 10 (snapshot from release time)
    // The sync trigger skips instructor-only columns after initial release.
    const { data: pubCell } = await supabase
      .from("gradebook_column_students")
      .select("score")
      .eq("gradebook_column_id", curveAdjColId)
      .eq("student_id", alice.private_profile_id)
      .eq("is_private", false)
      .single();
    expect(pubCell?.score).toBe(10);
  });

  test("release curved-total: student sees current private snapshot", async () => {
    // Ensure is_recalculating is cleared before releasing — the sync trigger
    // (sync_private_gradebook_column_student) requires is_recalculating=false
    // on both old and new rows (lines 105-106 of the migration).
    await kickRecalculation(course.id);

    await releaseColumn(course.id, "curved-total");

    // curved-total is instructor_only + calculated. On release, public row
    // gets a one-time copy of the private row (which now has the recalculated 103).
    //   Alice: private curved-total=103 → public=103
    //   Bob:   private curved-total=85  → public=85
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "curved-total",
      is_private: false,
      expected: 103
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "curved-total",
      is_private: false,
      expected: 85
    });
  });

  test("unrelease hides column from student again", async () => {
    await unreleaseColumn(course.id, "curve-adj");

    // Student should no longer see curve-adj
    const studentClient = await createStudentClient(alice);
    const { data: colData } = await studentClient
      .from("gradebook_columns")
      .select("id")
      .eq("id", curveAdjColId)
      .maybeSingle();
    expect(colData).toBeNull();

    const { data: cellData } = await studentClient
      .from("gradebook_column_students")
      .select("id")
      .eq("gradebook_column_id", curveAdjColId)
      .eq("student_id", alice.private_profile_id)
      .maybeSingle();
    expect(cellData).toBeNull();

    // curved-total is still released — student can still see that
    const { data: calcColData } = await studentClient
      .from("gradebook_columns")
      .select("id")
      .eq("id", curvedTotalColId)
      .maybeSingle();
    expect(calcColData?.id).toBe(curvedTotalColId);

    await studentClient.auth.signOut();
  });
});

// ────────────────────────────────────────────────────────────────────
// FIXTURE 5: Score Override Precedence
//
// Tests that score_override takes precedence over calculated score in
// expressions, and that overrides sync correctly on release.
//
// Columns:
//   quiz-1, quiz-2 (manual, max=100)
//   calc-quiz-avg = mean(gradebook_columns("quiz*"))
//   calc-bonus    = gradebook_columns("calc-quiz-avg") * 0.9 + 10
//
// Scores:
//   Alice: quiz-1=80, quiz-2=90
//   Bob:   quiz-1=60, quiz-2=40
//
// Expected (no overrides):
//   Alice: quiz-avg = 100*(80+90)/200 = 85,  bonus = 85*0.9+10 = 86.5
//   Bob:   quiz-avg = 100*(60+40)/200 = 50,  bonus = 50*0.9+10 = 55
// ────────────────────────────────────────────────────────────────────

test.describe("Fixture 5: Score Override Precedence", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  let course: Course;
  let alice: TestingUser;
  let bob: TestingUser;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Calc Test — Override" });
    const suffix = Math.random().toString(36).slice(2, 6);
    const users = await createUsersInClass([
      {
        name: "Alice Ovr",
        email: `alice-ovr-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Bob Ovr",
        email: `bob-ovr-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Instr Ovr",
        email: `instr-ovr-${suffix}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    alice = users[0];
    bob = users[1];
    instructor = users[2];

    await createColumn({ class_id: course.id, name: "Quiz 1", slug: "quiz-1", max_score: 100, sort_order: 1 });
    await createColumn({ class_id: course.id, name: "Quiz 2", slug: "quiz-2", max_score: 100, sort_order: 2 });

    for (const student of [alice, bob]) {
      await waitForRow(course.id, "quiz-1", student.private_profile_id, true);
      await waitForRow(course.id, "quiz-2", student.private_profile_id, true);
    }

    const quizDepIds = await resolveColumnIds(course.id, ["quiz-*"]);
    await createColumn({
      class_id: course.id,
      name: "Quiz Average",
      slug: "calc-quiz-avg",
      max_score: 100,
      score_expression: "mean(gradebook_columns('quiz*'))",
      dependencies: { gradebook_columns: quizDepIds },
      sort_order: 3
    });

    const bonusDepIds = await resolveColumnIds(course.id, ["calc-quiz-avg"]);
    await createColumn({
      class_id: course.id,
      name: "Final with Bonus",
      slug: "calc-bonus",
      max_score: 100,
      score_expression: "gradebook_columns('calc-quiz-avg') * 0.9 + 10",
      dependencies: { gradebook_columns: bonusDepIds },
      sort_order: 4
    });

    for (const student of [alice, bob]) {
      for (const slug of ["calc-quiz-avg", "calc-bonus"]) {
        await waitForRow(course.id, slug, student.private_profile_id, true);
        await waitForRow(course.id, slug, student.private_profile_id, false);
      }
    }

    // Set scores
    await setScore(course.id, "quiz-1", alice.private_profile_id, 80);
    await setScore(course.id, "quiz-2", alice.private_profile_id, 90);
    await setScore(course.id, "quiz-1", bob.private_profile_id, 60);
    await setScore(course.id, "quiz-2", bob.private_profile_id, 40);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([alice, bob, instructor]);
  });

  test("baseline: instructor sees correct calculated values (no overrides)", async () => {
    // Alice: quiz-avg = 100*(80+90)/200 = 85
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-quiz-avg",
      is_private: true,
      expected: 85
    });
    // Alice: bonus = 85*0.9 + 10 = 76.5 + 10 = 86.5
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-bonus",
      is_private: true,
      expected: 86.5
    });

    // Bob: quiz-avg = 100*(60+40)/200 = 50
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-quiz-avg",
      is_private: true,
      expected: 50
    });
    // Bob: bonus = 50*0.9 + 10 = 45 + 10 = 55
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-bonus",
      is_private: true,
      expected: 55
    });
  });

  test("override on manual column propagates through calculation chain", async () => {
    // Override quiz-1 for Alice: 80 → override 100
    await setOverride(course.id, "quiz-1", alice.private_profile_id, 100);

    // The mean function sees score_override ?? score for quiz-1.
    // quiz-1 effective=100, quiz-2 effective=90
    // quiz-avg = 100*(100+90)/200 = 95
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-quiz-avg",
      is_private: true,
      expected: 95
    });
    // bonus = 95*0.9 + 10 = 85.5 + 10 = 95.5
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-bonus",
      is_private: true,
      expected: 95.5
    });

    // Bob unchanged
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-quiz-avg",
      is_private: true,
      expected: 50
    });
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-bonus",
      is_private: true,
      expected: 55
    });
  });

  test("override on calculated column: student sees override after release", async () => {
    // BUG FIX: The sync_private_gradebook_column_student_fields_for_calculated_columns
    // trigger (line 230-231 of instructor_only migration) requires BOTH old and new
    // is_recalculating=false. If we set score_override while the processor is mid-flight,
    // the sync to the public row is silently skipped. Wait for recalculation to settle first.
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-quiz-avg",
      is_private: true,
      expected: 50
    });
    await kickRecalculation(course.id);

    // Now safe to set override — the row's is_recalculating should be false.
    await setOverride(course.id, "calc-quiz-avg", bob.private_profile_id, 80);

    // Dependent calc-bonus recalculates using the override: 80*0.9+10 = 82
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-bonus",
      is_private: true,
      expected: 82
    });

    // Release all manual columns so public calculations are non-null
    await releaseColumn(course.id, "quiz-1");
    await releaseColumn(course.id, "quiz-2");

    // For non-instructor-only calculated columns, score_override syncs to public.
    // Bob's public calc-quiz-avg gets score_override=80 via
    // sync_private_gradebook_column_student_fields_for_calculated_columns trigger.
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-quiz-avg",
      is_private: false,
      expected: 80
    });

    // Bob's public calc-bonus: the processor calculates the public row independently.
    // The public calc-quiz-avg has score_override=80, so expressions see 80.
    // Public bonus = 80*0.9+10 = 82
    await waitForScore({
      class_id: course.id,
      student_id: bob.private_profile_id,
      column_slug: "calc-bonus",
      is_private: false,
      expected: 82
    });

    // Alice public (quiz-1 had override 100):
    // Manual quiz-1 release syncs: public.score = override ?? score = 100.
    // Public quiz-avg = mean([100, 90]) = 95
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-quiz-avg",
      is_private: false,
      expected: 95
    });
    // Public bonus = 95*0.9+10 = 95.5
    await waitForScore({
      class_id: course.id,
      student_id: alice.private_profile_id,
      column_slug: "calc-bonus",
      is_private: false,
      expected: 95.5
    });
  });

  test("student UI reflects overridden values", async ({ page }) => {
    await loginAsUser(page, bob, course);
    await page.goto(`/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");

    // Wait for the gradebook region to appear, then expand all groups
    await expect(page.getByText("Expand All")).toBeVisible({ timeout: 30_000 });
    await page.getByText("Expand All").click();
    await page.waitForTimeout(500);

    // Scope assertions to specific grade cards — bare getByText("80") could match
    // dates, IDs, or other numeric text on the page.
    const quizAvgCard = page.getByRole("article", { name: "Grade for Quiz Average" });
    await expect(quizAvgCard).toBeVisible({ timeout: 10_000 });
    await expect(quizAvgCard).toContainText(/80(\.0+)?/);

    const bonusCard = page.getByRole("article", { name: "Grade for Final with Bonus" });
    await expect(bonusCard).toBeVisible({ timeout: 30_000 });
    await expect(bonusCard).toContainText(/82(\.0+)?/);
  });
});
