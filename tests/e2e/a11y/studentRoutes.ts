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
import { seedAgentPages, type AgentSeed } from "../a11yAgentSeeding";
import {
  createClass,
  createUsersInClass,
  insertOfficeHoursQueue,
  insertHelpQueueAssignment,
  insertHelpRequest,
  supabase
} from "../TestingUtils";

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
  /** Some routes legitimately have no <main>/nav landmark (auth shells). */
  expectLandmarks?: boolean;
  /**
   * Reflow at 320px is checked by default and gated separately from
   * `expectLandmarks`: a shell with no nav still owes 1.4.10. Set false only
   * where there is no <main> for `assertReflowAt320` to measure.
   */
  expectReflow?: boolean;
  /** Routes that must be visited signed-out. */
  anonymous?: boolean;
};

export type StudentSurface = AgentSeed & {
  // Non-nullable by construction: seedStudentSurface throws rather than hand
  // back an id that would build an unreachable path.
  pollId: string;
  queueId: string;
  deckId: string;
  helpRequestId: string;
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

  // Every fixture below is REQUIRED. A missing one used to become "" or null
  // and flow straight into a path like `/office-hours/null`, which renders an
  // error page, scans clean, and counts as covered — the exact opposite of the
  // honest denominator this registry claims to be. Fail at seed time instead.
  const resultsPath = seed.routes["autograder-results"];
  const m = resultsPath.match(/assignments\/(\d+)\/submissions\/(\d+)/);
  if (!m) {
    throw new Error(
      `seedStudentSurface: could not read assignment/submission ids from ` +
        `routes["autograder-results"] (${resultsPath}). The submission routes cannot be built.`
    );
  }
  const assignmentId = m[1];
  const submissionId = m[2];
  const threadId = seed.seedValues.threadId;
  const surveyId = seed.seedValues.surveyId;

  // A live poll so /polls and /poll/[course_id] render the answer form rather
  // than an empty state. `question` must be a SurveyJS config: the page casts
  // it and bails to "No Live Poll Available" when `elements` is absent.
  // `require_login` stays false so the public-poll route measures the surface an
  // unauthenticated respondent sees: the page only reads auth when the flag is
  // set, and renders a "Login Required" stub for a signed-out visitor otherwise.
  // NOTE: the `public-poll` row is not marked `anonymous`, so today the sweep
  // reaches it signed in. Marking it anonymous is the honest fix, but it changes
  // what is measured and needs a baseline re-record, so it is left as a gap
  // rather than flipped silently.
  const { data: poll, error: pollError } = await supabase
    .from("live_polls")
    .insert({
      class_id: seed.course.id,
      created_by: seed.instructor.public_profile_id,
      question: {
        elements: [
          {
            type: "radiogroup",
            title: "How is the pace of the course?",
            choices: ["Too slow", "About right", "Too fast"]
          }
        ]
      },
      is_live: true,
      require_login: false
    })
    .select("id")
    .single();
  if (pollError || !poll) {
    throw new Error(`seedStudentSurface: could not seed live_polls — ${pollError?.message ?? "no row returned"}`);
  }
  const pollId = String(poll.id);

  // A queue with staff on duty, so the queue sub-routes are reachable and the
  // New Request affordance is enabled.
  const queue = await insertOfficeHoursQueue({ class_id: seed.course.id, name: "A11y Coverage Queue" });
  await insertHelpQueueAssignment({
    help_queue_id: queue.id,
    ta_profile_id: seed.instructor.private_profile_id,
    class_id: seed.course.id
  });
  const queueId = String(queue.id);

  // An open request ON that queue, so both help-request detail routes are
  // reachable with a known queue id. seedAgentPages' own request lives on a
  // different queue and does not expose it.
  const helpRequest = await insertHelpRequest({
    class_id: seed.course.id,
    student_profile_id: seed.student.private_profile_id,
    request: "Seeded for the a11y coverage sweep: how do I read the autograder output?",
    help_queue_id: queue.id,
    active_staff_profile_id: seed.instructor.private_profile_id
  });
  const helpRequestId = String(helpRequest.id);

  // `flashcard_decks.creator_id` references users(user_id), NOT profiles(id) —
  // passing a profile id is an FK error, and because supabase-js returns
  // errors rather than throwing, that used to leave deckId null and scan
  // `/flashcards/null`.
  const { data: deck, error: deckError } = await supabase
    .from("flashcard_decks")
    .insert({
      class_id: seed.course.id,
      name: "A11y Coverage Deck",
      description: "Deck seeded for the student a11y sweep",
      creator_id: seed.instructor.user_id
    })
    .select("id")
    .single();
  if (deckError || !deck) {
    throw new Error(`seedStudentSurface: could not seed flashcard_decks — ${deckError?.message ?? "no row returned"}`);
  }
  const deckId = String(deck.id);

  // The unsubscribe page updates the watcher row and renders its error state
  // when it matches none. The thread was inserted through the service-role
  // client, so the discussion trigger saw no auth.uid() and created no watcher
  // — without this the route measures "Unsubscribe Error", not the real
  // unsubscribe surface.
  const { error: watcherError } = await supabase.from("discussion_thread_watchers").insert({
    user_id: seed.student.user_id,
    discussion_thread_root_id: Number(threadId),
    class_id: seed.course.id,
    enabled: true
  });
  if (watcherError) {
    throw new Error(`seedStudentSurface: could not seed discussion_thread_watchers — ${watcherError.message}`);
  }

  // Enrol the student in a second class so /course renders the picker.
  //
  // app/course/page.tsx redirects to /course/<id> when the user has exactly one
  // enrollment, and seedAgentPages creates a brand-new student in one class, so
  // /course used to land on the course dashboard. The sweep recorded the
  // dashboard's findings under the picker's key: a page nobody had scanned,
  // reported as covered.
  //
  // This class stays deliberately empty. The picker lists enrollments, so a
  // second row is all it takes to render, and seeding content into it would add
  // fixtures no route reads.
  const secondCourse = await createClass({ name: "E2E A11y Second Class" });
  await createUsersInClass([
    {
      role: "student",
      class_id: secondCourse.id,
      // Same email = same user, joined to another class, rather than a second
      // student who would leave the first one still redirecting.
      email: seed.student.email,
      name: "Agent Student",
      useMagicLink: true
    }
  ]);

  return { ...seed, pollId, queueId, deckId, helpRequestId, assignmentId, submissionId, threadId, surveyId };
}

