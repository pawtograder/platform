/**
 * Realistic gradebooks for the column-groups and topics E2E suite.
 *
 * Both are modeled on real course gradebooks rather than on the generic e2e helpers, because the
 * behaviors under test are about what real gradebooks contain:
 *
 *   - `createCs4535StyleGradebook`: the CS 4535 seed shape. Labs, homework, exams, quizzes with a
 *     hole in sort_order where a deleted quiz was, two "AI Usage Log" columns (which the old slug
 *     heuristic labeled "Ais"), computed averages, and an instructor-only curve column.
 *   - `createCs2100StyleGradebook`: the CS 2100 Spring 2026 shape. Each topic is assessed in several
 *     quizzes ("Attempt N: Topic"), each topic has a hand-written `topic_*` max column, one third
 *     attempt has a slug its topic's glob misses, and one topic has two "Attempt 2" columns.
 *
 * Scores are deterministic per (student index, column) so screenshots are stable run to run.
 */
import type { Course } from "@/utils/supabase/DatabaseTypes";
import { createClass, createUsersInClass, setCourseFeature, supabase, type TestingUser } from "./TestingUtils";

type ColumnSpec = {
  slug: string;
  name: string;
  max_score: number;
  /** Computed column; manual when omitted. */
  score_expression?: string;
  /** Slugs this computed column reads (stored in `dependencies.gradebook_columns`). */
  depends_on?: string[];
  instructor_only?: boolean;
  /** Deterministic score for manual columns, or null for "no score". */
  score?: (studentIndex: number) => number | null;
};

export const STUDENT_NAMES = [
  "Avery Chen",
  "Bianca Okafor",
  "Caleb Moreno",
  "Dana Whitfield",
  "Elias Novak",
  "Farah Haddad"
];

async function gradebookIdFor(class_id: number): Promise<number> {
  const { data, error } = await supabase.from("classes").select("gradebook_id").eq("id", class_id).single();
  if (error || !data?.gradebook_id) throw new Error(`No gradebook for class ${class_id}: ${error?.message}`);
  return data.gradebook_id;
}

/**
 * Insert columns in order (sort_order as given by `sortOrders`, defaulting to the index), set
 * manual scores on the private rows, then release the manual columns: releasing is what copies
 * the private scores to the rows students read. Instructor-only columns stay hidden.
 */
