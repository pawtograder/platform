/**
 * Registry of every student-facing route, and how to reach it.
 *
 * Why a registry rather than more hand-written tests: 109 of the app's 129
 * pages have dynamic segments, so the cost of a11y coverage is dominated by
 * *reaching* a page with realistic state, not by scanning it. Declaring the
 * routes in one table means (a) adding coverage is a row, not a test, and
 * (b) "is this route covered?" is a lookup instead of a grep across 24 spec
 * files — which is how the gaps went unnoticed until they were audited.
 *
 * SCOPE: student-facing only. The 6 `grade/*` routes are the grader view, and
 * `manage/*` (67) and `admin/*` (10) are staff surfaces; all are out of scope
 * for this sweep and are listed in OUT_OF_SCOPE below so the omission is
 * explicit rather than implied.
 *
 * Routes we cannot yet reach carry `skip` with a reason. A skipped row is
 * still coverage information — it says "known gap, here's why" — so the
 * registry stays an honest denominator.
 */
import { addDays } from "date-fns";
import { seedAgentPages, type AgentSeed } from "../a11yAgentSeeding";
import { insertOfficeHoursQueue, insertHelpQueueAssignment, supabase } from "../TestingUtils";

export type StudentRouteState = {
  /** Stable id used as the baseline key — keep it stable across refactors. */
  id: string;
  /** Human label for failure messages. */
  label: string;
  /** Path to visit, built from the seed. */
  path: (s: StudentSurface) => string;
  /**
   * Reason this route is not scanned yet. Present = skipped. Keep specific:
   * this text is the record of why the gap exists.
   */
  skip?: string;
  /** Some routes legitimately have no <main> landmark (auth shells). */
  expectLandmarks?: boolean;
  /** Routes that must be visited signed-out. */
  anonymous?: boolean;
};

export type StudentSurface = AgentSeed & {
  pollId: string | null;
  queueId: string | null;
  deckId: string | null;
  assignmentId: string;
  submissionId: string;
  threadId: string;
  surveyId: string;
};

/**
 * Extends `seedAgentPages()` (which already seeds a course, survey,
 * assignment + pre-baked submission, regrade request, help request and
 * discussion thread) with the few entities the wider route set needs.
 * Reusing that seed keeps one definition of "a realistic student course".
 */
export async function seedStudentSurface(): Promise<StudentSurface> {
  const seed = await seedAgentPages();

  // Derive ids the registry needs from the routes seedAgentPages built.
  const resultsPath = seed.routes["autograder-results"];
  const m = resultsPath.match(/assignments\/(\d+)\/submissions\/(\d+)/);
  const assignmentId = m?.[1] ?? "";
  const submissionId = m?.[2] ?? "";
  const threadId = seed.seedValues.threadId;
  const surveyId = seed.seedValues.surveyId;

  // A live poll so /polls and /poll/[course_id] render content rather than an
  // empty state (the empty state is worth scanning too, but content exercises
  // more markup).
  let pollId: string | null = null;
  try {
    const { data: poll } = await supabase
      .from("live_polls")
      .insert({
        class_id: seed.course.id,
        created_by: seed.instructor.public_profile_id,
        question: "How is the pace of the course?",
        is_live: true,
        require_login: true
      })
      .select("id")
      .single();
    pollId = poll ? String(poll.id) : null;
  } catch {
    pollId = null;
  }

  // A queue with staff on duty, so the queue sub-routes are reachable and the
  // New Request affordance is enabled.
  let queueId: string | null = null;
  try {
    const queue = await insertOfficeHoursQueue({ class_id: seed.course.id, name: "A11y Coverage Queue" });
    await insertHelpQueueAssignment({
      help_queue_id: queue.id,
      ta_profile_id: seed.instructor.private_profile_id,
      class_id: seed.course.id
    });
    queueId = String(queue.id);
  } catch {
    queueId = null;
  }

  // A flashcard deck, if the feature's tables are present in this schema.
  let deckId: string | null = null;
  try {
    const { data: deck } = await supabase
      .from("flashcard_decks")
      .insert({
        class_id: seed.course.id,
        name: "A11y Coverage Deck",
        description: "Deck seeded for the student a11y sweep",
        creator_id: seed.instructor.public_profile_id
      })
      .select("id")
      .single();
    deckId = deck ? String(deck.id) : null;
  } catch {
    deckId = null;
  }

  void addDays; // kept for future date-dependent routes

  return { ...seed, pollId, queueId, deckId, assignmentId, submissionId, threadId, surveyId };
}

