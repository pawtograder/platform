/**
 * Helpers for the Staff Roles page (Course Settings). The rules themselves live in the database
 * (docs/capabilities.md); these only shape what the page shows and says.
 */

export const ROLE_NAME_MAX_LENGTH = 60;

/** Only instructors hold it, and it never goes on a grader or custom role. */
export const INSTRUCTOR_ONLY_CAPABILITY = "manage_roles";

export type ClassRoleSummary = {
  id: number;
  name: string;
  default_for: string | null;
};

/** "manage_review_assignments" becomes "Manage review assignments". */
export function capabilityLabel(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the page calls a role: the default grader role is "Grader", custom roles keep their name. */
export function roleDisplayName(role: ClassRoleSummary): string {
  return role.default_for === "grader" ? "Grader" : role.name;
}

/** The roles an instructor can edit: the default grader role first, then custom roles by name. */
export function editableRoles<T extends ClassRoleSummary>(roles: T[]): T[] {
  return roles
    .filter((role) => role.default_for === "grader" || role.default_for === null)
    .sort((a, b) => {
      if (a.default_for === "grader") return -1;
      if (b.default_for === "grader") return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

/**
 * Why a role name can't be saved, or undefined when it can. Mirrors the database: names can't be
 * blank and are unique per class ignoring case, default roles included.
 */
export function roleNameProblem(
  name: string,
  existing: ClassRoleSummary[],
  renamingRoleId?: number
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return "Enter a name for the role.";
  }
  if (trimmed.length > ROLE_NAME_MAX_LENGTH) {
    return `Use ${ROLE_NAME_MAX_LENGTH} characters or fewer.`;
  }
  const taken = existing.some(
    (role) => role.id !== renamingRoleId && role.name.trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (taken) {
    return `This class already has a role named "${trimmed}".`;
  }
  return undefined;
}

/** A sentence for a refused or failed role change, from the Postgres error code. */
export function roleChangeErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  switch (error?.code) {
    case "23505":
      return "This class already has a role with that name.";
    case "23503":
      return "People are still on this role. Move them to another role first.";
    case "23514":
      return "That role name isn't allowed.";
    case "42501":
      return "You don't have permission to change roles in this class. Ask an instructor.";
    default:
      return error?.message
        ? `The change wasn't saved: ${error.message}`
        : "The change wasn't saved. Check your connection and try again.";
  }
}

/** The message for a write the database accepted but applied to no rows (refused by a policy). */
export const ROLE_CHANGE_REFUSED_MESSAGE =
  "The change wasn't saved. You may no longer have permission to change roles in this class.";
