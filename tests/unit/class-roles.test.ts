import {
  capabilityLabel,
  deleteRoleDialogCopy,
  editableRoles,
  ROLE_CHANGE_REFUSED_MESSAGE,
  ROLE_NAME_MAX_LENGTH,
  roleChangeErrorMessage,
  roleDisplayName,
  roleNameProblem
} from "@/lib/classRoles";

const instructor = { id: 1, name: "instructor", default_for: "instructor" };
const grader = { id: 2, name: "grader", default_for: "grader" };
const student = { id: 3, name: "student", default_for: "student" };
const admin = { id: 4, name: "admin", default_for: "admin" };
const headTa = { id: 5, name: "Head TA", default_for: null };
const coordinator = { id: 6, name: "coordinator", default_for: null };
const all = [coordinator, admin, headTa, student, instructor, grader];

describe("Staff Roles page helpers", () => {
  test("a capability name reads as a sentence-case label", () => {
    expect(capabilityLabel("manage_review_assignments")).toBe("Manage review assignments");
    expect(capabilityLabel("publish_groups")).toBe("Publish groups");
  });

  test("the default grader role is shown as Grader, and a custom role keeps its name", () => {
    expect(roleDisplayName(grader)).toBe("Grader");
    expect(roleDisplayName(headTa)).toBe("Head TA");
  });

  test("only the grader role and custom roles can be edited, grader first, then by name ignoring case", () => {
    expect(editableRoles(all).map((role) => role.name)).toEqual(["grader", "coordinator", "Head TA"]);
  });

  test("editableRoles leaves the list it was given in the same order", () => {
    const before = all.map((role) => role.id);
    editableRoles(all);
    expect(all.map((role) => role.id)).toEqual(before);
  });

  test("a blank name is refused", () => {
    expect(roleNameProblem("   ", all)).toBe("Enter a name for the role.");
  });

  test("a name over the limit is refused, and one at the limit is accepted", () => {
    expect(roleNameProblem("a".repeat(ROLE_NAME_MAX_LENGTH + 1), all)).toMatch(/characters or fewer/);
    expect(roleNameProblem("a".repeat(ROLE_NAME_MAX_LENGTH), all)).toBeUndefined();
  });

  test("a name that matches any role in the class ignoring case is refused, default roles included", () => {
    expect(roleNameProblem("head ta", all)).toBe('This class already has a role named "head ta".');
    expect(roleNameProblem(" Instructor ", all)).toBe('This class already has a role named "Instructor".');
  });

  test("renaming a role to its own name with different capitals is allowed", () => {
    expect(roleNameProblem("HEAD TA", all, headTa.id)).toBeUndefined();
    expect(roleNameProblem("coordinator", all, headTa.id)).toMatch(/already has a role/);
  });

  test("database error codes become sentences an instructor can act on", () => {
    expect(roleChangeErrorMessage({ code: "23505" })).toMatch(/already has a role with that name/);
    expect(roleChangeErrorMessage({ code: "23503" })).toMatch(/Move them to another role first/);
    expect(roleChangeErrorMessage({ code: "42501" })).toMatch(/don't have permission/);
    expect(roleChangeErrorMessage({ code: "XX000", message: "boom" })).toBe("The change wasn't saved: boom");
    expect(roleChangeErrorMessage(null)).toMatch(/Check your connection/);
    expect(ROLE_CHANGE_REFUSED_MESSAGE).toMatch(/wasn't saved/);
  });

  test("the delete dialog blocks on active people, then on removed graders only, else allows delete", () => {
    expect(deleteRoleDialogCopy({ active: 1, disabled: 0 })).toEqual({
      blocked: true,
      description: "1 person is on this role. Move them to another role under People first, then delete it."
    });
    expect(deleteRoleDialogCopy({ active: 0, disabled: 1 })).toEqual({
      blocked: true,
      description:
        "1 removed grader is still on this role. Re-enable them under Enrollments and move them to another role, then delete it."
    });
    expect(deleteRoleDialogCopy({ active: 0, disabled: 2 }).description).toMatch(/2 removed graders/);
    expect(deleteRoleDialogCopy({ active: 2, disabled: 3 }).description).toMatch(/2 people are/);
    expect(deleteRoleDialogCopy({ active: 0, disabled: 0 })).toEqual({
      blocked: false,
      description: "Nobody is on this role. Deleting it can't be undone."
    });
  });
});
