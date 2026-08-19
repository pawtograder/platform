import type { Assignment } from "@/utils/supabase/DatabaseTypes";

/**
 * Client-side validation for assignment group names.
 *
 * Two separate rules apply, and they have different scopes:
 *
 * - The character set and 36-character limit are about the label itself, so they always apply.
 *   These live only in the app layer; the database deliberately does not enforce them, because
 *   names with spaces are ordinary for callers such as the CSV import and copy_groups_from_assignment.
 * - The requirement that a name hold at least one letter or number exists only to protect the
 *   team's GitHub repository name (`<class>-<assignment>-group-<name>`), whose trailing component
 *   is sanitized to the characters GitHub allows. A name of only separators sanitizes to nothing.
 *   Assignments that never provision a repository are therefore exempt, matching
 *   validate_assignment_group_name() in the database — on a paper assignment, `---` is a fine
 *   name for a group.
 *
 * A third rule, that a name must not sanitize to the same value as another group's on the same
 * assignment, is not checkable here: it needs the assignment's other names. It lives in the edge
 * functions and the database trigger, under the same repo_mode exemption.
 */
export function assignmentProvisionsRepositories(repoMode: Assignment["repo_mode"]): boolean {
  return repoMode !== "none" && repoMode !== "no_submission";
}

function isValidGroupNameFormat(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,36}$/.test(name);
}

export function isValidGroupName(name: string, repoMode: Assignment["repo_mode"]): boolean {
  if (!isValidGroupNameFormat(name)) {
    return false;
  }
  return !assignmentProvisionsRepositories(repoMode) || /[a-zA-Z0-9]/.test(name);
}

/**
 * The requirements sentence shown as helper and error text. Built here so the two group-creation
 * dialogs cannot drift from each other, or promise a rule that is not enforced on this assignment.
 */
export function groupNameRequirementsText(repoMode: Assignment["repo_mode"]): string {
  return assignmentProvisionsRepositories(repoMode)
    ? "The name must consist only of letters, numbers, hyphens, or underscores, contain at least one letter or number, and be 36 characters or fewer."
    : "The name must consist only of letters, numbers, hyphens, or underscores, and be 36 characters or fewer.";
}
