/**
 * Hand-reviewed decisions for the privacy classification draft, applied before the heuristics in
 * `columnHeuristics.ts`. They only affect keys that `lib/bugReport/privacy.ts` does not have yet
 * (or every key, with `--fresh`); once an entry exists there, edit it there.
 *
 * - COLUMN_OVERRIDES: columns the heuristics get wrong or cannot decide.
 * - RPC_OVERRIDES: return shapes read from each function's SQL (`rpcReturnReview.json`, one entry per
 *   function returning Json, text, or a record; the rest are classified from their generated type).
 * - EDGE_FUNCTION_OVERRIDES: response shapes from the wrapper return types in `lib/edgeFunctions.ts`,
 *   `supabase/functions/_shared/FunctionTypes.d.ts`, and the functions' own return statements.
 */
import type { JsonPathMap, PiiKind, RpcClassification } from "../../lib/bugReport/privacyTypes";
import rpcReturnReview from "./rpcReturnReview.json";

export type Override = { kind: RpcClassification; uncertain?: string; note?: string };
export type ColumnOverride = { kind: PiiKind; uncertain?: string; note?: string };

const n = (kind: PiiKind, uncertain?: string): ColumnOverride => ({ kind, uncertain });

const COURSE_CONTENT = "course content named by staff";
const EXTENSION = "extension or late-token use can reveal an accommodation; grade blocks it rather than matching it";

export const COLUMN_OVERRIDES: Record<string, ColumnOverride> = {
  // Git author names from commit metadata (github-repo-webhook stores commit.author.name).
  "assignment_handout_commits.author": n("name"),
  "autograder_commits.author": n("name"),
  // GitHub activity by students in their repositories.
  "repository_analytics_items.author": n("handle"),
  "repository_analytics_items.title": n("free_text"),
  "workflow_events.head_branch": n("free_text", "branch names are chosen by the student and can contain their name"),
  "workflow_runs.head_branch": n("free_text", "branch names are chosen by the student and can contain their name"),
  // GitHub usernames exempt from permission sync.
  "github_orgs.permission_sync_exempt_users": n("handle"),

  // Names chosen by students or applied to students.
  "assignment_groups.name": n("free_text", "group names are chosen by students and can contain their names"),
  "tags.name": n("free_text", "staff tags applied to students can be sensitive (e.g. 'at risk')"),
  "api_tokens.name": n("free_text"),
  "submission_files.name": n("free_text", "file names in a submission are chosen by the student"),
  "workflow_run_error.name": n("free_text", "error titles may interpolate usernames or repository names"),
  "submission_artifacts.name": n("none", "artifact names come from the grader config, not the student"),

  // Calendar events come from staff calendars and often name the TA ("OH - Jane").
  "calendar_events.title": n("free_text", "calendar titles often name a staff member"),
  "calendar_events.description": n("free_text", "calendar descriptions often name a staff member"),
  "calendar_events.location": n("free_text", "locations can be a personal meeting link or office"),

  // Section names can carry the section leader's name.
  "class_sections.name": n("none", "section names from SIS are codes, but hand-made ones can name the leader"),
  "lab_sections.name": n("none", "lab section names can name the TA who leads them"),

  // Course content named by staff.
  "classes.name": n("none"),
  "gradebook_columns.name": n("none"),
  "gradebooks.name": n("none"),
  "rubrics.name": n("none"),
  "rubric_parts.name": n("none"),
  "rubric_criteria.name": n("none"),
  "rubric_checks.name": n("none"),
  "rubric_checks.points": n("none"),
  "rubric_parts.data": n("none"),
  "rubric_criteria.data": n("none"),
  "rubric_checks.data": n("none"),
  "help_queues.name": n("none"),
  "help_request_templates.name": n("none"),
  "flashcard_decks.name": n("none"),
  "flashcards.prompt": n("none", COURSE_CONTENT),
  "live_polls.question": n("none", COURSE_CONTENT),
  "survey_series.name": n("none"),
  "surveys.json": n("none"),
  "surveys.validation_errors": n("none"),
  "survey_templates.template": n("none"),
  "lti_deployments.name": n("none"),
  "lti_platforms.name": n("none"),
  "grader_result_tests.name": n("none"),
  "submission_reviews.name": n("none"),
  "autograder_regression_test_by_grader.name": n(
    "none",
    "regression-test name; check it is not the student's repository name"
  ),
  "pr_base_tree_cache.files": n("none", "upstream base files are the instructor's handout code"),

  // Not PII by name pattern.
  "live_polls.require_login": n("none"),
  "profiles.flair": n("none"),
  "users.preferences": n("free_text", "UI preferences json; free_text is a precaution"),
  "class_staff_settings.setting_value": n("free_text", "staff settings can hold private calendar URLs"),
  "lti_tool_keys.private_key_pem_encrypted": n("free_text", "a secret, not PII; free_text keeps it out of a replay"),

  // Columns of `RETURNS TABLE(...)` RPC results, key "rpc:<function>.<column>".
  "rpc:admin_get_classes.name": n("none"),
  "rpc:admin_get_org_courses.name": n("none"),
  "rpc:admin_lookup_user_by_email.name": n("name"),
  "rpc:get_discord_membership_status_for_class.name": n("name"),
  "rpc:get_discord_membership_status_for_class.sortable_name": n("name"),
  "rpc:get_discussion_engagement.name": n("name"),
  "rpc:get_grading_progress_for_assignment.name": n("name"),
  "rpc:metrics_workflow_errors_by_name.name": n("free_text", "workflow error names may interpolate usernames"),

  // Extensions and late tokens.
  "assignment_due_date_exceptions.hours": n("grade", EXTENSION),
  "assignment_due_date_exceptions.minutes": n("grade", EXTENSION),
  "assignment_due_date_exceptions.tokens_consumed": n("grade", EXTENSION),
  "student_deadline_extensions.hours": n("grade", EXTENSION),
  "submissions_with_grades_for_assignment_nice.hours": n("grade", EXTENSION),
  "submissions_with_grades_for_assignment_nice.tokens_consumed": n("grade", EXTENSION)
};

