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
  /** Source assignment id in `CannedArchetype.sourceClassId` whose hand-grading
   * rubrics (grading + meta + self-review) should be copied onto the demo
   * assignment. When absent, the seeder generates random rubric structure. */
  sourceAssignmentId?: number;
  /**
   * Optional generic student submission repo. When set and the handout
   * strategy creates real student repos, filler students "submit" from this
   * repo. Real fleet members fall back to it if no per-name submission is
   * configured.
   */
  genericStudentSubmission?: string;
  /**
   * Per-named-student submission repos. Only meaningful for the three real
   * fleet members (ripley/orion/paws); all other students ignore this field.
   */
  studentSubmissions?: Partial<Record<RealFleetName, string>>;
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
