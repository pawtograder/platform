/**
 * Rules for the onboarding hints a student sees on the office hours pages.
 *
 * When a student opens office hours, the page shows up to two hints, one at a time:
 *   1. "read-queue-description": points at the selected queue's description. It shows only when the
 *      course has two or more text queues, because then the student has to pick between them, and
 *      each course splits its text queues its own way.
 *   2. A hint on the New Request button. "no-staff-on-duty" when the button is disabled because
 *      nobody is working any queue, and "staff-on-duty" when the student can click it.
 *
 * The student sees these hints on every visit until they click New Request while it is enabled.
 * After that, the onboarding is complete and no hint opens on its own again.
 *
 * All of it is behind the course feature "office-hours-student-onboarding", which is off by default.
 * With the feature off, no hint opens, clicking New Request saves nothing, and the new request form
 * keeps the helper text it had before.
 *
 * Everything in this file is a pure function or a localStorage helper, so the rules can be tested
 * without rendering the pages.
 */

export type OnboardingHintId = "read-queue-description" | "no-staff-on-duty" | "staff-on-duty";

/** The order the hints show in. Only one hint is open at a time. */
export const ONBOARDING_HINT_ORDER: readonly OnboardingHintId[] = [
  "read-queue-description",
  "no-staff-on-duty",
  "staff-on-duty"
];

const COMPLETED_KEY = "pawtograder:onboarding:oh-student:v1";
const PROBE_KEY = `${COMPLETED_KEY}:probe`;

/** Whether the queue description hint should show. */
export function wantsQueueDescriptionHint({
  featureEnabled,
  isStudent,
  completed,
  textQueueCount
}: {
  featureEnabled: boolean;
  isStudent: boolean;
  completed: boolean;
  textQueueCount: number;
}): boolean {
  return featureEnabled && isStudent && !completed && textQueueCount >= 2;
}

/** Which hint, if any, the New Request button should show. */
export function newRequestHint({
  featureEnabled,
  isStudent,
  completed,
  staffOnDuty
}: {
  featureEnabled: boolean;
  isStudent: boolean;
  completed: boolean;
  staffOnDuty: boolean;
}): OnboardingHintId | null {
  if (!featureEnabled || !isStudent || completed) return null;
  return staffOnDuty ? "staff-on-duty" : "no-staff-on-duty";
}

/**
 * Helper text for the fields on the new request form. With the feature off, the Help Queue field
 * keeps the text it had before, and the Template and Description fields have none.
 */
export function newRequestFormHelperText({
  featureEnabled,
  hasTemplates
}: {
  featureEnabled: boolean;
  hasTemplates: boolean;
}): { helpQueue: string; template?: string; description?: string } {
  if (!featureEnabled) {
    return { helpQueue: "Select which help queue to submit your request to" };
  }
  return {
    helpQueue:
      "Each course splits its queues differently. Read the queue's description, then pick the one that fits your question.",
    template: "Pick the template closest to your question. It fills in the description with questions to answer.",
    description: hasTemplates
      ? "Answer each question from the template. Your TA reads this before they start helping you."
      : "Say what you're working on, what you tried, and what happened instead of what you expected."
  };
}

/**
 * Picks the one hint to open now: the first hint in ONBOARDING_HINT_ORDER that a mounted component
 * wants to show and that the student hasn't dismissed during this visit.
 */
export function hintToShow(
  wanted: ReadonlySet<OnboardingHintId>,
  dismissed: ReadonlySet<OnboardingHintId>
): OnboardingHintId | null {
  return ONBOARDING_HINT_ORDER.find((id) => wanted.has(id) && !dismissed.has(id)) ?? null;
}

/**
 * The start of the next office hours event after `now`, or null if staff haven't put any on the
 * calendar. Courses that don't use the schedule get null, and the hint falls back to "check back
 * later".
 */
export function nextOfficeHoursStart(events: readonly { start_time: string }[], now: Date): Date | null {
  let next: Date | null = null;
  for (const event of events) {
    const start = new Date(event.start_time);
    if (Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) continue;
    if (next === null || start.getTime() < next.getTime()) next = start;
  }
  return next;
}

/**
 * Whether this student has completed the onboarding in this browser.
 *
 * If the browser blocks localStorage, or allows reads but not writes, this returns true. Otherwise
 * the hints would open on every page load forever, because the click that completes the
 * onboarding could never be saved.
 */
export function readOnboardingCompleted(): boolean {
  try {
    if (window.localStorage.getItem(COMPLETED_KEY) === "completed") return true;
    window.localStorage.setItem(PROBE_KEY, "1");
    window.localStorage.removeItem(PROBE_KEY);
    return false;
  } catch {
    return true;
  }
}

/** Saves that this student clicked an enabled New Request button. */
export function markOnboardingCompleted(): void {
  try {
    window.localStorage.setItem(COMPLETED_KEY, "completed");
  } catch {
    // readOnboardingCompleted already treats a browser that can't save this as completed.
  }
}
