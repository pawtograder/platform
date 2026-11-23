/**
 * #1010: creating, changing and deleting lab sections, their meetings and their leaders follow
 * manage_roster (20261122210300_roster_by_capability.sql).
 *
 * - The default instructor role holds manage_roster; the default grader role doesn't.
 * - A refused update or delete changes 0 rows and returns no error, so those checks read the row
 *   back. A refused insert fails with 42501.
 * - A meeting's lab section and a leader's profile must be in the row's class, for everyone.
 * - Only an instructor can set or change a lab section's sis_crn, because SIS sync enrolls that
 *   SIS section's roster with their SIS roles (instructors and TAs included).
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { test, expect } from "../global-setup";
import { supabase, createClass, createUserInClass, createAuthenticatedClient, type TestingUser } from "./TestingUtils";

type Result = { error: { code?: string; message?: string } | null };

function expectRefused({ error }: Result, what: string) {
  expect(error?.code, `${what} must be refused with 42501`).toBe("42501");
}

test.describe("Lab sections follow manage_roster (#1010)", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let graderB: TestingUser;
  let unique = 0;

  const sectionValues = (class_id: number) => ({
    class_id,
    name: `E2E lab ${Date.now().toString(36)}-${++unique}`,
    day_of_week: "monday" as const,
    start_time: "10:00",
    end_time: "11:00"
  });

  /** A lab section written as the service role. */
  async function serviceSection(class_id: number) {
    const { data, error } = await supabase.from("lab_sections").insert(sectionValues(class_id)).select("id").single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function sectionName(id: number) {
    const { data, error } = await supabase.from("lab_sections").select("name").eq("id", id).maybeSingle();
    expect(error).toBeNull();
    return data?.name ?? null;
  }

  /** Every lab section action as `user`, against a fresh section in `class_id`. */
  async function manageAs(user: TestingUser, class_id: number, leader: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const sectionId = await serviceSection(class_id);
    const created = await client.from("lab_sections").insert(sectionValues(class_id)).select("id");
    const renamed = `renamed ${++unique}`;
    await client.from("lab_sections").update({ name: renamed }).eq("id", sectionId);
    const leaderInsert = await client
      .from("lab_section_leaders")
      .insert({ lab_section_id: sectionId, profile_id: leader.private_profile_id, class_id });
    const meetingInsert = await client
      .from("lab_section_meetings")
      .insert({ lab_section_id: sectionId, class_id, meeting_date: "2031-01-06" });
    return {
      client,
      sectionId,
      created,
      renamed: (await sectionName(sectionId)) === renamed,
      leaderInsert,
      meetingInsert
    };
  }

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Lab Sections By Capability A" });
    classB = await createClass({ name: "E2E Lab Sections By Capability B" });
    instructor = await createUserInClass({ role: "instructor", class_id: classA.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    headTa = await createUserInClass({ role: "grader", class_id: classA.id });
    graderB = await createUserInClass({ role: "grader", class_id: classB.id });

    // A Head TA: a custom role with manage_roster turned on, and nothing else.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classA.id, name: "Roster TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_roster" })).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", headTa.user_id)
          .eq("class_id", classA.id)
      ).error
    ).toBeNull();
  });

  test("the default instructor role holds manage_roster and the default grader role doesn't", async () => {
    const { data, error } = await supabase
      .from("class_roles")
      .select("default_for, role_capabilities(capability)")
      .eq("class_id", classA.id)
      .in("default_for", ["instructor", "grader"]);
    expect(error).toBeNull();
    const holds = (default_for: string) =>
      data!
        .find((r) => r.default_for === default_for)!
        .role_capabilities.some((rc: { capability: string }) => rc.capability === "manage_roster");
    expect(holds("instructor")).toBe(true);
    expect(holds("grader")).toBe(false);
  });

  test("a Head TA with manage_roster can create, change and delete lab sections, leaders and meetings", async () => {
    const r = await manageAs(headTa, classA.id, plainGrader);
    expect(r.created.error).toBeNull();
    expect(r.created.data).toHaveLength(1);
    expect(r.renamed).toBe(true);
    expect(r.leaderInsert.error).toBeNull();
    expect(r.meetingInsert.error).toBeNull();

    const meetingUpdate = await r.client
      .from("lab_section_meetings")
      .update({ cancelled: true })
      .eq("lab_section_id", r.sectionId)
      .eq("meeting_date", "2031-01-06")
      .select("id");
    expect(meetingUpdate.error).toBeNull();
    expect(meetingUpdate.data).toHaveLength(1);

    const leaderDelete = await r.client.from("lab_section_leaders").delete().eq("lab_section_id", r.sectionId).select();
    expect(leaderDelete.error).toBeNull();
    expect(leaderDelete.data).toHaveLength(1);

    const sectionDelete = await r.client.from("lab_sections").delete().eq("id", r.created.data![0].id).select();
    expect(sectionDelete.error).toBeNull();
    expect(sectionDelete.data).toHaveLength(1);
  });

  test("only an instructor can set or change a lab section's sis_crn", async () => {
    const headTaClient = await createAuthenticatedClient(headTa);
    const instructorClient = await createAuthenticatedClient(instructor);
    const crn = 90000 + Math.floor(Math.random() * 9000);

    // A Head TA can't create a lab section linked to an SIS section.
    expectRefused(
      await headTaClient.from("lab_sections").insert({ ...sectionValues(classA.id), sis_crn: crn }),
      "creating a lab section with a sis_crn"
    );

    // Nor link an existing one, or change or clear its link.
    const sectionId = await serviceSection(classA.id);
    expectRefused(
      await headTaClient.from("lab_sections").update({ sis_crn: crn }).eq("id", sectionId),
      "setting a lab section's sis_crn"
    );
    expect((await supabase.from("lab_sections").update({ sis_crn: crn }).eq("id", sectionId)).error).toBeNull();
    expectRefused(
      await headTaClient
        .from("lab_sections")
        .update({ sis_crn: crn + 1 })
        .eq("id", sectionId),
      "changing a lab section's sis_crn"
    );
    expectRefused(
      await headTaClient.from("lab_sections").update({ sis_crn: null }).eq("id", sectionId),
      "clearing a lab section's sis_crn"
    );

    // Editing a linked section while sending its sis_crn back unchanged works, as the page does.
    const renamed = `kept crn ${++unique}`;
    const keep = await headTaClient
      .from("lab_sections")
      .update({ name: renamed, sis_crn: crn })
      .eq("id", sectionId)
      .select("id");
    expect(keep.error).toBeNull();
    expect(keep.data).toHaveLength(1);
    const { data: after } = await supabase.from("lab_sections").select("name, sis_crn").eq("id", sectionId).single();
    expect(after).toEqual({ name: renamed, sis_crn: crn });

    // An instructor still can.
    const byInstructor = await instructorClient
      .from("lab_sections")
      .update({ sis_crn: crn + 2 })
      .eq("id", sectionId)
      .select("sis_crn");
    expect(byInstructor.error).toBeNull();
    expect(byInstructor.data).toEqual([{ sis_crn: crn + 2 }]);
  });

  test("a default grader is refused every lab section change", async () => {
    const r = await manageAs(plainGrader, classA.id, headTa);
    expectRefused(r.created, "creating a lab section");
    expect(r.renamed).toBe(false);
    expectRefused(r.leaderInsert, "adding a leader");
    expectRefused(r.meetingInsert, "adding a meeting");

    const sectionDelete = await r.client.from("lab_sections").delete().eq("id", r.sectionId).select();
    expect(sectionDelete.data ?? []).toHaveLength(0);
    expect(await sectionName(r.sectionId)).not.toBeNull();
  });

  test("manage_roster in one class doesn't reach another class", async () => {
    const r = await manageAs(headTa, classB.id, graderB);
    expectRefused(r.created, "creating a lab section in another class");
    expect(r.renamed).toBe(false);
    // sync_lab_section_leaders_class_id can't see another class's lab section, so it raises P0001
    // before RLS answers. Either way the leader is refused and nothing is written.
    expect(r.leaderInsert.error, "adding a leader in another class must be refused").not.toBeNull();
    const { data: leaders } = await supabase.from("lab_section_leaders").select("id").eq("lab_section_id", r.sectionId);
    expect(leaders).toHaveLength(0);
    expectRefused(r.meetingInsert, "adding a meeting in another class");
  });

  test("a meeting's lab section and a leader's profile must be in the same class, even for an instructor", async () => {
    const client = await createAuthenticatedClient(instructor);
    const sectionA = await serviceSection(classA.id);
    const sectionB = await serviceSection(classB.id);

    expectRefused(
      await client
        .from("lab_section_meetings")
        .insert({ lab_section_id: sectionB, class_id: classA.id, meeting_date: "2031-01-13" }),
      "a meeting on another class's lab section"
    );
    expectRefused(
      await client
        .from("lab_section_leaders")
        .insert({ lab_section_id: sectionA, profile_id: graderB.private_profile_id, class_id: classA.id }),
      "a leader from another class"
    );
  });

  test("instructors work as before", async () => {
    const r = await manageAs(instructor, classA.id, headTa);
    expect(r.created.error).toBeNull();
    expect(r.renamed).toBe(true);
    expect(r.leaderInsert.error).toBeNull();
    expect(r.meetingInsert.error).toBeNull();
    const sectionDelete = await r.client.from("lab_sections").delete().eq("id", r.sectionId).select();
    expect(sectionDelete.data).toHaveLength(1);
  });
});
