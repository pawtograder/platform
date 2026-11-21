/**
 * The store behind the onboarding hints (hooks/useOfficeHoursOnboarding.ts).
 *
 * The store is module state that lasts for the page load, the same as in the browser. So the tests
 * in this file share it and run in order: what one test dismisses or saves, the next one sees.
 */

import { act, renderHook } from "@testing-library/react";
import {
  completeOnboarding,
  useOnboardingCompleted,
  useOnboardingHint,
  useOnboardingHintDismissed
} from "@/hooks/useOfficeHoursOnboarding";
import type { OnboardingHintId } from "@/lib/officeHoursOnboarding";

// The hook module also exports useOnboardingDataLoaded, which these tests don't use.
jest.mock("@/hooks/useOfficeHoursRealtime", () => ({
  useOfficeHoursController: () => ({})
}));
jest.mock("@/lib/TableController", () => ({ useIsTableControllerReady: () => true }));

const COMPLETED_KEY = "pawtograder:onboarding:oh-student:v1";

describe("useOnboardingCompleted", () => {
  beforeAll(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it("doesn't touch localStorage when the feature is off or the user isn't a student", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem");
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useOnboardingCompleted(false));
    expect(result.current).toBe(true);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("reads localStorage for a student in a course with the feature on", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem");
    const { result } = renderHook(() => useOnboardingCompleted(true));
    expect(result.current).toBe(false);
    expect(getItem).toHaveBeenCalledWith(COMPLETED_KEY);
  });
});

describe("useOnboardingHint", () => {
  it("opens one hint at a time, the queue description first, and the next one after a dismiss", () => {
    const { result } = renderHook(() => ({
      newRequest: useOnboardingHint("no-staff-on-duty"),
      description: useOnboardingHint("read-queue-description")
    }));
    expect(result.current.description.open).toBe(true);
    expect(result.current.newRequest.open).toBe(false);

    act(() => result.current.description.dismiss());
    expect(result.current.description.open).toBe(false);
    expect(result.current.newRequest.open).toBe(true);
  });

  it("tells the header that the student closed the queue description hint", () => {
    // The header holds the New Request hint back on the queue list until this is true.
    // The test above closed the queue description hint, and the store keeps that for the page load.
    expect(renderHook(() => useOnboardingHintDismissed("read-queue-description")).result.current).toBe(true);
    expect(renderHook(() => useOnboardingHintDismissed("staff-on-duty")).result.current).toBe(false);
  });

  it("keeps the New Request hint open on every render when staff come on duty while the page is open", () => {
    // The header asks for "no-staff-on-duty" until a shift starts, then for "staff-on-duty". If one
    // render in between reported the hint closed, the popover would close and not open again.
    const opens: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ id }: { id: OnboardingHintId }) => {
        const hint = useOnboardingHint(id);
        opens.push(hint.open);
        return hint;
      },
      { initialProps: { id: "no-staff-on-duty" as OnboardingHintId } }
    );
    expect(result.current.open).toBe(true);

    const rendersBeforeSwitch = opens.length;
    rerender({ id: "staff-on-duty" });
    expect(result.current.open).toBe(true);
    expect(opens.slice(rendersBeforeSwitch)).not.toContain(false);
  });

  it("closes every hint once the student clicks New Request, and saves that", () => {
    const { result } = renderHook(() => ({
      completed: useOnboardingCompleted(true),
      hint: useOnboardingHint("staff-on-duty")
    }));
    expect(result.current.completed).toBe(false);
    expect(result.current.hint.open).toBe(true);

    act(() => completeOnboarding());
    expect(result.current.completed).toBe(true);
    expect(window.localStorage.getItem(COMPLETED_KEY)).toBe("completed");
  });
});