export const RPC_OVERRIDES: Record<string, Override> = {
  ...Object.fromEntries(
    Object.entries(
      rpcReturnReview as Record<string, { kind: RpcClassification; uncertain?: string | null; note?: string }>
    ).map(([name, r]) => [name, { kind: r.kind, uncertain: r.uncertain ?? undefined, note: r.note }])
  ),
  // Typed `string` / `string[]` / records in the generated types, but not text in SQL.
  _grade_targets_for_submission: { kind: "none", note: "uuid[] of profile ids" },
  calculate_effective_due_date: { kind: "none", note: "timestamptz" },
  calculate_final_due_date: { kind: "none", note: "timestamptz" },
  pg_buffercache_pages: { kind: "none", note: "pg_buffercache extension statistics" },
  pg_buffercache_summary: { kind: "none", note: "pg_buffercache extension statistics" },
  pg_buffercache_usage_counts: { kind: "none", note: "pg_buffercache extension statistics" }
};

/**
 * Every edge function answers errors as `{ error: { recoverable, message, details } }` (see
 * `wrapRequestHandler` in `_shared/HandlerUtils.ts`); `UserVisibleError` details are often built from
 * usernames, emails, or repository names, so `$.error` is free_text for all of them.
 */
function withErrors(map: JsonPathMap): JsonPathMap {
  return { $: "none", ...map, "$.error": "free_text" };
}

const GITHUB_LINK_STATUS = {
  "$.status.email": "email",
  "$.status.githubUsername": "handle",
  "$.status.githubUserId": "handle",
  "$.status.currentGithubUsername": "handle",
  "$.status.orgMembership.error": "free_text",
  "$.status.teamMembership.error": "free_text"
} as const;

const MESSAGE = { "$.message": "free_text" } as const;

