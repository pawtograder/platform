/**
 * #1010: renaming a class section follows manage_roster
 * (20261122210400_class_sections_rename_by_capability.sql). update_class_section_name() used to
 * check for an instructor; it now checks manage_roster in the section's class.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { test, expect } from "../global-setup";
import {
  supabase,
  createClass,
  createClassSection,
  createUserInClass,
  createAuthenticatedClient,
  type TestingUser
} from "./TestingUtils";

test.describe("Renaming class sections follows manage_roster (#1010)", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let unique = 0;

  async function sectionName(id: number) {
    const { data, error } = await supabase.from("class_sections").select("name").eq("id", id).single();
    expect(error).toBeNull();
    return data!.name;
  }

  /** Renames a fresh section of `class_id` as `user`; returns the RPC's error and the name now. */
  async function renameAs(user: TestingUser, class_id: number) {
    const section = await createClassSection({ class_id });
    const client = await createAuthenticatedClient(user);
    const newName = `E2E renamed ${Date.now().toString(36)}-${++unique}`;
    const { error } = await client.rpc("update_class_section_name", {
      p_class_section_id: section.id,
      p_name: newName
    });
    return { error, renamed: (await sectionName(section.id)) === newName };
  }

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Class Sections By Capability A" });
    classB = await createClass({ name: "E2E Class Sections By Capability B" });
    instructor = await createUserInClass({ role: "instructor", class_id: classA.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    headTa = await createUserInClass({ role: "grader", class_id: classA.id });
    await createUserInClass({ role: "instructor", class_id: classB.id });

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

  test("a Head TA with manage_roster can rename a class section", async () => {
    const { error, renamed } = await renameAs(headTa, classA.id);
    expect(error).toBeNull();
    expect(renamed).toBe(true);
  });

  test("a default grader can't rename a class section", async () => {
    const { error, renamed } = await renameAs(plainGrader, classA.id);
    expect(error?.message).toContain("manage_roster");
    expect(renamed).toBe(false);
  });

  test("manage_roster in one class doesn't reach another class", async () => {
    const { error, renamed } = await renameAs(headTa, classB.id);
    expect(error?.message).toContain("manage_roster");
    expect(renamed).toBe(false);
  });

  test("an instructor still renames class sections", async () => {
    const { error, renamed } = await renameAs(instructor, classA.id);
    expect(error).toBeNull();
    expect(renamed).toBe(true);
  });
});
