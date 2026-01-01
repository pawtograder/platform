import { test, expect } from "../global-setup";
import {
  createClass,
  createClassSection,
  createUsersInClass,
  createUserInClass,
  createClassWithSISSections,
  simulateSISSync,
  getEnrollmentState,
  setUserSisId,
  supabase
} from "./TestingUtils";

test.describe("SIS Import (RPC)", () => {
  test.describe.configure({ mode: "serial" });

  test("creates invitation for SIS user without account", async () => {
    const course = await createClass({ name: "E2E SIS Import - No Account" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [11111], lab_section_crns: [22222] });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "No Account Student",
          role: "student",
          class_section_crn: 11111,
          lab_section_crn: 22222
        }
      ]
    });

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user).toBeUndefined();
    expect(state.user_role).toBeNull();
    expect(state.invitation?.status).toBe("pending");
    expect(state.invitation?.sis_managed).toBe(true);
    expect(state.invitation?.class_section_id).not.toBeNull();
    expect(state.invitation?.lab_section_id).not.toBeNull();
  });

  test("expires invitation on drop then reactivates on re-add to different section", async () => {
    const course = await createClass({ name: "E2E SIS Import - Invite Drop Readd" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [21111, 21112],
      lab_section_crns: [22222, 22223]
    });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Create invitation via sync
    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Invite Drop Readd Student",
          role: "student",
          class_section_crn: 21111,
          lab_section_crn: 22222
        }
      ]
    });
    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user).toBeUndefined();
    expect(state.invitation?.status).toBe("pending");
    const firstClassSection = state.invitation?.class_section_id;
    const firstLabSection = state.invitation?.lab_section_id;

    // Drop -> invitation expires
    await simulateSISSync({ class_id: course.id, roster: [] });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.status).toBe("expired");

    // Re-add different section -> invitation becomes pending and section ids update
    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Invite Drop Readd Student",
          role: "student",
          class_section_crn: 21112,
          lab_section_crn: 22223
        }
      ]
    });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.status).toBe("pending");
    expect(state.invitation?.class_section_id).not.toBe(firstClassSection);
    expect(state.invitation?.lab_section_id).not.toBe(firstLabSection);
  });

  test("adopts manual invitation (sis_managed=false) when SIS roster includes student", async () => {
    const course = await createClass({ name: "E2E SIS Import - Adopt Manual Invitation" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [81111],
      lab_section_crns: [82222]
    });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    const { error: inviteErr } = await supabase.rpc("create_invitation", {
      p_class_id: course.id,
      p_role: "student",
      p_sis_user_id: sis_user_id,
      p_name: "Manual Invitation Student",
      p_email: undefined,
      p_invited_by: undefined,
      p_class_section_id: undefined,
      p_lab_section_id: undefined,
      p_sis_managed: false
    });
    if (inviteErr) throw new Error(`create_invitation failed: ${inviteErr.message}`);

    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.sis_managed).toBe(false);

    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Manual Invitation Student",
          role: "student",
          class_section_crn: 81111,
          lab_section_crn: 82222
        }
      ]
    });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.sis_managed).toBe(true);
    expect(state.invitation?.class_section_id).not.toBeNull();
    expect(state.invitation?.lab_section_id).not.toBeNull();
  });

  test("upgrades role but does not downgrade", async () => {
    const course = await createClass({ name: "E2E SIS Import - Role Upgrade" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [91111], lab_section_crns: [] });

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Role Upgrade Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // Adopt as student
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Role Upgrade Student", role: "student", class_section_crn: 91111 }]
    });
    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.role).toBe("student");

    // Upgrade to grader
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Role Upgrade Student", role: "grader", class_section_crn: 91111 }]
    });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.role).toBe("grader");

    // SIS says student again -> should not downgrade
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Role Upgrade Student", role: "student", class_section_crn: 91111 }]
    });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.role).toBe("grader");
  });

  test("enrolls existing account directly (no enrollment yet)", async () => {
    const course = await createClass({ name: "E2E SIS Import - Existing Account" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [31111], lab_section_crns: [32222] });

    // Create an existing account in a different class so the user exists but is not enrolled in this class.
    const otherCourse = await createClass({ name: "E2E SIS Import - Other Class" });
    const [existingStudent] = await createUsersInClass([
      { role: "student", class_id: otherCourse.id, useMagicLink: true, name: "Existing Account Student" }
    ]);

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(existingStudent.user_id, sis_user_id);

    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Existing Account Student",
          role: "student",
          class_section_crn: 31111,
          lab_section_crn: 32222
        }
      ]
    });

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user?.user_id).toBe(existingStudent.user_id);
    expect(state.user_role?.disabled).toBe(false);
    expect(state.user_role?.canvas_id).toBe(sis_user_id);
    expect(state.user_role?.class_section_id).not.toBeNull();
    expect(state.user_role?.lab_section_id).not.toBeNull();
  });

  test("disables on drop then re-enables on re-add (different section)", async () => {
    const course = await createClass({ name: "E2E SIS Import - Drop Re-add" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [41111, 41112],
      lab_section_crns: [42222, 42223]
    });

    // Start as manual enrollment, then adopt into SIS-managed on first sync.
    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Drop Readd Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // First sync: adopt + set sections
    await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id, name: "Drop Readd Student", role: "student", class_section_crn: 41111, lab_section_crn: 42222 }
      ]
    });
    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(false);
    expect(state.user_role?.canvas_id).toBe(sis_user_id);
    const firstClassSection = state.user_role?.class_section_id;
    const firstLabSection = state.user_role?.lab_section_id;

    // Drop from SIS: roster empty -> disable (SIS-managed because canvas_id is set)
    await simulateSISSync({ class_id: course.id, roster: [] });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(true);

    // Re-add to different sections -> re-enable + update sections
    await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id, name: "Drop Readd Student", role: "student", class_section_crn: 41112, lab_section_crn: 42223 }
      ]
    });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(false);
    expect(state.user_role?.class_section_id).not.toBe(firstClassSection);
    expect(state.user_role?.lab_section_id).not.toBe(firstLabSection);
  });

  test("adopts manual enrollment when student appears in SIS (overwrites sections)", async () => {
    const course = await createClass({ name: "E2E SIS Import - Adopt Manual" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [51111, 51112],
      lab_section_crns: [52222, 52223]
    });

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Manual Then SIS Student"
    });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // Put them in an arbitrary manual section first (not SIS sections)
    const manualSection = await createClassSection({ class_id: course.id, name: "Manual Section" });
    await supabase
      .from("user_roles")
      .update({ class_section_id: manualSection.id, lab_section_id: null, sis_sync_opt_out: false })
      .eq("class_id", course.id)
      .eq("user_id", student.user_id);

    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.canvas_id).toBeNull();
    expect(state.user_role?.class_section_id).toBe(manualSection.id);

    // Now student appears in SIS in a SIS section -> should adopt + overwrite sections and set canvas_id
    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Manual Then SIS Student",
          role: "student",
          class_section_crn: 51112,
          lab_section_crn: 52223
        }
      ]
    });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.canvas_id).toBe(sis_user_id);
    expect(state.user_role?.class_section_id).not.toBe(manualSection.id);
    expect(state.user_role?.lab_section_id).not.toBeNull();
  });

  test("does NOT disable manual enrollment when student not in SIS (canvas_id is NULL)", async () => {
    const course = await createClass({ name: "E2E SIS Import - Manual Not Disabled" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [61111], lab_section_crns: [62222] });

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Manual Only Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.canvas_id).toBeNull();
    expect(state.user_role?.disabled).toBe(false);

    // Run sync with empty roster. Because canvas_id is NULL, it should NOT disable.
    await simulateSISSync({ class_id: course.id, roster: [] });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(false);
  });

  test("respects sis_sync_opt_out: does not disable or overwrite sections", async () => {
    const course = await createClass({ name: "E2E SIS Import - Opt Out" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [71111, 71112],
      lab_section_crns: [72222, 72223]
    });

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Opt Out Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // First sync: adopt into SIS-managed and assign sections
    await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id, name: "Opt Out Student", role: "student", class_section_crn: 71111, lab_section_crn: 72222 }
      ]
    });

    // Set opt-out
    await supabase
      .from("user_roles")
      .update({ sis_sync_opt_out: true })
      .eq("class_id", course.id)
      .eq("user_id", student.user_id);

    const before = await getEnrollmentState(course.id, sis_user_id);
    expect(before.user_role?.sis_sync_opt_out).toBe(true);

    // SIS says they moved sections -> should NOT update because opted out
    await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id, name: "Opt Out Student", role: "student", class_section_crn: 71112, lab_section_crn: 72223 }
      ]
    });

    let after = await getEnrollmentState(course.id, sis_user_id);
    expect(after.user_role?.class_section_id).toBe(before.user_role?.class_section_id);
    expect(after.user_role?.lab_section_id).toBe(before.user_role?.lab_section_id);

    // Drop from SIS -> should NOT disable because opted out
    await simulateSISSync({ class_id: course.id, roster: [] });
    after = await getEnrollmentState(course.id, sis_user_id);
    expect(after.user_role?.disabled).toBe(false);
  });

  test("rolls back atomically on RPC failure (no partial invitation)", async () => {
    const course = await createClass({ name: "E2E SIS Import - Atomic Rollback" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [], lab_section_crns: [12345] });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    const { error } = await supabase.rpc("sis_sync_enrollment", {
      p_class_id: course.id,
      p_roster_data: [
        {
          sis_user_id,
          name: "Rollback Student",
          role: "student",
          lab_section_crn: 12345
        }
      ],
      p_sync_options: {
        expire_missing: true,
        section_updates: [
          {
            section_type: "lab",
            sis_crn: 12345,
            // Intentionally invalid enum to force a DB error during the RPC
            day_of_week: "notaday"
          }
        ]
      }
    });
    expect(error).toBeTruthy();

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation).toBeNull();
    expect(state.user_role).toBeNull();
  });

  test("respects disabled sync sections (does not disable enrollment tied to disabled section)", async () => {
    const course = await createClass({ name: "E2E SIS Import - Disabled Section" });
    const { classSections } = await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [55555],
      lab_section_crns: []
    });
    const sectionId = classSections[0]!.id;

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Disabled Section Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // First sync: adopt and assign to the SIS-managed class section
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Disabled Section Student", role: "student", class_section_crn: 55555 }]
    });

    // Mark the section as sync-disabled
    const { error: disableErr } = await supabase.from("sis_sync_status").insert({
      course_id: course.id,
      course_section_id: sectionId,
      sync_enabled: false
    });
    if (disableErr) throw new Error(`Failed to disable sync for section: ${disableErr.message}`);

    // Drop from SIS -> should NOT disable because their section is sync-disabled
    await simulateSISSync({ class_id: course.id, roster: [] });
    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(false);
  });
});

