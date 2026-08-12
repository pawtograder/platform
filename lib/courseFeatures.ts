/**
 * Canonical names for `classes.features` entries ({ name, enabled }).
 * Add new keys here as course-level flags are introduced.
 */
export const COURSE_FEATURES = {
  DISCUSSION: "discussion",
  FLASHCARDS: "flashcards",
  OFFICE_HOURS: "office-hours",
  GRADEBOOK: "gradebook",
  SURVEYS: "surveys",
  POLLS: "polls",
  GRADEBOOK_WHAT_IF: "gradebook-what-if",
  SUGGESTED_DUE_DATE: "suggested-due-date",
  DISCORD_STUDENT_JOIN: "discord-student-join"
} as const;

export type CourseFeatureName = (typeof COURSE_FEATURES)[keyof typeof COURSE_FEATURES];

export type ManageableCourseFeature = {
  name: CourseFeatureName;
  title: string;
  description: string;
  /** When no row exists in `classes.features`, treat the feature as this (nav modules default on; What-If defaults off). */
  defaultWhenMissing: boolean;
  /** If true, disabling hides staff nav entries that share this flag, not only student links. */
  navAffectsStaff?: boolean;
  switchLabel: string;
  ariaLabel: string;
};

/** Ordered list for the instructor Feature flags page. */
export const MANAGEABLE_COURSE_FEATURES: readonly ManageableCourseFeature[] = [
  {
    name: COURSE_FEATURES.DISCUSSION,
    title: "Discussion",
    description:
      "Course discussion threads and karma. When off, the Discussion entry is hidden from the course menu for everyone (including Discussion Topics and Engagement under Course Settings).",
    defaultWhenMissing: true,
    navAffectsStaff: true,
    switchLabel: "Show Discussion in the course menu",
    ariaLabel: "Enable Discussion for this course"
  },
  {
    name: COURSE_FEATURES.FLASHCARDS,
    title: "Flashcards",
    description:
      "Student flashcard study view. When off, the Flashcards entry is hidden from the student menu. Staff can still open Flashcard Decks from Course Settings.",
    defaultWhenMissing: true,
    navAffectsStaff: false,
    switchLabel: "Show Flashcards to students",
    ariaLabel: "Enable Flashcards for students"
  },
  {
    name: COURSE_FEATURES.OFFICE_HOURS,
    title: "Office hours",
    description:
      "Office hours queue and help UI. When off, related menu entries are hidden for students and staff, and help-queue shortcuts respect the flag.",
    defaultWhenMissing: true,
    navAffectsStaff: true,
    switchLabel: "Show Office hours in the course menu",
    ariaLabel: "Enable Office hours for this course"
  },
  {
    name: COURSE_FEATURES.GRADEBOOK,
    title: "Gradebook",
    description:
      "Student gradebook and staff gradebook management links. When off, Gradebook is hidden from the menu for students and instructors (you can still open manage URLs directly).",
    defaultWhenMissing: true,
    navAffectsStaff: true,
    switchLabel: "Show Gradebook in the course menu",
    ariaLabel: "Enable Gradebook navigation for this course"
  },
  {
    name: COURSE_FEATURES.SURVEYS,
    title: "Surveys",
    description:
      "Surveys for students and staff survey management. When off, Surveys is hidden from the menu for everyone.",
    defaultWhenMissing: true,
    navAffectsStaff: true,
    switchLabel: "Show Surveys in the course menu",
    ariaLabel: "Enable Surveys for this course"
  },
  {
    name: COURSE_FEATURES.POLLS,
    title: "Polls",
    description: "Polls for students and staff poll management. When off, Polls is hidden from the menu for everyone.",
    defaultWhenMissing: true,
    navAffectsStaff: true,
    switchLabel: "Show Polls in the course menu",
    ariaLabel: "Enable Polls for this course"
  },
  {
    name: COURSE_FEATURES.GRADEBOOK_WHAT_IF,
    title: "Student gradebook What-If",
    description:
      "When enabled, students can tap released grades to simulate hypothetical scores; calculated columns update from those simulations. When disabled, the student gradebook is view-only (What-If does not apply to the staff preview).",
    defaultWhenMissing: false,
    navAffectsStaff: false,
    switchLabel: "Allow What-If grade simulations for students",
    ariaLabel: "Enable student gradebook What-If"
  },
  {
    name: COURSE_FEATURES.SUGGESTED_DUE_DATE,
    title: "Suggested due dates",
    description:
      "For mastery/standards grading, where the suggested due date is the date students work to and the due date is the end of the resubmission window. When enabled, students see the suggested due date as the assignment's due date, with the hard deadline beneath it. Staff also get a Suggested Due Date column on Manage Assignments. Assignments with no suggested due date are unaffected.",
    defaultWhenMissing: false,
    navAffectsStaff: false,
    switchLabel: "Present the suggested due date as the due date",
    ariaLabel: "Enable suggested due date emphasis for this course"
  },
  {
    name: COURSE_FEATURES.DISCORD_STUDENT_JOIN,
    title: "Student Discord invitations",
    description:
      "When enabled, students see their invitation to this course's Discord server on their dashboard, and the sync creates one for any student who is not in the server yet. When disabled, no invitations are created and students are not shown one — role syncing for students already in the server is unaffected. Requires a Discord server to be configured for the course.",
    // Off unless a course opts in. Before this flag existed no student-facing route to a Discord
    // invitation existed at all, so defaulting on would newly invite every student of every course
    // that happens to have a server configured -- a change nobody asked for, made on their behalf.
    defaultWhenMissing: false,
    navAffectsStaff: false,
    switchLabel: "Let students join this course's Discord server",
    ariaLabel: "Enable student Discord invitations for this course"
  }
];

export const COURSE_FEATURE_DEFAULTS = MANAGEABLE_COURSE_FEATURES.reduce(
  (acc, def) => {
    acc[def.name] = def.defaultWhenMissing;
    return acc;
  },
  {} as Record<CourseFeatureName, boolean>
);

export function courseFeatureDefaultEnabled(name: CourseFeatureName): boolean {
  return COURSE_FEATURE_DEFAULTS[name] ?? true;
}

export function courseFeatureEffectiveEnabled(
  features: { name: string; enabled: boolean }[] | null | undefined,
  name: CourseFeatureName,
  defaultWhenMissing: boolean
): boolean {
  // `classes.features` is a bare jsonb column with no default and no CHECK, and callers reach it
  // through a cast. A non-array value would make `.find` throw — inside a Server Component that
  // takes down the whole page — so treat anything that is not an array as "no entries".
  const row = Array.isArray(features) ? features.find((f) => f?.name === name) : undefined;
  return row?.enabled ?? defaultWhenMissing;
}

export function courseFeatureEnabled(
  features: { name: string; enabled: boolean }[] | null | undefined,
  name: CourseFeatureName
): boolean {
  return courseFeatureEffectiveEnabled(features, name, courseFeatureDefaultEnabled(name));
}
