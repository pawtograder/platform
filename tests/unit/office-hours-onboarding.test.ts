/**
 * Rules for the student onboarding hints on the office hours pages (lib/officeHoursOnboarding.ts).
 */

import { COURSE_FEATURES, courseFeatureEnabled, MANAGEABLE_COURSE_FEATURES } from "../../lib/courseFeatures";
import {
  hintToShow,
  markOnboardingCompleted,
  newRequestFormHelperText,
  newRequestHint,
  nextOfficeHoursStart,
  readOnboardingCompleted,
  wantsQueueDescriptionHint,
  type OnboardingHintId
} from "../../lib/officeHoursOnboarding";

describe("the office-hours-student-onboarding course feature", () => {
  const name = COURSE_FEATURES.OFFICE_HOURS_STUDENT_ONBOARDING;

  it("is off for a course that hasn't turned it on", () => {
    expect(courseFeatureEnabled(null, name)).toBe(false);
    expect(courseFeatureEnabled([], name)).toBe(false);
    expect(courseFeatureEnabled([{ name: COURSE_FEATURES.OFFICE_HOURS, enabled: true }], name)).toBe(false);
  });

  it("is on once the course turns it on", () => {
    expect(courseFeatureEnabled([{ name, enabled: true }], name)).toBe(true);
  });

  it("is listed for instructors to turn on, and is off by default", () => {
    const entry = MANAGEABLE_COURSE_FEATURES.find((f) => f.name === name);
    expect(entry).toBeDefined();
    expect(entry?.defaultWhenMissing).toBe(false);
  });
});

describe("wantsQueueDescriptionHint", () => {
  const student = { featureEnabled: true, isStudent: true, completed: false };

  it("shows when a student who hasn't finished onboarding has two or more text queues to pick from", () => {
    expect(wantsQueueDescriptionHint({ ...student, textQueueCount: 2 })).toBe(true);
    expect(wantsQueueDescriptionHint({ ...student, textQueueCount: 3 })).toBe(true);
  });

  it("doesn't show with zero or one text queue, because there is nothing to pick between", () => {
    expect(wantsQueueDescriptionHint({ ...student, textQueueCount: 0 })).toBe(false);
    expect(wantsQueueDescriptionHint({ ...student, textQueueCount: 1 })).toBe(false);
  });

  it("doesn't show to staff or after onboarding is complete", () => {
    expect(wantsQueueDescriptionHint({ ...student, isStudent: false, textQueueCount: 3 })).toBe(false);
    expect(wantsQueueDescriptionHint({ ...student, completed: true, textQueueCount: 3 })).toBe(false);
  });

  it("doesn't show when the course hasn't turned the feature on", () => {
    expect(wantsQueueDescriptionHint({ ...student, featureEnabled: false, textQueueCount: 3 })).toBe(false);
  });
});

describe("newRequestHint", () => {
  const student = { featureEnabled: true, isStudent: true, completed: false };

  it("says nobody is on duty while the button is disabled", () => {
    expect(newRequestHint({ ...student, staffOnDuty: false })).toBe("no-staff-on-duty");
  });

  it("points at the button once staff are on duty", () => {
    expect(newRequestHint({ ...student, staffOnDuty: true })).toBe("staff-on-duty");
  });

  it("shows nothing to staff or after onboarding is complete", () => {
    expect(newRequestHint({ ...student, isStudent: false, staffOnDuty: true })).toBeNull();
    expect(newRequestHint({ ...student, completed: true, staffOnDuty: false })).toBeNull();
  });

  it("shows nothing when the course hasn't turned the feature on", () => {
    expect(newRequestHint({ ...student, featureEnabled: false, staffOnDuty: false })).toBeNull();
    expect(newRequestHint({ ...student, featureEnabled: false, staffOnDuty: true })).toBeNull();
  });
});

describe("newRequestFormHelperText", () => {
  it("keeps the form's old helper text when the course hasn't turned the feature on", () => {
    expect(newRequestFormHelperText({ featureEnabled: false, hasTemplates: true })).toEqual({
      helpQueue: "Select which help queue to submit your request to"
    });
  });

  it("asks the student to answer the template's questions when the queue has templates", () => {
    const text = newRequestFormHelperText({ featureEnabled: true, hasTemplates: true });
    expect(text.helpQueue).toMatch(/Read the queue's description/);
    expect(text.template).toMatch(/Pick the template closest to your question/);
    expect(text.description).toMatch(/Answer each question from the template/);
  });

  it("asks what the student tried when there is no template", () => {
    const text = newRequestFormHelperText({ featureEnabled: true, hasTemplates: false });
    expect(text.description).toMatch(/what you tried/);
  });
});

describe("hintToShow", () => {
  const set = (...ids: OnboardingHintId[]) => new Set<OnboardingHintId>(ids);

  it("opens the queue description hint before the New Request hint", () => {
    expect(hintToShow(set("no-staff-on-duty", "read-queue-description"), set())).toBe("read-queue-description");
  });

  it("opens the next hint after the student dismisses the first one", () => {
    expect(hintToShow(set("read-queue-description", "staff-on-duty"), set("read-queue-description"))).toBe(
      "staff-on-duty"
    );
  });

  it("opens nothing when every wanted hint was dismissed, or none is wanted", () => {
    expect(hintToShow(set("no-staff-on-duty"), set("no-staff-on-duty"))).toBeNull();
    expect(hintToShow(set(), set())).toBeNull();
  });

  it("opens the staff-on-duty hint even if the no-staff hint was dismissed earlier in the visit", () => {
    // Staff started working while the page was open, so the button just turned green.
    expect(hintToShow(set("staff-on-duty"), set("no-staff-on-duty"))).toBe("staff-on-duty");
  });
});

describe("nextOfficeHoursStart", () => {
  const now = new Date("2026-11-18T15:00:00Z");

  it("returns the earliest event that starts after now", () => {
    const events = [
      { start_time: "2026-11-20T14:00:00Z" },
      { start_time: "2026-11-19T18:00:00Z" },
      { start_time: "2026-11-18T14:00:00Z" }
    ];
    expect(nextOfficeHoursStart(events, now)?.toISOString()).toBe("2026-11-19T18:00:00.000Z");
  });

  it("returns null when the course has no upcoming office hours on the calendar", () => {
    expect(nextOfficeHoursStart([], now)).toBeNull();
    expect(nextOfficeHoursStart([{ start_time: "2026-11-17T14:00:00Z" }], now)).toBeNull();
  });

  it("skips events whose start time doesn't parse", () => {
    expect(nextOfficeHoursStart([{ start_time: "not a date" }], now)).toBeNull();
  });
});

describe("onboarding completion in localStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it("is not complete until the student clicks an enabled New Request button", () => {
    expect(readOnboardingCompleted()).toBe(false);
    markOnboardingCompleted();
    expect(readOnboardingCompleted()).toBe(true);
  });

  it("counts as complete when the browser won't save it, so the hints don't open on every page load", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readOnboardingCompleted()).toBe(true);
  });
});