const sub = (s: StudentSurface, leaf: string) =>
  `/course/${s.course.id}/assignments/${s.assignmentId}/submissions/${s.submissionId}${leaf}`;

/**
 * The student-facing routes, ordered roughly by student journey so a failure
 * list reads like a walkthrough of the product.
 *
 * Counts are derived, never asserted by hand — see the registry test, which
 * prints `ACTIVE_ROUTES.length` scanned and `SKIPPED_ROUTES.length` skipped.
 * A hard-coded total in this comment is exactly the kind of number that drifts
 * away from the set actually scanned.
 */
export const STUDENT_ROUTES: StudentRouteState[] = [
  // ---- auth / top-level -----------------------------------------------------
  // The auth shells have no nav landmark, so they are exempt from the landmark
  // checks — but sign-in DOES render <main id="main-content"> (app/(auth-pages)
  // /layout.tsx), so it still owes 1.4.10 and reflow is measured.
  { id: "sign-in", label: "sign-in", path: () => "/sign-in", anonymous: true, expectLandmarks: false },
  {
    id: "login",
    label: "login",
    path: () => "/login",
    anonymous: true,
    expectLandmarks: false,
    expectReflow: false // app/login/page.tsx renders no <main> to measure
  },
  {
    id: "root",
    label: "root",
    path: () => "/",
    anonymous: true,
    // Signed out, `/` is not a redirect: app/page.tsx renders the sign-in form
    // inside app/(auth-pages)/layout.tsx, which DOES supply <main id="main-content">.
    // So the landmark exemption is only about the missing nav, and 1.4.10 is
    // measurable here — exempting it was recording coverage that never happened.
    // (`REDIRECTS_BY_DESIGN` still lists this id, because an authenticated visit
    // is bounced to /course by utils/supabase/middleware.ts.)
    expectLandmarks: false
  },
  {
    id: "course-picker",
    label: "course picker",
    // Reachable only because seedStudentSurface enrols the student in a second
    // class. With one enrollment app/course/page.tsx redirects to the course
    // dashboard, and this row silently recorded that page's findings instead.
    path: () => "/course"
  },
  {
    id: "canvas-classes",
    label: "canvas classes",
    path: () => "/course/canvas-classes"
    // Still an unbuilt stub, but a routable one, so it is kept under the full
    // landmark + reflow checks rather than exempted. It renders outside the
    // course layout, so app/course/canvas-classes/page.tsx supplies its own
    // <main id="main-content"> (the 1.3.1 failure the first sweep recorded here).
  },
  {
    id: "error-page",
    label: "error page",
    path: () => "/error",
    anonymous: true,
    expectLandmarks: false,
    expectReflow: false // app/error/page.tsx renders no <main> to measure
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
    id: "office-hours-request-in-queue",
    label: "help request detail (in queue)",
    path: (s) => `/course/${s.course.id}/office-hours/${s.queueId}/${s.helpRequestId}`
  },
  {
    // The queue-less form, which is what notification links and chat pop-outs open.
    id: "office-hours-request",
    label: "help request detail (direct link)",
    path: (s) => `/course/${s.course.id}/office-hours/request/${s.helpRequestId}`
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