export const EDGE_FUNCTION_OVERRIDES: Record<string, Override> = {
  assignmentCreateHandoutRepo: { kind: withErrors({}) },
  assignmentCreateSolutionRepo: { kind: withErrors({}) },
  assignmentDelete: { kind: withErrors(MESSAGE) },
  assignmentGroupApproveRequest: { kind: withErrors(MESSAGE) },
  assignmentGroupCreate: { kind: withErrors(MESSAGE) },
  assignmentGroupInstructorCreateGroup: { kind: withErrors(MESSAGE) },
  assignmentGroupInstructorMoveStudent: { kind: withErrors({}) },
  assignmentGroupJoin: { kind: withErrors(MESSAGE) },
  assignmentGroupLeave: { kind: withErrors(MESSAGE) },
  assignmentSyncAutograderWorkflow: { kind: withErrors({}) },
  autograderCreateAssignmentRepos: { kind: withErrors(MESSAGE) },
  // The function returns { is_ok, message }; message appends per-repo error text.
  autograderCreateRepoForStudentDemo: { kind: withErrors(MESSAGE) },
  autograderCreateReposForStudent: { kind: withErrors(MESSAGE) },
  autograderSyncAllPermissionsForStudent: { kind: withErrors(MESSAGE) },
  autograderSyncStaffTeam: { kind: withErrors({}) },
  checkAppInstallation: { kind: withErrors({}) },
  checkDiscordBotInstallation: { kind: withErrors({}) },
  cliInvoke: {
    kind: withErrors({ "$.data": "free_text" }),
    uncertain: "cli `data` is whatever the command returns; free_text taints every string in it"
  },
  confirmPrLink: { kind: withErrors({}) },
  courseImportSis: {
    kind: withErrors({
      "$.sections[*].instructors[*].name": "name",
      "$.sections[*].instructors[*].sis_user_id": "handle",
      "$.sections[*].tas[*].name": "name",
      "$.sections[*].tas[*].sis_user_id": "handle",
      "$.sections[*].students[*].name": "name",
      "$.sections[*].students[*].sis_user_id": "handle"
    })
  },
  diagnoseInstructorGitHubAccount: { kind: withErrors(GITHUB_LINK_STATUS) },
  enrollmentAdd: { kind: withErrors({}) },
  enrollmentSyncCanvas: { kind: withErrors(MESSAGE) },
  getPrBaseFiles: {
    kind: withErrors({ "$.files": "none" }),
    uncertain: "upstream base files are the instructor's handout code, not the student's; none assumes that"
  },
  githubRepoConfigureWebhook: { kind: withErrors(MESSAGE) },
  indexSubmission: { kind: withErrors({}) },
  invitationCreate: {
    kind: withErrors({
      "$.invitations[*].email": "email",
      "$.invitations[*].name": "name",
      "$.invitations[*].sis_user_id": "handle",
      "$.errors[*].sis_user_id": "handle",
      "$.errors[*].error": "free_text"
    })
  },
  listDiscordGuilds: { kind: withErrors({}) },
  listGitHubOrgs: { kind: withErrors({}) },
  liveMeetingEnd: { kind: withErrors(MESSAGE) },
  // Attendee.ExternalUserId is the private profile id; the rest is Chime meeting metadata.
  liveMeetingForHelpRequest: { kind: withErrors({}) },
  mcpTokensCreate: {
    kind: withErrors({ "$.token": "free_text", "$.metadata.name": "free_text", ...MESSAGE }),
    note: "token is a secret, not PII; free_text keeps it out of the replay"
  },
  mcpTokensList: { kind: withErrors({ "$.tokens[*].name": "free_text" }) },
  mcpTokensRevoke: { kind: withErrors(MESSAGE) },
  repositoriesForClass: {
    kind: withErrors({
      "$[*].name": "handle",
      "$[*].full_name": "handle",
      "$[*].description": "free_text"
    }),
    uncertain: "Octokit repo objects; URL fields embed name/full_name and are caught by substring matching"
  },
  repositoryGetFile: { kind: withErrors({ "$.content": "free_text" }) },
  repositoryListCommits: {
    kind: withErrors({
      "$.commits[*].commit.author.name": "name",
      "$.commits[*].commit.author.email": "email",
      "$.commits[*].commit.committer.name": "name",
      "$.commits[*].commit.committer.email": "email",
      "$.commits[*].commit.message": "free_text",
      "$.commits[*].author.login": "handle",
      "$.commits[*].author.avatar_url": "handle",
      "$.commits[*].committer.login": "handle",
      "$.commits[*].committer.avatar_url": "handle"
    }),
    uncertain: "Octokit commit objects; URL and id fields of author/committer are left none"
  },
  repositoryListFiles: {
    kind: withErrors({ "$[*].name": "free_text", "$[*].path": "free_text" }),
    uncertain: "file names in a student repository are chosen by the student"
  },
  repositoryWriteFile: { kind: withErrors({}) },
  // Returns { is_ok, message: "Invited <github_username> to <team>" }.
  resendOrgInvitation: { kind: withErrors(MESSAGE) },
  syncGitHubAccount: { kind: withErrors(MESSAGE) },
  syncInstructorGitHubAccount: { kind: withErrors({ ...MESSAGE, ...GITHUB_LINK_STATUS }) },
  triggerWorkflow: { kind: withErrors(MESSAGE) },
  unlinkInstructorGitHubAccount: { kind: withErrors({ ...MESSAGE, ...GITHUB_LINK_STATUS }) },
  userFetchAzureProfile: { kind: withErrors({ ...MESSAGE, "$.sis_user_id": "handle" }) }
};