async function insertColumns(
  class_id: number,
  specs: ColumnSpec[],
  students: TestingUser[],
  sortOrders?: number[]
): Promise<{ ids: Map<string, number>; releasedAt: Date }> {
  const gradebook_id = await gradebookIdFor(class_id);
  const ids = new Map<string, number>();
  for (const [i, spec] of specs.entries()) {
    const deps = spec.depends_on?.map((slug) => {
      const id = ids.get(slug);
      if (id == null) throw new Error(`${spec.slug} depends on ${slug}, which is not created yet`);
      return id;
    });
    const { data, error } = await supabase
      .from("gradebook_columns")
      .insert({
        class_id,
        gradebook_id,
        slug: spec.slug,
        name: spec.name,
        max_score: spec.max_score,
        score_expression: spec.score_expression ?? null,
        dependencies: deps ? { gradebook_columns: deps } : null,
        instructor_only: spec.score_expression ? (spec.instructor_only ?? false) : false,
        released: false,
        sort_order: sortOrders?.[i] ?? i
      })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to create column ${spec.slug}: ${error.message}`);
    ids.set(spec.slug, data.id);
  }

  for (const spec of specs) {
    if (!spec.score) continue;
    const column_id = ids.get(spec.slug)!;
    for (const [index, student] of students.entries()) {
      const score = spec.score(index);
      const { error } = await supabase
        .from("gradebook_column_students")
        .update({ score, is_missing: score === null })
        .eq("gradebook_column_id", column_id)
        .eq("student_id", student.private_profile_id)
        .eq("is_private", true);
      if (error) throw new Error(`Failed to score ${spec.slug}: ${error.message}`);
    }
  }

  const toRelease = specs.filter((s) => !s.score_expression).map((s) => ids.get(s.slug)!);
  const { data: released, error: releaseError } = await supabase
    .from("gradebook_columns")
    .update({ released: true })
    .in("id", toRelease)
    .select("updated_at");
  if (releaseError) throw new Error(`Failed to release columns: ${releaseError.message}`);
  // The database's own clock, so the recalculation wait can't be thrown off by client skew.
  const releasedAt = new Date(Math.min(...(released ?? []).map((r) => new Date(r.updated_at).getTime())));
  return { ids, releasedAt };
}

/**
 * Wait until recalculation has caught up with every write made since `since`: each of the class's
 * per-student recalculation states (private and public) was processed after it, and none is still
 * dirty or mid-recalculation. A recalculation that leaves a score unchanged doesn't rewrite the
 * cell, so the row state, not the cell, is the signal. The worker runs on a one-minute cron, and
 * behind a full CI run (six workers) it can take several minutes to reach a new class.
 */
export async function waitForGradebookRecalculation(class_id: number, since: Date, timeoutMs = 360_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data, error } = await supabase
      .from("gradebook_row_recalc_state")
      .select("dirty, is_recalculating, updated_at")
      .eq("class_id", class_id);
    if (error) throw new Error(`Failed to poll recalculation: ${error.message}`);
    const rows = data ?? [];
    const pending = rows.filter((r) => r.dirty || r.is_recalculating || new Date(r.updated_at) < since).length;
    if (rows.length > 0 && pending === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Gradebook for class ${class_id} not recalculated after ${timeoutMs}ms (${pending} of ${rows.length} pending)`
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function createStaffAndStudents(course: Course, prefix: string) {
  const users = await createUsersInClass([
    { name: `${prefix} Instructor`, role: "instructor", class_id: course.id, useMagicLink: true },
    ...STUDENT_NAMES.map((name) => ({ name, role: "student" as const, class_id: course.id, useMagicLink: true }))
  ]);
  return { instructor: users[0], students: users.slice(1) };
}

/** Score 60–100 that varies by student and column, without randomness. */
function pct(seed: number) {
  return (studentIndex: number) => 60 + ((studentIndex * 7 + seed * 11) % 41);
}

export async function createCs4535StyleGradebook() {
  const course = await createClass({ name: "Software Design and Delivery" });
  // A class that existed before groups shipped: both features written disabled, as the migration does.
  await setCourseFeature(course.id, "gradebook-column-groups", false);
  await setCourseFeature(course.id, "gradebook-topics", false);
  await setCourseFeature(course.id, "gradebook-what-if", true);
  const { instructor, students } = await createStaffAndStudents(course, "SDD");

  const labs: ColumnSpec[] = ["Setup and Git", "Testing", "Code Review", "Feature Flags"].map((topic, i) => ({
    slug: `assignment-lab-${i + 1}`,
    name: `Lab ${i + 1}: ${topic}`,
    max_score: 100,
    score: pct(i + 1)
  }));
  const homework: ColumnSpec[] = ["Onboarding", "First Ticket", "Migrations"].map((topic, i) => ({
    slug: `assignment-assignment-${i + 1}`,
    name: `Assignment ${i + 1}: ${topic}`,
    max_score: 100,
    score: pct(i + 10)
  }));
  const quizzes: ColumnSpec[] = [1, 2, 4, 5].map((n) => ({
    slug: `quiz-${n}`,
    name: `Quiz ${n}`,
    max_score: 10,
    score: (s) => 5 + ((s + n) % 6)
  }));
  const specs: ColumnSpec[] = [
    ...labs,
    ...homework,
    { slug: "exam-1", name: "Exam 1", max_score: 100, score: pct(20) },
    { slug: "exam-2", name: "Exam 2", max_score: 100, score: pct(21) },
    ...quizzes,
    { slug: "ai-usage-log-1", name: "AI Usage Log 1", max_score: 1, score: (s) => (s % 5 === 4 ? 0 : 1) },
    { slug: "ai-usage-log-2", name: "AI Usage Log 2", max_score: 1, score: (s) => (s % 4 === 3 ? 0 : 1) },
    { slug: "attendance", name: "Attendance", max_score: 36, score: (s) => 36 - (s % 4) },
    {
      slug: "average-labs",
      name: "Lab Average",
      max_score: 100,
      score_expression: 'mean(gradebook_columns("assignment-lab-*"))',
      depends_on: labs.map((l) => l.slug)
    },
    {
      slug: "average-assignments",
      name: "Assignment Average",
      max_score: 100,
      score_expression: 'mean(gradebook_columns("assignment-assignment-*"))',
      depends_on: homework.map((h) => h.slug)
    },
    {
      slug: "curve-adjustment",
      name: "Curve Adjustment",
      max_score: 5,
      score_expression: "2",
      instructor_only: true
    }
  ];
  // Leave the hole where quiz-3 was deleted: quizzes 4 and 5 sit one slot further right.
  const quizStart = labs.length + homework.length + 2;
  const sortOrders = specs.map((s, i) => (i >= quizStart + 2 ? i + 1 : i));
  const { ids: columns, releasedAt } = await insertColumns(course.id, specs, students, sortOrders);
  await waitForGradebookRecalculation(course.id, releasedAt);
  return { course, instructor, students, columns };
}

/** CS 2100 topics, each with its attempts by quiz session, mirroring Spring 2026. */
const CS2100_TOPICS = [
  { key: "git", name: "Git", attempts: [1, 2] },
  { key: "func_doc", name: "Functions and Documentation", attempts: [1, 2] },
  { key: "cce", name: "Coupling, Cohesion, and Encapsulation", attempts: [1, 2] },
  { key: "svm", name: "Stakeholder-value Matrices", attempts: [1, 2] }
] as const;

export async function createCs2100StyleGradebook() {
  const course = await createClass({ name: "Program Design and Implementation" });
  await setCourseFeature(course.id, "gradebook-what-if", true);
  const { instructor, students } = await createStaffAndStudents(course, "PDI");

  // Session 1 (9/22) holds every topic's attempt 1; session 2 (10/15) every attempt 2, then the
  // stragglers: a third CCE attempt whose slug `3cce` the `cce*` glob misses, and a second
  // "Attempt 2" for stakeholder-value matrices (both exist in the real gradebook).
  const attempt = (key: string, name: string, n: number): ColumnSpec => ({
    slug: `${key}_${n}`,
    name: `Attempt ${n}: ${name}`,
    max_score: 4,
    score: (s) => ((s + n + key.length) % 5 === 0 ? null : 1 + ((s * 3 + n + key.length) % 4))
  });
  const session1 = CS2100_TOPICS.map((t) => attempt(t.key, t.name, 1));
  const session2 = CS2100_TOPICS.map((t) => attempt(t.key, t.name, 2));
  const stragglers: ColumnSpec[] = [
    { slug: "3cce", name: "Attempt 3: Coupling", max_score: 4, score: (s) => 2 + (s % 3) },
    { slug: "2svm", name: "Attempt 2: Stakeholder-value Matrices", max_score: 4, score: (s) => 1 + (s % 4) }
  ];
  const standings: ColumnSpec[] = CS2100_TOPICS.map((t) => ({
    slug: `topic_${t.key}`,
    name: `${t.name} Topic Max Score`,
    max_score: 4,
    score_expression: `max(gradebook_columns("${t.key}*"))`,
    depends_on: t.attempts.map((n) => `${t.key}_${n}`)
  }));
  const homework: ColumnSpec[] = [1, 2, 3].map((n) => ({
    slug: `assignment-hw${n}`,
    name: `HW${n}`,
    max_score: 100,
    score: pct(n + 30)
  }));
  const specs = [...session1, ...session2, ...stragglers, ...standings, ...homework];
  const { ids: columns, releasedAt } = await insertColumns(course.id, specs, students);

  // The quiz sessions are the groups (the occasion axis); topics are the other axis.
  const gradebook_id = await gradebookIdFor(course.id);
  for (const [name, cols] of [
    ["Quiz 9/22", session1],
    ["Quiz 10/15", [...session2, ...stragglers]]
  ] as const) {
    const { error } = await supabase.rpc("gradebook_column_group_create", {
      p_gradebook_id: gradebook_id,
      p_name: name,
      p_column_ids: cols.map((c) => columns.get(c.slug)!)
    });
    if (error) throw new Error(`Failed to create group ${name}: ${error.message}`);
  }
  await waitForGradebookRecalculation(course.id, releasedAt);
  return { course, instructor, students, columns, gradebook_id };
}
