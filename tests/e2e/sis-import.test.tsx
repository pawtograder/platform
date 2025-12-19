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