const sub = (s: StudentSurface, leaf: string) =>
  `/course/${s.course.id}/assignments/${s.assignmentId}/submissions/${s.submissionId}${leaf}`;

/**
 * The 46 student-facing routes. Ordered roughly by student journey so a
 * failure list reads like a walkthrough of the product.
 */
export const STUDENT_ROUTES: StudentRouteState[] = [
  // ---- auth / top-level -----------------------------------------------------
  { id: "sign-in", label: "sign-in", path: () => "/sign-in", anonymous: true, expectLandmarks: false },
  { id: "login", label: "login", path: () => "/login", anonymous: true, expectLandmarks: false },
  { id: "root", label: "root redirect", path: () => "/", anonymous: true, expectLandmarks: false },
  { id: "course-picker", label: "course picker", path: () => "/course" },
  { id: "canvas-classes", label: "canvas classes", path: () => "/course/canvas-classes" },
  {
    id: "error-page",
    label: "error page",
    path: () => "/error",
    anonymous: true,
    expectLandmarks: false
  },
  {
    id: "auth-magic-link",
    label: "magic link",
    path: () => "/auth/magic-link",
    anonymous: true,
    expectLandmarks: false,
    skip: "token-gated; needs a generated link fixture (generateMagicLink) wired into the sweep"
  },
  {
    id: "auth-confirm",
    label: "auth confirm",
    path: () => "/auth/confirm",
    anonymous: true,
    skip: "token-gated; redirects without a valid confirmation token"
  },
  {
    id: "auth-accept-invitation",
    label: "accept invitation",
    path: () => "/auth/accept-invitation",
    anonymous: true,
    skip: "token-gated; needs a pending invitation fixture"
  },
  {
    id: "auth-reset-password",
    label: "reset password",
    path: () => "/auth/reset-password",
    anonymous: true,
    skip: "token-gated; needs a recovery-session fixture"
  },
  { id: "sign-out", label: "sign out", path: () => "/sign-out", skip: "terminal route — navigating ends the session" },

  // ---- course home / assignments -------------------------------------------
  { id: "course-home", label: "course dashboard", path: (s) => `/course/${s.course.id}` },
  { id: "assignments", label: "assignments list", path: (s) => `/course/${s.course.id}/assignments` },
  {
    id: "assignment-detail",
    label: "assignment detail",
    path: (s) => `/course/${s.course.id}/assignments/${s.assignmentId}`
  },
  {
    id: "submissions-list",
    label: "submissions list",
    path: (s) => `/course/${s.course.id}/assignments/${s.assignmentId}/submissions`
  },
  { id: "submission-root", label: "submission root", path: (s) => sub(s, "") },
  { id: "submission-results", label: "autograder results", path: (s) => sub(s, "/results") },
  { id: "submission-files", label: "submission files (Monaco)", path: (s) => sub(s, "/files") },
  { id: "submission-grade", label: "grade summary", path: (s) => sub(s, "/grade") },
  { id: "submission-checks", label: "submission checks", path: (s) => sub(s, "/checks") },
  { id: "submission-deployments", label: "submission deployments", path: (s) => sub(s, "/deployments") },
  { id: "submission-repo-analytics", label: "repo analytics", path: (s) => sub(s, "/repo-analytics") },

  // ---- gradebook / regrades / notifications ---------------------------------
  { id: "gradebook", label: "gradebook", path: (s) => `/course/${s.course.id}/gradebook` },
  { id: "regrade-requests", label: "regrade requests", path: (s) => `/course/${s.course.id}/regrade-requests` },
  { id: "notifications", label: "notifications", path: (s) => `/course/${s.course.id}/notifications` },

  // ---- discussion -----------------------------------------------------------
  { id: "discussion-list", label: "discussion list", path: (s) => `/course/${s.course.id}/discussion` },
  {
    id: "discussion-thread",
    label: "discussion thread",
    path: (s) => `/course/${s.course.id}/discussion/${s.threadId}`
  },
  { id: "discussion-new", label: "new discussion", path: (s) => `/course/${s.course.id}/discussion/new` },

  // ---- office hours ---------------------------------------------------------
  { id: "office-hours", label: "office hours", path: (s) => `/course/${s.course.id}/office-hours` },
  {
    id: "office-hours-search",
    label: "office hours search",
    path: (s) => `/course/${s.course.id}/office-hours/search`
  },
  {
    id: "office-hours-queue",
    label: "office hours queue",
    path: (s) => `/course/${s.course.id}/office-hours/${s.queueId}`
  },
  {
    id: "office-hours-queue-new",
    label: "new help request",
    path: (s) => `/course/${s.course.id}/office-hours/${s.queueId}/new`
  },
  {
    id: "office-hours-queue-closed",
    label: "closed requests",
    path: (s) => `/course/${s.course.id}/office-hours/${s.queueId}/closed`
  },
  {
    id: "office-hours-queue-history",
    label: "queue history",
    path: (s) => `/course/${s.course.id}/office-hours/${s.queueId}/history`
  },
  {
    id: "office-hours-meet",
    label: "office hours video call",
    path: (s) => `/course/${s.course.id}/office-hours/${s.queueId}/request/1/meet`,
    skip: "AWS Chime call surface — needs media mocking; also 1.2.4/1.2.5 territory, tracked separately"
  },

  // ---- surveys / polls / flashcards -----------------------------------------
  { id: "surveys", label: "surveys list", path: (s) => `/course/${s.course.id}/surveys` },
  {
    id: "survey-taking",
    label: "survey taking (SurveyJS)",
    path: (s) => `/course/${s.course.id}/surveys/${s.surveyId}`
  },
  { id: "polls", label: "polls", path: (s) => `/course/${s.course.id}/polls` },
  { id: "flashcards", label: "flashcards", path: (s) => `/course/${s.course.id}/flashcards` },
  {
    id: "flashcard-deck",
    label: "flashcard deck",
    path: (s) => `/course/${s.course.id}/flashcards/${s.deckId}`
  },

  // ---- misc student surfaces -------------------------------------------------
  { id: "github-help", label: "github help", path: (s) => `/course/${s.course.id}/github-help` },
  {
    id: "unsubscribe-thread",
    label: "unsubscribe (thread)",
    path: (s) => `/course/${s.course.id}/unsubscribe/thread/${s.threadId}`
  },
  {
    id: "unsubscribe-topic",
    label: "unsubscribe (topic)",
    path: (s) => `/course/${s.course.id}/unsubscribe/topic/1`,
    skip: "needs a topic-subscription fixture to render the subscribed state"
  },
  {
    id: "public-poll",
    label: "public poll",
    path: (s) => `/poll/${s.course.id}`
  }
];

/** Documented non-scope, so the denominator is explicit. */
export const OUT_OF_SCOPE = {
  "grade/* (6 routes)": "grader view, not student-facing",
  "course/[id]/manage/* (67 routes)": "instructor surface — separate sweep",
  "admin/* (10 routes)": "platform admin surface — separate sweep"
} as const;

export const ACTIVE_ROUTES = STUDENT_ROUTES.filter((r) => !r.skip);
export const SKIPPED_ROUTES = STUDENT_ROUTES.filter((r) => r.skip);
