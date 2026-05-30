/**
 * GitHub repo-name helpers.
 *
 * GitHub repository names may only contain ASCII letters, digits, `.`, `-`, and
 * `_`; any other character (most commonly a space, from a student-chosen group
 * name like "Group 1" or "Team Awesome") is silently replaced by GitHub on
 * creation, which makes the name we store in `repositories.repository` diverge
 * from the actual repo — or fails creation outright. Always run any
 * user-influenced component (group names especially) through this before
 * building a repo name, at BOTH the DB-insert and the GitHub-create sites so
 * they agree.
 */
export function sanitizeRepoNameComponent(raw: string): string {
  const sanitized = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-") // spaces & other illegal chars → hyphen
    .replace(/-{2,}/g, "-") // collapse runs
    .replace(/^[-_.]+|[-_.]+$/g, ""); // trim leading/trailing separators
  // An input made up entirely of illegal characters (e.g. "   " or "@#$") would
  // collapse to "", and GitHub rejects empty repo-name components. Fail loudly
  // here rather than letting an unusable name reach the DB/GitHub-create sites.
  if (!sanitized) {
    throw new Error(`sanitizeRepoNameComponent: input "${raw}" produced an empty repo-name component`);
  }
  return sanitized;
}
