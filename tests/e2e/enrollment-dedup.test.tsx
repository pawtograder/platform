import { test, expect } from "../global-setup";
import {
  createClass,
  createClassWithSISSections,
  createUserInClass,
  createUsersInClass,
  simulateSISSync,
  getEnrollmentState,
  getEnrollmentRowsForSisUser,
  setUserSisId,
  supabase
} from "./TestingUtils";

// Covers #390 (a student must never get a second profile / enrollment in one
// class) and #387 (its gradebook double-row symptom), plus the backfill that
// merges any pre-existing duplicates and the unique-index guard.
test.describe("Enrollment de-duplication (#390/#387)", () => {
  test("invitation for an already-enrolled user upgrades the existing enrollment, never duplicates the profile", async () => {
    const course = await createClass({ name: "E2E Dedup - Invite Upgrade" });
    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Upgrade Me"
    });

    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    // Manually invite the same person as a grader. The AFTER INSERT auto-accept
    // trigger used to INSERT a second user_role (a fresh profile pair) here.
    const { error } = await supabase.rpc("create_invitation", {
      p_class_id: course.id,
      p_role: "grader",
      p_sis_user_id: sis_user_id,
      p_name: "Upgrade Me",
      p_email: undefined,
      p_invited_by: undefined,
      p_class_section_id: undefined,
      p_lab_section_id: undefined,
      p_sis_managed: false
    });
    if (error) throw new Error(`create_invitation failed: ${error.message}`);

    const rows = await getEnrollmentRowsForSisUser(course.id, sis_user_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("grader"); // upgraded in place
    expect(rows[0].private_profile_id).toBe(student.private_profile_id); // profile reused
    expect(rows[0].public_profile_id).toBe(student.public_profile_id);

    const state = await getEnrollmentState(course.id, sis_user_id);
    expect(state.invitation?.status).toBe("accepted");
  });

  test("SIS section move keeps a single enrollment and profile", async () => {
    const course = await createClass({ name: "E2E Dedup - Section Move" });
    await createClassWithSISSections({
      class_id: course.id,
      class_section_crns: [41111, 41112],
      lab_section_crns: []
    });

    // Existing account (enrolled elsewhere) so the SIS sync enrolls them here.
    const other = await createClass({ name: "E2E Dedup - Section Move Other" });
    const [student] = await createUsersInClass([
      { role: "student", class_id: other.id, useMagicLink: true, name: "Mover" }
    ]);
    const sis_user_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_user_id);

    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Mover", role: "student", class_section_crn: 41111 }]
    });
    let rows = await getEnrollmentRowsForSisUser(course.id, sis_user_id);
    expect(rows).toHaveLength(1);
    const profileAfterFirst = rows[0].private_profile_id;
    const sectionA = rows[0].class_section_id;

    // Move to the other section.
    await simulateSISSync({
      class_id: course.id,
      roster: [{ sis_user_id, name: "Mover", role: "student", class_section_crn: 41112 }]
    });
    rows = await getEnrollmentRowsForSisUser(course.id, sis_user_id);
    expect(rows).toHaveLength(1); // no duplicate enrollment
    expect(rows[0].private_profile_id).toBe(profileAfterFirst); // same profile reused
    expect(rows[0].class_section_id).not.toBe(sectionA); // section updated in place
    expect(rows[0].disabled).toBe(false);
  });

  test("a second active enrollment for the same (user, class) is rejected by the unique index", async () => {
    const course = await createClass({ name: "E2E Dedup - Unique Guard" });
    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Only Once"
    });

    const { data: priv } = await supabase
      .from("profiles")
      .insert({ class_id: course.id, name: `guard-priv-${Date.now()}`, is_private_profile: true })
      .select("id")
      .single();
    const { data: pub } = await supabase
      .from("profiles")
      .insert({ class_id: course.id, name: `guard-pub-${Date.now()}`, is_private_profile: false })
      .select("id")
      .single();

    const { error } = await supabase.from("user_roles").insert({
      user_id: student.user_id,
      class_id: course.id,
      role: "grader",
      private_profile_id: priv!.id,
      public_profile_id: pub!.id,
      disabled: false
    });
    expect(error).not.toBeNull(); // idx_user_roles_one_active_per_class blocks it
    expect(error?.code).toBe("23505"); // unique_violation
    expect(error?.message ?? "").toContain("idx_user_roles_one_active_per_class");
  });

  test("merge_duplicate_class_enrollments collapses a pre-existing duplicate profile", async () => {
    const course = await createClass({ name: "E2E Dedup - Backfill Merge" });
    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Doubled Student"
    });

    // Seed a historical duplicate: a second (disabled, different-role) enrollment
    // with its own profile pair, mimicking data created before the guard existed.
    const { data: priv2 } = await supabase
      .from("profiles")
      .insert({ class_id: course.id, name: `dup-priv-${Date.now()}`, is_private_profile: true })
      .select("id")
      .single();
    const { data: pub2 } = await supabase
      .from("profiles")
      .insert({ class_id: course.id, name: `dup-pub-${Date.now()}`, is_private_profile: false })
      .select("id")
      .single();
    const { error: seedErr } = await supabase.from("user_roles").insert({
      user_id: student.user_id,
      class_id: course.id,
      role: "grader",
      private_profile_id: priv2!.id,
      public_profile_id: pub2!.id,
      disabled: true
    });
    if (seedErr) throw new Error(`failed to seed duplicate: ${seedErr.message}`);

    // Sanity: two rows exist before the merge.
    const before = await supabase
      .from("user_roles")
      .select("id")
      .eq("class_id", course.id)
      .eq("user_id", student.user_id);
    expect(before.data).toHaveLength(2);

    const { data: merged, error: mergeErr } = await supabase.rpc("merge_duplicate_class_enrollments", {
      p_class_id: course.id
    });
    if (mergeErr) throw new Error(`merge failed: ${mergeErr.message}`);
    expect(merged).toBe(1);

    const after = await supabase
      .from("user_roles")
      .select("id, role, disabled, private_profile_id, public_profile_id")
      .eq("class_id", course.id)
      .eq("user_id", student.user_id);
    expect(after.data).toHaveLength(1);
    // Canonical = the active original; it adopts the strongest role and stays active.
    expect(after.data![0].private_profile_id).toBe(student.private_profile_id);
    expect(after.data![0].role).toBe("grader");
    expect(after.data![0].disabled).toBe(false);

    // The losing profile pair is gone.
    const { data: leftover } = await supabase.from("profiles").select("id").in("id", [priv2!.id, pub2!.id]);
    expect(leftover).toHaveLength(0);

    // Idempotent: re-running finds nothing to merge.
    const { data: mergedAgain } = await supabase.rpc("merge_duplicate_class_enrollments", { p_class_id: course.id });
    expect(mergedAgain).toBe(0);
  });
});
