/**
 * Column-name heuristics for the initial privacy classification draft (package 2, HU6).
 *
 * Sources: the column-name patterns listed in the bug reporter spec, and the "PII / grades" section
 * of `docs/operations/data-retention.md`. The rules err toward a PII kind; a rule that had to guess
 * sets `uncertain` so the reviewer sees it. Hand-reviewed decisions live in `privacyOverrides.ts`.
 */
import type { PiiKind } from "../../lib/bugReport/privacyTypes";

export type Classified = { kind: PiiKind; rule: string; uncertain?: string };

/** Relations whose `name`-like columns hold a person's name (or pseudonym). */
export const PERSON_NAME_RELATIONS = new Set([
  "profiles",
  "users",
  "invitations",
  "lti_users",
  "submissions_agg",
  "submissions_with_grades_for_assignment_and_regression_test",
  "submissions_with_grades_for_assignment_nice",
  "flashcard_student_deck_analytics"
]);

const PERSON_NAME_COLUMNS = new Set([
  "name",
  "sortable_name",
  "short_name",
  "real_name",
  "display_name",
  "full_name",
  "first_name",
  "last_name"
]);

/** `*_id` columns that identify a person outside Pawtograder. */
const EXTERNAL_PERSON_IDS = new Set([
  "github_user_id",
  "discord_id",
  "observed_discord_id",
  "sis_user_id",
  "canvas_id",
  "lti_user_sub",
  "lis_person_sourcedid"
]);

/** Columns that hold a student's GitHub repository (the name embeds their GitHub username). */
const STUDENT_REPOSITORY_COLUMNS = new Set(["repository", "repository_name", "pr_repo"]);

/** Free text typed by a user, by column name. */
const FREE_TEXT_COLUMNS = new Set([
  "body",
  "message",
  "comment",
  "note",
  "notes",
  "internal_notes",
  "resolution_notes",
  "request",
  "response",
  "reason",
  "prompt",
  "question",
  "subject",
  "teaser",
  "thread_name",
  "duplicate_original_subject",
  "contents",
  "output",
  "lint_output",
  "hint",
  "activity_description",
  "score_override_note",
  "tweak_note",
  "per_student_tweak_notes",
  "commit_message",
  "groupname",
  "assignment_group_mentor_name"
]);

/** Error and diagnostic text; upstream errors (GitHub, Discord, Canvas) often echo usernames or emails. */
const ERROR_TEXT_COLUMNS = new Set([
  "error",
  "errors",
  "error_message",
  "error_data",
  "creation_error",
  "sync_error",
  "last_reason",
  "detail",
  "last_error_context",
  "validation_errors",
  "last_roster_sync_message",
  "last_sync_message",
  "sync_block_reason"
]);

/** Grade columns named in data-retention.md §"PII / grades" or matching score patterns. */
const GRADE_COLUMNS = new Set([
  "score",
  "score_override",
  "points",
  "autograder_score",
  "rt_autograder_score",
  "whatif_autograder_score",
  "total_autograde_score",
  "total_score",
  "synced_score",
  "individual_scores",
  "per_student_grading_totals",
  "per_student_grading_shared_base",
  "per_student_tweaks",
  "scores_by_round_private",
  "scores_by_round_public",
  "tweak",
  "closed_points",
  "initial_points",
  "resolved_points",
  "karma_score",
  "discussion_karma",
  "is_excused",
  "is_missing",
  "is_droppable",
  "incomplete_values"
]);

/** Score-like names that are assignment or rubric configuration, not a student's grade. */
const GRADE_CONFIG_COLUMNS = new Set([
  "max_score",
  "score_maximum",
  "score_expression",
  "render_expression",
  "autograder_points",
  "total_points",
  "cap_score_to_assignment_points",
  "show_max_score",
  "grade_sync_enabled",
  "final_grade_column"
]);

/** Json columns known to hold only configuration or bookkeeping. */
const CONFIG_JSON_COLUMNS = new Set([
  "features",
  "config",
  "analytics_config",
  "dependencies",
  "file_hashes",
  "last_synced_stats",
  "public_jwk",
  "tags"
]);

export function classifyColumn(relation: string, column: string, typeText: string, isForeignKey: boolean): Classified {
  const isJson = /\bJson\b/.test(typeText);
  if (isForeignKey) return { kind: "none", rule: "foreign key" };

  if (EXTERNAL_PERSON_IDS.has(column)) return { kind: "handle", rule: "external person id" };
  if (column === "id" || /_ids?$/.test(column) || column === "uid") return { kind: "none", rule: "identifier" };

  if (/(^|_)e?mails?$/.test(column) || column === "email" || column === "reply_to") {
    return { kind: "email", rule: "email pattern" };
  }
  if (/(^|_)(username|login)$/.test(column)) return { kind: "handle", rule: "*_username / *_login" };
  if (column === "ip_addr") return { kind: "handle", rule: "IP address" };
  if (column === "avatar_url") return { kind: "handle", rule: "avatar URL (may embed a GitHub id)" };
  if (column === "sub" && relation.startsWith("lti")) return { kind: "handle", rule: "LTI subject" };
  if (STUDENT_REPOSITORY_COLUMNS.has(column)) {
    return { kind: "handle", rule: "student repository name embeds the GitHub username" };
  }

  if (PERSON_NAME_COLUMNS.has(column) && PERSON_NAME_RELATIONS.has(relation)) {
    return { kind: "name", rule: "person name column" };
  }
  if (/(author|student|organizer|mentor|user|creator|instructor)_(display_)?name$/.test(column)) {
    return { kind: "name", rule: "*_name of a person" };
  }
  if (/_display_name$/.test(column) || /(grader|checker)name$/.test(column)) {
    return { kind: "name", rule: "person display name" };
  }
  if (PERSON_NAME_COLUMNS.has(column) && relation.startsWith("rpc:")) {
    return {
      kind: "name",
      rule: "name column in an RPC result",
      uncertain: "`name` in an RPC result; name assumes it is a person, set none if it names course content"
    };
  }
  if (PERSON_NAME_COLUMNS.has(column)) {
    return {
      kind: "none",
      rule: "name of course content",
      uncertain: "`name` on a relation not known to hold people; check that it never holds a person's name"
    };
  }

  // Before the score patterns, so `score_override_note` is text rather than a grade.
  if (FREE_TEXT_COLUMNS.has(column)) return { kind: "free_text", rule: "user-typed text" };

  if (GRADE_CONFIG_COLUMNS.has(column)) return { kind: "none", rule: "grading configuration" };
  if (GRADE_COLUMNS.has(column)) return { kind: "grade", rule: "grade column" };
  if (/(^|_)max(_|$)/.test(column)) return { kind: "none", rule: "maximum (configuration)" };
  if (/_(count|counts|status)$/.test(column)) return { kind: "none", rule: "count or status" };
  if (/(^|_)(score|scores|points|grade|grades)(_|$)/.test(column)) {
    return { kind: "grade", rule: "score*/points pattern", uncertain: "score-like name; grade or configuration?" };
  }

  if (ERROR_TEXT_COLUMNS.has(column)) {
    return {
      kind: "free_text",
      rule: "error text",
      uncertain: "error or sync message; free_text assumes upstream errors can echo usernames or emails"
    };
  }

  if (isJson) {
    if (CONFIG_JSON_COLUMNS.has(column)) return { kind: "none", rule: "configuration json" };
    return {
      kind: "free_text",
      rule: "json blob",
      uncertain: "Json column with no known shape; free_text taints every string inside it"
    };
  }

  return { kind: "none", rule: "no PII pattern" };
}