test.describe("SIS Import (RPC) - Additional Coverage", () => {
  test.describe.configure({ mode: "serial" });

  // =========================================================================
  // 1. expire_missing: false option
  // =========================================================================
  test("does NOT expire invitations or disable enrollments when expire_missing=false", async () => {
    const course = await createClass({ name: "E2E SIS - No Expire Missing" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [33333], lab_section_crns: [] });

    // User 1: will get invitation
    const sis_user_id_1 = Math.floor(1_000_000_000 + Math.random() * 100_000);
    // User 2: will get enrollment
    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "No Expire Student"
    });
    const sis_user_id_2 = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id_2);

    // Initial sync: create invitation for user 1, adopt user 2
    await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id: sis_user_id_1, name: "Invitation User", role: "student", class_section_crn: 33333 },
        { sis_user_id: sis_user_id_2, name: "Enrolled User", role: "student", class_section_crn: 33333 }
      ]
    });

    let state1 = await getEnrollmentState(course.id, sis_user_id_1);
    let state2 = await getEnrollmentState(course.id, sis_user_id_2);
    expect(state1.invitation?.status).toBe("pending");
    expect(state2.user_role?.disabled).toBe(false);

    // Sync with empty roster BUT expire_missing=false
    await simulateSISSync({
      class_id: course.id,
      roster: [],
      expire_missing: false
    });

    // Both should remain unchanged
    state1 = await getEnrollmentState(course.id, sis_user_id_1);
    state2 = await getEnrollmentState(course.id, sis_user_id_2);
    expect(state1.invitation?.status).toBe("pending"); // NOT expired
    expect(state2.user_role?.disabled).toBe(false); // NOT disabled
  });

  // =========================================================================
  // 2. Section metadata updates
  // =========================================================================
  test("updates class section metadata via section_updates", async () => {
    const course = await createClass({ name: "E2E SIS - Section Updates Class" });
    const { classSections } = await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [44444],
      lab_section_crns: []
    });

    await simulateSISSync({
      class_id: course.id,
      roster: [],
      section_updates: [
        {
          section_type: "class",
          sis_crn: 44444,
          meeting_location: "Room 101",
          meeting_times: "MWF 10:00-11:00",
          campus: "Main Campus"
        }
      ]
    });

    const { data: section } = await supabase
      .from("class_sections")
      .select("meeting_location, meeting_times, campus")
      .eq("id", classSections[0].id)
      .single();

    expect(section?.meeting_location).toBe("Room 101");
    expect(section?.meeting_times).toBe("MWF 10:00-11:00");
    expect(section?.campus).toBe("Main Campus");
  });

  test("updates lab section metadata including day_of_week and times", async () => {
    const course = await createClass({ name: "E2E SIS - Section Updates Lab" });
    const { labSections } = await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [],
      lab_section_crns: [55556]
    });

    await simulateSISSync({
      class_id: course.id,
      roster: [],
      section_updates: [
        {
          section_type: "lab",
          sis_crn: 55556,
          meeting_location: "Lab Room 202",
          meeting_times: "T 2:00-4:00",
          campus: "Science Building",
          day_of_week: "tuesday",
          start_time: "14:00",
          end_time: "16:00"
        }
      ]
    });

    const { data: section } = await supabase
      .from("lab_sections")
      .select("meeting_location, meeting_times, campus, day_of_week, start_time, end_time")
      .eq("id", labSections[0].id)
      .single();

    expect(section?.meeting_location).toBe("Lab Room 202");
    expect(section?.day_of_week).toBe("tuesday");
    expect(section?.start_time).toBe("14:00:00");
    expect(section?.end_time).toBe("16:00:00");
  });

  test("does NOT update disabled sync section metadata", async () => {
    const course = await createClass({ name: "E2E SIS - Disabled Section Update" });
    const { classSections } = await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [66666],
      lab_section_crns: []
    });

    // Disable sync for this section
    await supabase.from("sis_sync_status").insert({
      course_id: course.id,
      course_section_id: classSections[0].id,
      sync_enabled: false
    });

    // Set initial metadata
    await supabase.from("class_sections").update({ meeting_location: "Original Room" }).eq("id", classSections[0].id);

    // Try to update via SIS sync
    await simulateSISSync({
      class_id: course.id,
      roster: [],
      section_updates: [
        {
          section_type: "class",
          sis_crn: 66666,
          meeting_location: "New Room"
        }
      ]
    });

    // Should NOT have changed
    const { data: section } = await supabase
      .from("class_sections")
      .select("meeting_location")
      .eq("id", classSections[0].id)
      .single();

    expect(section?.meeting_location).toBe("Original Room");
  });

  // =========================================================================
  // 3. CRN resolution edge cases
  // =========================================================================
  test("handles user with non-existent CRN (section_id becomes null)", async () => {
    const course = await createClass({ name: "E2E SIS - Bad CRN" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [77777], lab_section_crns: [] });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Sync with a CRN that doesn't exist
    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Bad CRN Student",
          role: "student",
          class_section_crn: 99999 // Does not exist
        }
      ]
    });

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.status).toBe("pending");
    expect(state.invitation?.class_section_id).toBeNull(); // CRN didn't resolve
  });

  test("handles user with only class_section_crn (no lab)", async () => {
    const course = await createClass({ name: "E2E SIS - Class Only" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [88888],
      lab_section_crns: [88889]
    });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Class Only Student",
          role: "student",
          class_section_crn: 88888
          // No lab_section_crn
        }
      ]
    });

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.class_section_id).not.toBeNull();
    expect(state.invitation?.lab_section_id).toBeNull();
  });

  // =========================================================================
  // 4. Multiple users in single sync (mix of operations)
  // =========================================================================
  test("handles mixed roster: new users, existing users, and drops", async () => {
    const course = await createClass({ name: "E2E SIS - Mixed Roster" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [10001], lab_section_crns: [] });

    // Create two existing students
    const student1 = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Mixed Student 1"
    });
    const student2 = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Mixed Student 2"
    });
    const sis_id_1 = Math.floor(1_000_000_000 + Math.random() * 100_000);
    const sis_id_2 = Math.floor(1_000_000_000 + Math.random() * 100_000);
    const sis_id_new = Math.floor(1_000_000_000 + Math.random() * 100_000);

    await setUserSisId(student1.user_id, sis_id_1);
    await setUserSisId(student2.user_id, sis_id_2);

    // Initial sync: both students
    await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id: sis_id_1, name: "Mixed Student 1", role: "student", class_section_crn: 10001 },
        { sis_user_id: sis_id_2, name: "Mixed Student 2", role: "student", class_section_crn: 10001 }
      ]
    });

    // Second sync: drop student2, add new student
    const result = await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id: sis_id_1, name: "Mixed Student 1", role: "student", class_section_crn: 10001 },
        { sis_user_id: sis_id_new, name: "New SIS Student", role: "student", class_section_crn: 10001 }
      ]
    });

    // Verify states
    const state1 = await getEnrollmentState(course.id, sis_id_1);
    const state2 = await getEnrollmentState(course.id, sis_id_2);
    const stateNew = await getEnrollmentState(course.id, sis_id_new);

    expect(state1.user_role?.disabled).toBe(false); // Still active
    expect(state2.user_role?.disabled).toBe(true); // Dropped
    expect(stateNew.invitation?.status).toBe("pending"); // New invitation

    // Verify counts in result
    expect(result.counts.invitations_created).toBe(1);
    expect(result.counts.enrollments_disabled).toBe(1);
  });

  // =========================================================================
  // 5. Non-SIS invitation NOT expired on drop
  // =========================================================================
  test("does NOT expire non-SIS-managed invitation on drop", async () => {
    const course = await createClass({ name: "E2E SIS - Non-SIS Invite No Expire" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [20001], lab_section_crns: [] });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Create manual (non-SIS) invitation
    await supabase.rpc("create_invitation", {
      p_class_id: course.id,
      p_role: "student",
      p_sis_user_id: sis_user_id,
      p_name: "Manual Invite Only",
      p_email: undefined,
      p_invited_by: undefined,
      p_class_section_id: undefined,
      p_lab_section_id: undefined,
      p_sis_managed: false
    });

    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.sis_managed).toBe(false);
    expect(state.invitation?.status).toBe("pending");

    // Sync with empty roster (user not in SIS)
    await simulateSISSync({ class_id: course.id, roster: [] });

    // Should NOT be expired because sis_managed=false
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.status).toBe("pending");
  });

  // =========================================================================
  // 6. Return counts verification
  // =========================================================================
  test("returns accurate counts for all operations", async () => {
    const course = await createClass({ name: "E2E SIS - Counts Verification" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [30001], lab_section_crns: [] });

    const sis_id_existing = Math.floor(1_000_000_000 + Math.random() * 100_000);
    const sis_id_new1 = Math.floor(1_000_000_000 + Math.random() * 100_000);
    const sis_id_new2 = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Create existing student
    const existingStudent = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Count Test Existing"
    });
    await setUserSisId(existingStudent.user_id, sis_id_existing);

    // First sync
    const result1 = await simulateSISSync({
      class_id: course.id,
      roster: [
        { sis_user_id: sis_id_existing, name: "Count Test Existing", role: "student", class_section_crn: 30001 },
        { sis_user_id: sis_id_new1, name: "Count Test New 1", role: "student", class_section_crn: 30001 },
        { sis_user_id: sis_id_new2, name: "Count Test New 2", role: "student", class_section_crn: 30001 }
      ]
    });

    expect(result1.success).toBe(true);
    expect(result1.counts.invitations_created).toBe(2); // Two new users without accounts
    expect(result1.counts.enrollments_adopted).toBe(1); // Existing student adopted
  });

  // =========================================================================
  // 7. Disabled lab section
  // =========================================================================
  test("respects disabled lab section sync (does not disable enrollment)", async () => {
    const course = await createClass({ name: "E2E SIS - Disabled Lab Section" });
    const { labSections } = await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [],
      lab_section_crns: [40001]
    });

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Disabled Lab Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // Adopt into SIS
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Disabled Lab Student", role: "student", lab_section_crn: 40001 }]
    });

    // Disable sync for the lab section
    await supabase.from("sis_sync_status").insert({
      course_id: course.id,
      lab_section_id: labSections[0].id,
      sync_enabled: false
    });

    // Drop from SIS
    await simulateSISSync({ class_id: course.id, roster: [] });

    // Should NOT be disabled
    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(false);
  });

  // =========================================================================
  // 8. Invitation role upgrade
  // =========================================================================
  test("upgrades invitation role when higher role in roster", async () => {
    const course = await createClass({ name: "E2E SIS - Invitation Role Upgrade" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [50001], lab_section_crns: [] });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Create as student
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Role Up Invite", role: "student", class_section_crn: 50001 }]
    });

    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.role).toBe("student");

    // Upgrade to grader in SIS
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Role Up Invite", role: "grader", class_section_crn: 50001 }]
    });

    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.role).toBe("grader");
  });

  // =========================================================================
  // 9. Re-enable tracks enrollments_reenabled correctly
  // =========================================================================
  test("tracks enrollments_reenabled count when disabled user is re-added", async () => {
    const course = await createClass({ name: "E2E SIS - Reenable Count" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [60001], lab_section_crns: [] });

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Reenable Count Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // Adopt, drop, then re-add
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Reenable Count Student", role: "student", class_section_crn: 60001 }]
    });
    await simulateSISSync({ class_id: course.id, roster: [] });

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(true);

    // Re-add
    const result = await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Reenable Count Student", role: "student", class_section_crn: 60001 }]
    });

    expect(result.counts.enrollments_reenabled).toBe(1);
    const stateAfter = await getEnrollmentState(course.id, sis_user_id);
    expect(stateAfter.user_role?.disabled).toBe(false);
  });

  // =========================================================================
  // 10. Empty initial roster (edge case - no-op)
  // =========================================================================
  test("handles initial sync with empty roster (no-op)", async () => {
    const course = await createClass({ name: "E2E SIS - Empty Initial Roster" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [70001], lab_section_crns: [] });

    const result = await simulateSISSync({
      class_id: course.id,
      roster: []
    });

    expect(result.success).toBe(true);
    expect(result.counts.invitations_created).toBe(0);
    expect(result.counts.enrollments_created).toBe(0);
    expect(result.counts.enrollments_disabled).toBe(0);
  });

  // =========================================================================
  // 11. Enrollment via invitation_id considered SIS-managed
  // =========================================================================
  test("disables enrollment linked via sis_managed invitation when dropped", async () => {
    const course = await createClass({ name: "E2E SIS - Invitation Link Disable" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [80001], lab_section_crns: [] });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Create invitation via SIS sync
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Invitation Link Student", role: "student", class_section_crn: 80001 }]
    });

    // Simulate user accepting invitation (create user + enrollment manually linked)
    const { data: invitation } = await supabase
      .from("invitations")
      .select("id")
      .eq("class_id", course.id)
      .eq("sis_user_id", sis_user_id)
      .single();

    // Create a new user with the sis_user_id
    const newUser = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Invitation Link Student"
    });
    await setUserSisId(newUser.user_id, sis_user_id);

    if (!invitation?.id) {
      throw new Error("Invitation ID is missing");
    }

    // Link the enrollment to the invitation
    await supabase
      .from("user_roles")
      .update({ invitation_id: invitation.id })
      .eq("class_id", course.id)
      .eq("user_id", newUser.user_id);

    // Mark invitation as accepted
    await supabase
      .from("invitations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", invitation.id);

    // Drop from SIS
    await simulateSISSync({ class_id: course.id, roster: [] });

    // Should be disabled because linked invitation is sis_managed
    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.disabled).toBe(true);
  });

  // =========================================================================
  // 12. Instructor role upgrade from student
  // =========================================================================
  test("upgrades enrollment from student to instructor", async () => {
    const course = await createClass({ name: "E2E SIS - Student to Instructor" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [90001], lab_section_crns: [] });

    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Student to Instructor"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // Initial sync as student
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Student to Instructor", role: "student", class_section_crn: 90001 }]
    });

    // Upgrade to instructor
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Student to Instructor", role: "instructor", class_section_crn: 90001 }]
    });

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.user_role?.role).toBe("instructor");
  });

  // =========================================================================
  // 13. Partial null section IDs in roster (only one section specified)
  // =========================================================================
  test("handles roster entry with only lab_section_crn, no class_section", async () => {
    const course = await createClass({ name: "E2E SIS - Lab Only Roster" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [11001],
      lab_section_crns: [11002]
    });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    await simulateSISSync({
      class_id: course.id,
      roster: [
        {
          sis_user_id,
          name: "Lab Only Student",
          role: "student",
          lab_section_crn: 11002
          // No class_section_crn
        }
      ]
    });

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.class_section_id).toBeNull();
    expect(state.invitation?.lab_section_id).not.toBeNull();
  });

  // =========================================================================
  // 14. Reactivates expired invitation and updates sections
  // =========================================================================
  test("reactivates expired invitation with updated section data", async () => {
    const course = await createClass({ name: "E2E SIS - Reactivate With New Section" });
    const { classSections } = await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [12001, 12002],
      lab_section_crns: []
    });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Create invitation in section 1
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Reactivate Student", role: "student", class_section_crn: 12001 }]
    });

    let state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.class_section_id).toBe(classSections[0].id);

    // Expire by dropping
    await simulateSISSync({ class_id: course.id, roster: [] });
    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.status).toBe("expired");

    // Reactivate in section 2
    const result = await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Reactivate Student", role: "student", class_section_crn: 12002 }]
    });

    state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.status).toBe("pending");
    expect(state.invitation?.class_section_id).toBe(classSections[1].id);
    expect(result.counts.invitations_reactivated).toBe(1);
  });

  // =========================================================================
  // 15. Existing enrollment for user in different class (not affected)
  // =========================================================================
  test("does not affect enrollments in other classes", async () => {
    const course1 = await createClass({ name: "E2E SIS - Course 1" });
    const course2 = await createClass({ name: "E2E SIS - Course 2" });
    await createClassWithSISSections({ class_id: course1.id, class_section_crns: [13001], lab_section_crns: [] });
    await createClassWithSISSections({ class_id: course2.id, class_section_crns: [13002], lab_section_crns: [] });

    const student = await createUserInClass({
      role: "student",
      class_id: course1.id,
      useMagicLink: true,
      name: "Multi Course Student"
    });
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // Adopt in course 1
    await simulateSISSync({
      class_id: course1.id,
      roster: [{ sis_user_id, name: "Multi Course Student", role: "student", class_section_crn: 13001 }]
    });

    // Create enrollment in course 2 manually
    await createUserInClass({
      role: "student",
      class_id: course2.id,
      useMagicLink: true,
      name: "Multi Course Student",
      email: student.email
    });

    // Drop from course 1 SIS
    await simulateSISSync({ class_id: course1.id, roster: [] });

    // Course 1 enrollment should be disabled
    const state1 = await getEnrollmentState(course1.id, sis_user_id);
    expect(state1.user_role?.disabled).toBe(true);

    // Course 2 enrollment should be unaffected (query by user_id since no SIS link there)
    const { data: course2Role } = await supabase
      .from("user_roles")
      .select("disabled")
      .eq("class_id", course2.id)
      .eq("user_id", student.user_id)
      .single();
    expect(course2Role?.disabled).toBe(false);
  });

  // =========================================================================
  // 16. Name update on existing invitation
  // =========================================================================
  test("updates name on existing invitation when roster includes updated name", async () => {
    const course = await createClass({ name: "E2E SIS - Name Update" });
    await createClassWithSISSections({ class_id: course.id, class_section_crns: [14001], lab_section_crns: [] });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    // Create invitation with original name
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Original Name", role: "student", class_section_crn: 14001 }]
    });

    // Update with new name
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Updated Name", role: "student", class_section_crn: 14001 }]
    });

    const { data: invitation } = await supabase
      .from("invitations")
      .select("name")
      .eq("class_id", course.id)
      .eq("sis_user_id", sis_user_id)
      .single();

    expect(invitation?.name).toBe("Updated Name");
  });
});
