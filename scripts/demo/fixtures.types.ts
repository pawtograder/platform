/**
 * Shared TypeScript types for demo-mode fixtures and the canned repo manifest.
 *
 * Build-time: scripts/demo/GenerateDemoFixtures.ts writes JSON conforming to
 * the *Fixture types into scripts/demo/fixtures/<archetype>/.
 *
 * Run-time: scripts/SeedDemoClass.ts loads those JSON files plus
 * scripts/demo/canned-repos.json and hands them to DatabaseSeeder.
 */

export type ArchetypeKey = string;

export type RealFleetName = "ripley" | "orion" | "paws";

export interface CannedAssignment {
  slug: string;
  title: string;
  /** When this assignment is due, measured in weeks from the class start. */
  weeksFromStart: number;
  isLab: boolean;
  points: number;
  autograderPoints: number;
  /** GitHub repo used as the assignment's template_repo. */
  handoutRepo: string;
  /** Solution repo wired into the autograder row. */
  solutionRepo: string;
  /** Pinned grader commit sha so demo provisioning is deterministic. */
  graderCommitSha: string;
  /** Mirror of `assignments.group_config` in the source class. `groups` makes
   * the demo assignment a group assignment — the seeder enrolls all real-fleet
   * students into a single shared group (since the demo fleet is small and we
   * want the visiting instructor to see them collaborating). */
  groupConfig?: "individual" | "groups" | "both";
  /** Mirror of `assignments.max_group_size` / `min_group_size`. Optional; the
   * seeder sets sensible defaults when missing. */
  minGroupSize?: number | null;
  maxGroupSize?: number | null;
  /** Source assignment id in `CannedArchetype.sourceClassId` whose hand-grading
   * rubrics (grading + meta + self-review) should be copied onto the demo
   * assignment. When absent, the seeder generates random rubric structure. */
  sourceAssignmentId?: number;
  /** Real submissions jon-bell (or whatever GitHub user the init script was
   * pointed at) made against this assignment in the source class. Phase C
   * distributes these across the fleet (ripley = newest, orion = middle, paws =
   * oldest) and pushes each one's exact sha into the corresponding student's
   * demo repo. We don't insert grader rows ourselves — the platform's webhook
   * fires on each push and the autograder produces matching scores naturally
   * because the pushed content matches jon-bell's original submission. The
   * snapshot of the grader_result + tests is kept here for reference and so
   * the manifest is self-documenting. */
  sourceSubmissions?: SourceSubmissionSnapshot[];
  /**
   * Optional generic student submission repo. Used as a fallback in Phase C
   * when a fleet member has no entry in `studentSubmissions` AND there are no
   * `sourceSubmissions` for the assignment.
   */
  genericStudentSubmission?: string;
  /**
   * Per-named-student submission repos. Only meaningful for the three real
   * fleet members (ripley/orion/paws); all other students ignore this field.
   */
  studentSubmissions?: Partial<Record<RealFleetName, string>>;
}

export interface SourceSubmissionSnapshot {
  /** Submission sha that the source user pushed. This is what Phase C checks
   * out of the source GitHub repo and overlays into the demo student repo. */
  sha: string;
  /** Pawtograder submissions.ordinal — 1-based attempt count for that profile + assignment. */
  ordinal?: number | null;
  /** ISO timestamp of the submission record in the source class. */
  createdAt?: string | null;
  /** owner/repo the source user submitted from, when available. */
  repository?: string | null;
  graderResult?: {
    score: number;
    max_score: number;
    lint_passed: boolean;
    lint_output: string | null;
    lint_output_format: string | null;
  } | null;
  graderResultTests?: Array<{
    name: string;
    name_format: string | null;
    score: number;
    max_score: number;
    output: string | null;
    output_format: string | null;
    is_released: boolean | null;
    extra_data: unknown;
  }>;
}

export interface CannedArchetype {
  courseTitle: string;
  description?: string;
  timeZone: string;
  /** Source class id the manifest was populated from. Pawtograder's demo
   * seeder reads this to copy hand-grading rubrics from each assignment's
   * `sourceAssignmentId` into the freshly-provisioned demo class. */
  sourceClassId?: number;
  assignments: CannedAssignment[];
}

export type CannedRepoManifest = Record<ArchetypeKey, CannedArchetype>;

// -------------- Fixture content shapes (LLM-authored) ---------------

export interface DiscussionThreadFixture {
  /** Discussion topic name. Matches either an assignment slug or a value
   * from GENERAL_DISCUSSION_TOPICS in DatabaseSeedingUtils.ts. */
  topic: string;
  subject: string;
  body: string;
  isQuestion: boolean;
  /** True if author posts anonymously (uses public_profile_id). */
  anonymous: boolean;
  replies: DiscussionReplyFixture[];
}

export interface DiscussionReplyFixture {
  body: string;
  /** Reply is posted by an instructor/grader (vs a student). */
  isInstructorReply: boolean;
  anonymous: boolean;
  /** When true, this reply is marked as the accepted answer to the question. */
  isAnswer?: boolean;
}

export interface PrivatePostFixture {
  /** Topic name (instructor-only posts still live under a discussion topic). */
  topic: string;
  subject: string;
  body: string;
  replies: PrivateReplyFixture[];
}

export interface PrivateReplyFixture {
  body: string;
  /** All private-post replies are between staff; this just tracks attribution. */
  fromRole: "instructor" | "grader";
}

export interface HelpRequestFixture {
  /** Optional assignment slug this request relates to (for display only). */
  assignmentSlug?: string;
  /** Whether the request is in a private (instructors+OP only) state. */
  isPrivate: boolean;
  /** Whether the request was resolved. */
  resolved: boolean;
  /** Duration in minutes (1-40); influences work-session length. */
  durationMinutes: number;
  request: string;
  replies: HelpReplyFixture[];
}

export interface HelpReplyFixture {
  message: string;
  isFromInstructor: boolean;
  /** Instructor-only message inside a private request thread. */
  instructorsOnly?: boolean;
}

export interface FixtureBundle {
  discussions: DiscussionThreadFixture[];
  privatePosts: PrivatePostFixture[];
  helpRequests: HelpRequestFixture[];
  /** Short, believable open-ended answers used to override faker.lorem in
   * surveys' text/comment elements. */
  surveyFreeform: string[];
}

export type HandoutStrategy = "fake-repos" | "real-handouts" | "real-everything";
