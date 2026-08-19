/**
 * Client-side validation for assignment group names.
 *
 * A group name is not just a label: it becomes the trailing component of the team's GitHub
 * repository name (`<class>-<assignment>-group-<name>`), which is sanitized down to the characters
 * GitHub allows. Two kinds of name break repository creation, so both are rejected here as well as
 * in the edge functions and the database:
 *
 * - a name with no letter or number (`---`, `_`) sanitizes to an empty component; and
 * - two names that differ only in separators (`Team-One` and `Team--One`) sanitize to the same
 *   component and collide on the repository name.
 *
 * Only the first is checkable without knowing the other groups, so that is all this covers; the
 * collision check needs the assignment's other names and lives server-side.
 */
export function isValidGroupName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,36}$/.test(name) && /[a-zA-Z0-9]/.test(name);
}
