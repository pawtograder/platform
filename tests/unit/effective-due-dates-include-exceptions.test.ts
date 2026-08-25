/**
 * Regression tests for two due-date bugs fixed in
 * 20260824120000_effective_due_dates_include_exceptions_and_null_lab_end_time.sql:
 *
 *   1. assignments_with_effective_due_dates.due_date and
 *      get_assignments_for_student_dashboard.due_date used to be the LAB-aware date only, with no
 *      due-date exceptions applied. The course dashboard filters that column with
 *      `.gte("due_date", now)` and renders it as "Due", so a student holding an extension saw a
 *      future deadline on the assignment page and an EMPTY upcoming list.
 *
 *   2. calculate_effective_due_date concatenated lab_sections.end_time into a timestamp string,
 *      so a NULL end_time NULLed the comparison, matched no meeting, and silently dropped the lab
 *      offset — falling back to the plain assignment due date.
 *
 * Requires local Supabase, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
 * RUN_SUPABASE_INTEGRATION_TESTS=true (avoids failures when .env.local points at a stopped local
 * API). Example:
 *   RUN_SUPABASE_INTEGRATION_TESTS=true npx jest tests/unit/effective-due-dates-include-exceptions.test.ts
 *
 * Leaves the created classes and related rows in the database (use db reset or manual cleanup).
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
// Loaded lazily on purpose. TestingUtils builds a Supabase admin client at module evaluation
// and throws "SUPABASE_URL ... is required" when the environment is not configured, so a
// static import would make this gated file FAIL under a plain `npx jest` instead of skipping.
type TestingUtils = typeof import("@/tests/e2e/TestingUtils");
let tu: TestingUtils;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: ".env.local" });
} catch {
  /* optional */
}

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const integrationEnabled = process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true";

const describeIntegration = url && serviceKey && integrationEnabled ? describe : describe.skip;

const COURSE_TIME_ZONE = "America/New_York";
const HOUR_MS = 60 * 60 * 1000;

/** The exact query the course dashboard's "Upcoming Assignments" list runs (lib/ssr-course-dashboard.ts). */
async function readUpcomingForStudent(classId: number, studentProfileId: string) {
  const { data, error } = await tu.supabase
    .from("assignments_with_effective_due_dates")
    .select("id, due_date")
    .eq("class_id", classId)
    .eq("student_profile_id", studentProfileId)
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: true });
  if (error) {
    throw new Error(`upcoming read failed: ${error.message}`);
  }
  return data ?? [];
}

async function readViewDueDate(assignmentId: number, studentProfileId: string): Promise<string> {
  const { data, error } = await tu.supabase
    .from("assignments_with_effective_due_dates")
    .select("due_date")
    .eq("id", assignmentId)
    .eq("student_profile_id", studentProfileId)
    .single();
  if (error) {
    throw new Error(`view read failed: ${error.message}`);
  }
  if (!data.due_date) {
    throw new Error("view returned a null due_date");
  }
  return data.due_date;
}

