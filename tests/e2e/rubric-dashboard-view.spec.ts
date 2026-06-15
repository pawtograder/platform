import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createAuthenticatedClient, createClass, createUserInClass, insertAssignment } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

/**
 * E2E coverage for the shared per-assignment dashboard view (assignment_dashboard_views):
 * instructors save the shared default; staff (graders) can read but not write; the trigger
 * validates the config (viz enum + injection-safe filter validation).
 */
test.describe("assignment_dashboard_views (shared report view)", () => {
  let assignmentId: number;
  let instructor: TestingUser;
  let instructorClient: SupabaseClient<Database>;
  let graderClient: SupabaseClient<Database>;

  // class_id is filled by a BEFORE INSERT trigger from assignment_id, so it's
  // omitted here; the generated Insert type requires it (NOT NULL, no default)
  // and can't model the trigger, so cast the trigger-filled row to the Insert type.
  const dvRow = (config: unknown) =>
    ({
      assignment_id: assignmentId,
      config
    }) as unknown as Database["public"]["Tables"]["assignment_dashboard_views"]["Insert"];

  test.beforeAll(async () => {
    const cls = await createClass({ name: "Dashboard View E2E" });
    instructor = await createUserInClass({ role: "instructor", class_id: cls.id });
    const grader = await createUserInClass({ role: "grader", class_id: cls.id });
    const assignment = await insertAssignment({
      class_id: cls.id,
      due_date: addDays(new Date(), -1).toISOString(),
      release_date: addDays(new Date(), -7).toISOString(),
      group_config: "individual"
    });
    assignmentId = assignment.id;
    instructorClient = await createAuthenticatedClient(instructor);
    graderClient = await createAuthenticatedClient(grader);
  });

  test("instructor saves a shared default view and reads it back", async () => {
    const config = { viz: "options", filter: { op: "and", args: [{ scoreAtLeast: 50 }] } };
    const { error: saveErr } = await instructorClient
      .from("assignment_dashboard_views")
      .upsert(dvRow(config), { onConflict: "assignment_id" });
    expect(saveErr).toBeNull();

    const { data, error } = await instructorClient
      .from("assignment_dashboard_views")
      .select("config, class_id, updated_by")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.config).toEqual(config);
    // Trigger fills class_id and stamps the saving instructor's profile.
    expect(data?.class_id).toBe(instructor.class_id);
    expect(data?.updated_by).toBe(instructor.private_profile_id);
  });

  test("a grader can read the shared view but cannot write it", async () => {
    // Self-contained: ensure a shared view exists regardless of test ordering.
    const { error: seedErr } = await instructorClient
      .from("assignment_dashboard_views")
      .upsert(dvRow({ viz: "bars" }), { onConflict: "assignment_id" });
    expect(seedErr).toBeNull();

    const { data, error } = await graderClient
      .from("assignment_dashboard_views")
      .select("config")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.config).toBeTruthy();

    const { error: writeErr } = await graderClient
      .from("assignment_dashboard_views")
      .upsert(dvRow({ viz: "bars" }), { onConflict: "assignment_id" });
    expect(writeErr).not.toBeNull();
  });

  test("the trigger rejects an invalid viz", async () => {
    const { error } = await instructorClient
      .from("assignment_dashboard_views")
      .upsert(dvRow({ viz: "nope" }), { onConflict: "assignment_id" });
    expect(error).not.toBeNull();
  });

  test("the trigger rejects a filter outside the closed predicate set", async () => {
    const { error } = await instructorClient
      .from("assignment_dashboard_views")
      .upsert(dvRow({ viz: "bars", filter: { bogusPredicate: 1 } }), { onConflict: "assignment_id" });
    expect(error).not.toBeNull();
  });
});
