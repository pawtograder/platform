/**
 * Rules for the onboarding hints a student sees on the office hours pages.
 *
 * When a student opens office hours, the page shows up to two hints, one at a time:
 *   1. "read-queue-description": points at the queue list. It shows only when the course has two or
 *      more text queues, because then the student has to pick between them, and each course splits
 *      its text queues its own way.
 *   2. A hint on the New Request button. "no-staff-on-duty" when the button is disabled because
 *      nobody is working any queue, and "staff-on-duty" when the student can click it.
 *
 * The student sees these hints on every visit until they click New Request while it is enabled.
 * After that, the onboarding is complete and no hint opens on its own again. Completion is stored
 * per user in user_whats_new_seen (lib/onboardingSeen.ts), so it holds on every browser and device.
 *
 * All of it is behind the course feature "office-hours-student-onboarding", which is off by default.
 * With the feature off, no hint opens, nothing reads or writes user_whats_new_seen, and the new
 * request form keeps the helper text it had before.
 *
 * Everything in this file is a pure function, so the rules can be tested without rendering the
 * pages or reaching the database.
 */

export type OnboardingHintId = "read-queue-description" | "no-staff-on-duty" | "staff-on-duty";

/** The order the hints show in. Only one hint is open at a time. */
export const ONBOARDING_HINT_ORDER: readonly OnboardingHintId[] = [
  "read-queue-description",
  "no-staff-on-duty",
  "staff-on-duty"
];

/** The text queues a student can pick between on the office hours page: available ones only. */
export function countTextQueues(queues: readonly { available: boolean; queue_type: string }[]): number {
  return queues.filter((queue) => queue.available && queue.queue_type === "text").length;
}

/**
 * Whether the office hours page is showing its queue list, by the same checks as the page's early
 * returns: while the page is loading or the connection has failed, a message replaces the list,
 * and the queue description hint has nothing to point at.
 *
 * The page uses this to decide whether to ask for the queue description hint, so the hint never
 * opens without the list it points at. If the page's early returns change, for example in #1341,
 * change this to match. The header doesn't use it: it keeps waiting while the page is loading,
 * because the list usually follows (see office-hours-header.tsx).
 */
export function queueListShown({
  browseView,
  loading,
  connectionError,
  disconnected
}: {
  browseView: boolean;
  loading: boolean;
  connectionError: boolean;
  disconnected: boolean;
}): boolean {
  return browseView && !loading && !connectionError && !disconnected;
}

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

/**
 * Whether the New Request hint has to wait because the queue description hint comes first: the
 * student is on the queue list, the queue description hint applies, and they haven't closed it yet.
 *
 * The header decides this from its own data instead of waiting to see whether the page asks for
 * its hint. On a first visit the header's code can load before the page's, and the New Request
 * hint would open for a moment before the queue description hint replaced it.
 */
export function queueDescriptionHintPending({
  onQueueList,
  featureEnabled,
  isStudent,
  completed,
  textQueueCount,
  dismissed
}: {
  onQueueList: boolean;
  featureEnabled: boolean;
  isStudent: boolean;
  completed: boolean;
  textQueueCount: number;
  dismissed: boolean;
}): boolean {
  return (
    onQueueList && !dismissed && wantsQueueDescriptionHint({ featureEnabled, isStudent, completed, textQueueCount })
  );
}

/** Which hint, if any, the New Request button should show. */
export function newRequestHint({
  featureEnabled,
  isStudent,
  completed,
  staffOnDuty,
  waitForQueueDescription
}: {
  featureEnabled: boolean;
  isStudent: boolean;
  completed: boolean;
  staffOnDuty: boolean;
  /** See queueDescriptionHintPending. */
  waitForQueueDescription: boolean;
}): OnboardingHintId | null {
  if (!featureEnabled || !isStudent || completed || waitForQueueDescription) return null;
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
    // The form fills the description from the template only while the description is empty, so a
    // student who switches templates keeps what they already wrote.
    template:
      "Pick the template closest to your question. If the description is empty, the template fills it in with questions to answer.",
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
 * Whether this student has completed the onboarding, given a call that reads their row in
 * user_whats_new_seen.
 *
 * If the read fails, this says completed. Otherwise the hints would open on every page load while
 * the database can't be reached, and the click that completes the onboarding couldn't be saved.
 */
export async function onboardingCompletedFrom(readSeen: () => Promise<boolean>): Promise<boolean> {
  try {
    return await readSeen();
  } catch {
    return true;
  }
}