describeIntegration("effective due dates include due-date exceptions", () => {
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    tu = require("@/tests/e2e/TestingUtils");
  });

  jest.setTimeout(180_000);

  test("an individual extension keeps the assignment in the upcoming list and moves the shown deadline", async () => {
    const course = await tu.createClass({ name: `Due date exceptions ${Date.now()}` });
    const [extended, control] = await tu.createUsersInClass([
      {
        name: "Extension Student",
        email: `duedate-ext-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Control Student",
        email: `duedate-ctl-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    // Hard deadline an hour in the past: without the extension applied, the dashboard's
    // `.gte("due_date", now)` filter drops the row entirely.
    const originalDue = new Date(Date.now() - HOUR_MS);
    const assignment = await tu.insertAssignment({
      due_date: originalDue.toISOString(),
      class_id: course.id,
      name: "Extension regression assignment"
    });

    await tu.createDueDateException(assignment.id, extended.private_profile_id, course.id, 48);

    const extendedDue = await readViewDueDate(assignment.id, extended.private_profile_id);
    const controlDue = await readViewDueDate(assignment.id, control.private_profile_id);

    // The view now reports the FINAL deadline, so the extension shows up in the value the
    // dashboard renders as "Due" — not just in the filter.
    expect(new Date(extendedDue).getTime()).toBe(originalDue.getTime() + 48 * HOUR_MS);
    expect(new Date(controlDue).getTime()).toBe(originalDue.getTime());

    // The view must agree with calculate_final_due_date, which is what submission enforcement
    // and the assignment detail page are held to.
    const { data: canonical, error: canonicalError } = await tu.supabase.rpc("calculate_final_due_date", {
      assignment_id_param: assignment.id,
      student_profile_id_param: extended.private_profile_id
    });
    if (canonicalError) {
      throw new Error(`calculate_final_due_date failed: ${canonicalError.message}`);
    }
    expect(new Date(canonical as string).getTime()).toBe(new Date(extendedDue).getTime());

    // This is the reported symptom: the extended student's upcoming list was empty.
    const extendedUpcoming = await readUpcomingForStudent(course.id, extended.private_profile_id);
    expect(extendedUpcoming.map((row) => row.id)).toContain(assignment.id);

    const controlUpcoming = await readUpcomingForStudent(course.id, control.private_profile_id);
    expect(controlUpcoming.map((row) => row.id)).not.toContain(assignment.id);

    // Same fix on the Assignments tab, which reads the RPC rather than the view. The RPC is
    // SECURITY DEFINER with an auth gate, so it has to be called as the student.
    const extendedClient = await tu.createAuthenticatedClient(extended);
    const { data: rpcRows, error: rpcError } = await extendedClient.rpc("get_assignments_for_student_dashboard", {
      p_class_id: course.id,
      p_student_profile_id: extended.private_profile_id
    });
    if (rpcError) {
      throw new Error(`get_assignments_for_student_dashboard failed: ${rpcError.message}`);
    }
    const rpcRow = (rpcRows ?? []).find((row) => row.id === assignment.id);
    expect(rpcRow).toBeDefined();
    expect(new Date(rpcRow!.due_date as string).getTime()).toBe(originalDue.getTime() + 48 * HOUR_MS);
    // The exception_* columns still describe the exception row itself, so a caller that renders
    // "48-hour extension applied" alongside the deadline stays truthful.
    expect(rpcRow!.exception_hours).toBe(48);
  });

  test("a group extension reaches the view through the group lateral", async () => {
    const course = await tu.createClass({ name: `Group due date exceptions ${Date.now()}` });
    const [member] = await tu.createUsersInClass([
      {
        name: "Group Member",
        email: `duedate-grp-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    const originalDue = new Date(Date.now() - HOUR_MS);
    const assignment = await tu.insertAssignment({
      due_date: originalDue.toISOString(),
      class_id: course.id,
      name: "Group extension regression assignment",
      group_config: "groups",
      min_group_size: 1,
      max_group_size: 4
    });

    const { data: group, error: groupError } = await tu.supabase
      .from("assignment_groups")
      .insert({ name: `Group ${Date.now()}`, class_id: course.id, assignment_id: assignment.id })
      .select("id")
      .single();
    if (groupError) {
      throw new Error(`failed to create assignment group: ${groupError.message}`);
    }

    const { error: memberError } = await tu.supabase.from("assignment_groups_members").insert({
      assignment_group_id: group.id,
      assignment_id: assignment.id,
      class_id: course.id,
      profile_id: member.private_profile_id,
      added_by: member.private_profile_id
    });
    if (memberError) {
      throw new Error(`failed to add group member: ${memberError.message}`);
    }

    // Group extensions carry assignment_group_id and a NULL student_id, so the view has to
    // resolve the student's group to find them.
    const { error: exceptionError } = await tu.supabase.from("assignment_due_date_exceptions").insert({
      class_id: course.id,
      assignment_id: assignment.id,
      student_id: null,
      assignment_group_id: group.id,
      creator_id: member.private_profile_id,
      hours: 72,
      minutes: 0,
      tokens_consumed: 3
    });
    if (exceptionError) {
      throw new Error(`failed to create group due date exception: ${exceptionError.message}`);
    }

    const groupDue = await readViewDueDate(assignment.id, member.private_profile_id);
    expect(new Date(groupDue).getTime()).toBe(originalDue.getTime() + 72 * HOUR_MS);

    const upcoming = await readUpcomingForStudent(course.id, member.private_profile_id);
    expect(upcoming.map((row) => row.id)).toContain(assignment.id);
  });

  test("a lab section with no end time uses the end of the meeting day instead of dropping the lab offset", async () => {
    const course = await tu.createClass({ name: `Null lab end time ${Date.now()}` });
    const [withEndTime, withoutEndTime] = await tu.createUsersInClass([
      {
        name: "Lab End Time Student",
        email: `duedate-lab-end-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Lab No End Time Student",
        email: `duedate-lab-noend-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    // Inserting lab_sections directly rather than via createLabSectionWithStudents: that helper
    // defaults end_time to "11:00" and cannot express the NULL this test is about. The insert
    // trigger (sync_lab_section_meetings) generates the meetings from the class start/end dates.
    const { data: sections, error: sectionsError } = await tu.supabase
      .from("lab_sections")
      .insert([
        {
          class_id: course.id,
          name: "Lab with end time",
          day_of_week: "monday",
          start_time: "10:00",
          end_time: "11:00"
        },
        {
          class_id: course.id,
          name: "Lab without end time",
          day_of_week: "monday",
          start_time: "10:00",
          end_time: null
        }
      ])
      .select("id, name, end_time");
    if (sectionsError) {
      throw new Error(`failed to create lab sections: ${sectionsError.message}`);
    }
    const sectionWithEnd = sections.find((s) => s.end_time !== null)!;
    const sectionWithoutEnd = sections.find((s) => s.end_time === null)!;
    expect(sectionWithoutEnd).toBeDefined();

    for (const [student, section] of [
      [withEndTime, sectionWithEnd],
      [withoutEndTime, sectionWithoutEnd]
    ] as const) {
      const { error } = await tu.supabase
        .from("user_roles")
        .update({ lab_section_id: section.id })
        .eq("private_profile_id", student.private_profile_id)
        .eq("class_id", course.id);
      if (error) {
        throw new Error(`failed to assign lab section: ${error.message}`);
      }
    }

    // Pin the deadline to the Tuesday after the next Monday meeting, at noon course-local.
    // A floating now+24h is not safe: run on a Sunday afternoon it lands between the timed
    // section's 11:00 meeting end and the NULL section's defaulted 23:59:59, so the two
    // sections resolve to DIFFERENT Mondays and the comparison below stops meaning anything.
    const cursor = new Date(`${formatInTimeZone(new Date(), COURSE_TIME_ZONE, "yyyy-MM-dd")}T00:00:00Z`);
    do {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } while (cursor.getUTCDay() !== 1);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const plainDue = fromZonedTime(`${cursor.toISOString().slice(0, 10)}T12:00:00`, COURSE_TIME_ZONE);
    const assignment = await tu.insertAssignment({
      due_date: plainDue.toISOString(),
      class_id: course.id,
      name: "Lab offset regression assignment",
      lab_due_date_offset: 120
    });

    const withEndDue = await readViewDueDate(assignment.id, withEndTime.private_profile_id);
    const withoutEndDue = await readViewDueDate(assignment.id, withoutEndTime.private_profile_id);

    // Control: an end_time of 11:00 plus a 120-minute offset is due at 13:00 local.
    expect(formatInTimeZone(new Date(withEndDue), COURSE_TIME_ZONE, "HH:mm:ss")).toBe("13:00:00");

    // The regression: this used to equal the plain assignment due date exactly, because the NULL
    // end_time NULLed the meeting comparison and the function fell through to its fallback.
    expect(new Date(withoutEndDue).getTime()).not.toBe(plainDue.getTime());
    // 23:59:59 (end of the meeting day) plus the same 120-minute offset.
    expect(formatInTimeZone(new Date(withoutEndDue), COURSE_TIME_ZONE, "HH:mm:ss")).toBe("01:59:59");
    // Both students meet on the same day, so the defaulted section is strictly the later deadline.
    expect(new Date(withoutEndDue).getTime()).toBeGreaterThan(new Date(withEndDue).getTime());
  });
});
