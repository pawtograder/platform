/**
 * #1010: setting a group's mentor, renaming a group and Copy Groups follow manage_groups
 * (20261121200300_groups_by_capability.sql), and group memberships are visible only inside their
 * own class.
 *
 * - Updating assignment_groups (mentor, name) needs manage_groups in the group's class. A refused
 *   update changes 0 rows and returns no error, so each check reads the row back.
 * - copy_groups_from_assignment needs manage_groups and records the caller (an instructor or a
 *   grader) as added_by.
 * - The default instructor role holds manage_groups; the default grader role doesn't.
 * - assignment_groups_members: anyone enrolled in a class reads that class's memberships, and no
 *   other class's.
 *
 * Nothing here reaches GitHub: every assignment has repo_mode "none" and is released next week, so
 * neither copy nor the repo-sync trigger creates or syncs a repository.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { addDays } from "date-fns";
import { test, expect } from "../global-setup";
import {
  supabase,
  createClass,
  createUserInClass,
  createAuthenticatedClient,
  insertAssignment,
  type TestingUser
} from "./TestingUtils";

test.describe("Group changes follow manage_groups (#1010)", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let studentA1: TestingUser;
  let studentA2: TestingUser;
  let instructorB: TestingUser;
  let studentB: TestingUser;
  let unique = 0;

  /** A group assignment with no repositories, released next week. */
  async function newAssignment(class_id: number) {
    unique++;
    return insertAssignment({
      class_id,
      due_date: addDays(new Date(), 14).toISOString(),
      release_date: addDays(new Date(), 7).toISOString(),
      repo_mode: "none",
      group_config: "groups",
      min_group_size: 1,
      max_group_size: 4,
      assignment_slug: `e2e-groups-cap-${Date.now().toString(36)}-${unique}`
    });
  }

  /** A group with the given members, written as the service role. */
  async function newGroup(
    class_id: number,
    assignment_id: number,
    members: TestingUser[],
    added_by: TestingUser,
    mentor?: TestingUser
  ) {
    unique++;
    const name = `e2egrp${Date.now().toString(36)}${unique}`;
    const { data: group, error } = await supabase
      .from("assignment_groups")
      .insert({ class_id, assignment_id, name, mentor_profile_id: mentor?.private_profile_id ?? null })
      .select("id, name")
      .single();
    expect(error).toBeNull();
    if (members.length > 0) {
      const { error: membersError } = await supabase.from("assignment_groups_members").insert(
        members.map((m) => ({
          class_id,
          assignment_id,
          assignment_group_id: group!.id,
          profile_id: m.private_profile_id,
          added_by: added_by.private_profile_id
        }))
      );
      expect(membersError).toBeNull();
    }
    return group!;
  }

  async function group(id: number) {
    const { data, error } = await supabase
      .from("assignment_groups")
      .select("id, name, mentor_profile_id")
      .eq("id", id)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  /** Sets the mentor and renames the group as `user`, then returns the row as it is now. */
  async function mentorAndRename(user: TestingUser, groupId: number, mentor: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const newName = `renamed${Date.now().toString(36)}${++unique}`;
    const { error: mentorError } = await client
      .from("assignment_groups")
      .update({ mentor_profile_id: mentor.private_profile_id })
      .eq("id", groupId);
    expect(mentorError).toBeNull();
    const { error: renameError } = await client.from("assignment_groups").update({ name: newName }).eq("id", groupId);
    expect(renameError).toBeNull();
    return { row: await group(groupId), newName };
  }

  /** Copies `source`'s groups onto a new assignment as `user`. */
  async function copyAs(user: TestingUser, class_id: number, sourceId: number, targetId: number) {
    const client = await createAuthenticatedClient(user);
    return client.rpc("copy_groups_from_assignment", {
      p_class_id: class_id,
      p_source_assignment_id: sourceId,
      p_target_assignment_id: targetId
    });
  }

  async function membersOf(assignment_id: number) {
    const { data, error } = await supabase
      .from("assignment_groups_members")
      .select("profile_id, added_by")
      .eq("assignment_id", assignment_id);
    expect(error).toBeNull();
    return data!;
  }

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Groups By Capability A" });
    classB = await createClass({ name: "E2E Groups By Capability B" });
    instructor = await createUserInClass({ role: "instructor", class_id: classA.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    headTa = await createUserInClass({ role: "grader", class_id: classA.id });
    studentA1 = await createUserInClass({ role: "student", class_id: classA.id });
    studentA2 = await createUserInClass({ role: "student", class_id: classA.id });
    instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });
    studentB = await createUserInClass({ role: "student", class_id: classB.id });

    // A Head TA: a custom role with manage_groups turned on, and nothing else.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classA.id, name: "Group TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_groups" })).error
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

  test("the default instructor role holds manage_groups and the default grader role doesn't", async () => {
    const { data, error } = await supabase
      .from("class_roles")
      .select("default_for, role_capabilities(capability)")
      .eq("class_id", classA.id)
      .in("default_for", ["instructor", "grader"]);
    expect(error).toBeNull();
    const holds = (default_for: string) =>
      data!
        .find((r) => r.default_for === default_for)!
        .role_capabilities.some((rc: { capability: string }) => rc.capability === "manage_groups");
    expect(holds("instructor")).toBe(true);
    expect(holds("grader")).toBe(false);
  });

  test("a Head TA with manage_groups can set the mentor, rename a group and copy groups", async () => {
    const source = await newAssignment(classA.id);
    const sourceGroup = await newGroup(classA.id, source.id, [studentA1, studentA2], instructor);

    const { row, newName } = await mentorAndRename(headTa, sourceGroup.id, plainGrader);
    expect(row.mentor_profile_id).toBe(plainGrader.private_profile_id);
    expect(row.name).toBe(newName);

    const target = await newAssignment(classA.id);
    const { data, error } = await copyAs(headTa, classA.id, source.id, target.id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ groups_processed: 1, members_copied: 2 });

    const { data: copied } = await supabase
      .from("assignment_groups")
      .select("name, mentor_profile_id")
      .eq("assignment_id", target.id);
    expect(copied).toEqual([{ name: newName, mentor_profile_id: plainGrader.private_profile_id }]);
    const members = await membersOf(target.id);
    expect(members.map((m) => m.profile_id).sort()).toEqual(
      [studentA1.private_profile_id, studentA2.private_profile_id].sort()
    );
    // The Head TA (a grader) is recorded as the one who added them.
    expect(members.every((m) => m.added_by === headTa.private_profile_id)).toBe(true);
  });

  test("a default grader is refused each one, and nothing changes", async () => {
    const source = await newAssignment(classA.id);
    const sourceGroup = await newGroup(classA.id, source.id, [studentA1], instructor);

    const { row } = await mentorAndRename(plainGrader, sourceGroup.id, plainGrader);
    expect(row.mentor_profile_id).toBeNull();
    expect(row.name).toBe(sourceGroup.name);

    const target = await newAssignment(classA.id);
    const { error } = await copyAs(plainGrader, classA.id, source.id, target.id);
    expect(error?.code, "copy must be refused with 42501").toBe("42501");
    expect(await membersOf(target.id)).toEqual([]);
  });

  test("manage_groups in one class doesn't reach another class's groups", async () => {
    const sourceB = await newAssignment(classB.id);
    const groupB = await newGroup(classB.id, sourceB.id, [studentB], instructorB);

    const { row } = await mentorAndRename(headTa, groupB.id, headTa);
    expect(row.mentor_profile_id).toBeNull();
    expect(row.name).toBe(groupB.name);

    const targetB = await newAssignment(classB.id);
    const { error } = await copyAs(headTa, classB.id, sourceB.id, targetB.id);
    expect(error?.code, "copy in another class must be refused with 42501").toBe("42501");
    expect(await membersOf(targetB.id)).toEqual([]);
  });

  test("a group can't be moved onto another class's assignment", async () => {
    const assignmentA = await newAssignment(classA.id);
    const assignmentB = await newAssignment(classB.id);
    const groupA = await newGroup(classA.id, assignmentA.id, [studentA1], instructor);

    for (const user of [headTa, instructor]) {
      const client = await createAuthenticatedClient(user);
      const { error } = await client
        .from("assignment_groups")
        .update({ assignment_id: assignmentB.id })
        .eq("id", groupA.id);
      expect(error?.code, "moving a group to another class's assignment must be refused with 42501").toBe("42501");
    }
    const { data } = await supabase.from("assignment_groups").select("assignment_id").eq("id", groupA.id).single();
    expect(data!.assignment_id).toBe(assignmentA.id);
  });

  test("an instructor can still set the mentor, rename a group and copy groups", async () => {
    const source = await newAssignment(classA.id);
    const sourceGroup = await newGroup(classA.id, source.id, [studentA1], instructor);

    const { row, newName } = await mentorAndRename(instructor, sourceGroup.id, headTa);
    expect(row.mentor_profile_id).toBe(headTa.private_profile_id);
    expect(row.name).toBe(newName);

    const target = await newAssignment(classA.id);
    const { data, error } = await copyAs(instructor, classA.id, source.id, target.id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ groups_processed: 1, members_copied: 1 });
    const members = await membersOf(target.id);
    expect(members).toEqual([{ profile_id: studentA1.private_profile_id, added_by: instructor.private_profile_id }]);
  });

  test("group memberships are visible only inside their own class", async () => {
    const assignmentA = await newAssignment(classA.id);
    await newGroup(classA.id, assignmentA.id, [studentA1, studentA2], instructor);

    const visibleTo = async (user: TestingUser) => {
      const client = await createAuthenticatedClient(user);
      const { data, error } = await client
        .from("assignment_groups_members")
        .select("profile_id")
        .eq("assignment_id", assignmentA.id);
      expect(error).toBeNull();
      return data!.map((m) => m.profile_id).sort();
    };
    const both = [studentA1.private_profile_id, studentA2.private_profile_id].sort();

    // Class A: a student sees every group in their class, and so do staff.
    expect(await visibleTo(studentA1)).toEqual(both);
    expect(await visibleTo(plainGrader)).toEqual(both);
    expect(await visibleTo(instructor)).toEqual(both);
    // Class B: neither a student nor an instructor of another class sees them.
    expect(await visibleTo(studentB)).toEqual([]);
    expect(await visibleTo(instructorB)).toEqual([]);
  });
});
