import { test, expect } from "../global-setup";
import {
  createClass,
  createUserInClass,
  createUsersInClass,
  getEnrollmentState,
  getEnrollmentRowsForSisUser,
  setUserSisId,
  supabase
} from "./TestingUtils";

type BulkImportResult = {
  enrolled_directly: number;
  invitations_created: number;
  reactivated: number;
  errors: Array<{ identifier: string | number; error: string }>;
};

async function bulkImport(
  class_id: number,
  mode: "sis_id" | "email",
  rows: Array<{ email?: string; name: string; role?: string; sis_id?: number; sis_sync_opt_out?: boolean }>
): Promise<BulkImportResult> {
  const { data, error } = await supabase.rpc("bulk_csv_import_enrollment", {
    p_class_id: class_id,
    p_import_mode: mode,
    p_enrollment_data: rows,
    p_notify: false
  });
  if (error) throw new Error(`bulk_csv_import_enrollment failed: ${error.message}`);
  return data as unknown as BulkImportResult;
}

test.describe("Bulk CSV invitation import (#322)", () => {
  test("invitations no longer have an expires_at column (auto-expiry removed)", async () => {
    // The column is dropped at the DB level; selecting it must error.
    const { error } = await (
      supabase.from("invitations") as unknown as { select: (c: string) => Promise<{ error: unknown }> }
    ).select("expires_at");
    expect(error).not.toBeNull();
    const message = String((error as { message?: string } | null)?.message ?? error);
    expect(message.toLowerCase()).toContain("expires_at");
  });

  test("SIS-ID mode creates a pending, manually-managed invitation for an unknown user", async () => {
    const course = await createClass({ name: "E2E Bulk - SIS New User" });
    const sis_id = Math.floor(1_000_000_000 + Math.random() * 100_000);

    const result = await bulkImport(course.id, "sis_id", [{ sis_id, name: "Brand New", role: "student" }]);
    expect(result.invitations_created).toBe(1);
    expect(result.errors).toHaveLength(0);

    const state = await getEnrollmentState(course.id, sis_id);
    expect(state.invitation?.status).toBe("pending");
    expect(state.invitation?.sis_managed).toBe(false); // manual import
  });

  test("SIS-ID mode reactivates an already-enrolled user without creating a new profile", async () => {
    const course = await createClass({ name: "E2E Bulk - SIS Reactivate" });
    const student = await createUserInClass({
      role: "student",
      class_id: course.id,
      useMagicLink: true,
      name: "Returning Student"
    });
    const sis_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_id);
    await supabase
      .from("user_roles")
      .update({ disabled: true })
      .eq("class_id", course.id)
      .eq("user_id", student.user_id);

    const result = await bulkImport(course.id, "sis_id", [{ sis_id, name: "Returning Student", role: "student" }]);
    expect(result.reactivated).toBe(1);
    expect(result.invitations_created).toBe(0);

    const rows = await getEnrollmentRowsForSisUser(course.id, sis_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].disabled).toBe(false);
    expect(rows[0].private_profile_id).toBe(student.private_profile_id); // reused, not duplicated
  });

  test("SIS-ID mode enrolls an existing account (not yet in this class) with exactly one profile", async () => {
    const course = await createClass({ name: "E2E Bulk - SIS Enroll Existing" });
    const other = await createClass({ name: "E2E Bulk - SIS Enroll Existing Other" });
    const [student] = await createUsersInClass([
      { role: "student", class_id: other.id, useMagicLink: true, name: "Existing Account" }
    ]);
    const sis_id = Math.floor(1_000_000_000 + Math.random() * 100_000);
    await setUserSisId(student.user_id, sis_id);

    const result = await bulkImport(course.id, "sis_id", [{ sis_id, name: "Existing Account", role: "student" }]);
    expect(result.enrolled_directly).toBe(1);

    const rows = await getEnrollmentRowsForSisUser(course.id, sis_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].disabled).toBe(false);
  });

  test("email mode collects per-row errors without aborting the good rows", async () => {
    const course = await createClass({ name: "E2E Bulk - Email Mixed" });
    const suffix = Math.random().toString(36).substring(2, 8);
    const goodEmail = `bulk-good-${suffix}@pawtograder.net`;
    const badEmail = `bulk-bad-${suffix}@gmail.com`; // unsupported domain

    const result = await bulkImport(course.id, "email", [
      { email: goodEmail, name: "Good Domain", role: "student" },
      { email: badEmail, name: "Bad Domain", role: "student" }
    ]);

    expect(result.enrolled_directly).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0].identifier)).toBe(badEmail);

    // The good user really was enrolled.
    const { data: enrolled } = await supabase
      .from("user_roles")
      .select("id, users!inner(email)")
      .eq("class_id", course.id)
      .eq("users.email", goodEmail);
    expect(enrolled).toHaveLength(1);
  });

  test("an invalid import mode raises and writes nothing", async () => {
    const course = await createClass({ name: "E2E Bulk - Invalid Mode" });
    const { error } = await supabase.rpc("bulk_csv_import_enrollment", {
      p_class_id: course.id,
      p_import_mode: "nonsense",
      p_enrollment_data: [{ sis_id: 999, name: "Nope" }],
      p_notify: false
    });
    expect(error).not.toBeNull();

    const { data: invitations } = await supabase.from("invitations").select("id").eq("class_id", course.id);
    expect(invitations).toHaveLength(0);
  });
});
