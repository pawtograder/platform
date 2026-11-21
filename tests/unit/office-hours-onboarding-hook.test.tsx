/**
 * The store behind the onboarding hints (hooks/useOfficeHoursOnboarding.ts).
 *
 * The store is module state that lasts for the page load, the same as in the browser. So the tests
 * in this file share it and run in order: what one test reads or saves, the next one sees. Each
 * test sets up the dismissals it checks.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import {
  completeOnboarding,
  useOnboardingCompleted,
  useOnboardingDataLoaded,
  useOnboardingHint,
  useOnboardingHintDismissed
} from "@/hooks/useOfficeHoursOnboarding";
import type { OnboardingHintId } from "@/lib/officeHoursOnboarding";
import { hasSeenOnboarding, markOnboardingSeen } from "@/lib/onboardingSeen";

// The office hours tables, and which of them have finished loading.
const queuesTable = { name: "help_queues" };
const shiftsTable = { name: "help_queue_assignments" };
const loadedTables = new Set<object>();
jest.mock("@/hooks/useOfficeHoursRealtime", () => ({
  useOfficeHoursController: () => ({ helpQueues: queuesTable, helpQueueAssignments: shiftsTable }),
  // The hints must not wait for the realtime connection (#1341), so nothing here may ask for it.
  useConnectionStatus: () => {
    throw new Error("the onboarding store asked for the realtime connection status");
  }
}));
jest.mock("@/hooks/useConnectionStatus", () => ({
  useConnectionStatus: () => {
    throw new Error("the onboarding store asked for the realtime connection status");
  }
}));
jest.mock("@/lib/TableController", () => ({
  useIsTableControllerReady: (table: object) => loadedTables.has(table)
}));

/** A read of user_onboarding_seen that the test finishes when it wants to. */
function pendingRead() {
  let finish: (seen: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  (hasSeenOnboarding as jest.Mock).mockImplementationOnce(() => promise);
  return finish;
}

// The student's row in user_onboarding_seen. The table's RLS is tested against a real database in
// tests/e2e/user-onboarding-seen-db.spec.ts.
const fakeClient = {};
jest.mock("@/utils/supabase/client", () => ({ createClient: () => fakeClient }));
jest.mock("@/lib/onboardingSeen", () => ({
  ONBOARDING_KEYS: { OFFICE_HOURS_STUDENT_ONBOARDING: "office-hours-student-onboarding" },
  hasSeenOnboarding: jest.fn(async () => false),
  markOnboardingSeen: jest.fn(async () => undefined)
}));

describe("useOnboardingDataLoaded", () => {
  it("waits for both the queues and the staff shifts, and not for realtime", () => {
    loadedTables.clear();
    loadedTables.add(queuesTable);
    expect(renderHook(() => useOnboardingDataLoaded()).result.current).toBe(false);

    loadedTables.add(shiftsTable);
    expect(renderHook(() => useOnboardingDataLoaded()).result.current).toBe(true);
  });
});

describe("useOnboardingCompleted", () => {
  it("doesn't read the table when the feature is off or the user isn't a student", () => {
    const { result } = renderHook(() => useOnboardingCompleted(false, "profile-a"));
    expect(result.current).toBe(true);
    expect(hasSeenOnboarding).not.toHaveBeenCalled();
  });

  it("reads the student's row once, and reports complete until the answer arrives", async () => {
    const { result } = renderHook(() => useOnboardingCompleted(true, "profile-a"));
    // No hint may open before the database has answered.
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));

    renderHook(() => useOnboardingCompleted(true, "profile-a"));
    expect(hasSeenOnboarding).toHaveBeenCalledTimes(1);
    expect(hasSeenOnboarding).toHaveBeenCalledWith(fakeClient, "office-hours-student-onboarding");
  });

  it("starts over for another student signed in on the same page, without a reload", async () => {
    // Student A finished onboarding and closed a hint.
    renderHook(() => useOnboardingCompleted(true, "profile-a"));
    act(() => completeOnboarding());
    const hint = renderHook(() => useOnboardingHint("read-queue-description"));
    act(() => hint.result.current.dismiss());
    const readsBefore = (hasSeenOnboarding as jest.Mock).mock.calls.length;

    // Student B signs in on the same tab. A's answer and dismissals must not carry over.
    const { result } = renderHook(() => ({
      completed: useOnboardingCompleted(true, "profile-b"),
      dismissed: useOnboardingHintDismissed("read-queue-description")
    }));
    await waitFor(() => expect(result.current.completed).toBe(false));
    expect(result.current.dismissed).toBe(false);
    expect(hasSeenOnboarding).toHaveBeenCalledTimes(readsBefore + 1);
  });

  it("ignores a read that finishes after another student took over", async () => {
    // Student C has seen the hints and D hasn't. D signs in while C's read is still in flight.
    const finishReadForC = pendingRead();
    renderHook(() => useOnboardingCompleted(true, "profile-c"));
    const finishReadForD = pendingRead();
    const { result } = renderHook(() => useOnboardingCompleted(true, "profile-d"));

    // C's answer arrives first. It belongs to C, so D must not take it.
    await act(async () => finishReadForC(true));
    await act(async () => finishReadForD(false));
    expect(result.current).toBe(false);
  });

  it("ignores a read that started before the student signed out and back in", async () => {
    // G's first read is in flight when H signs in on the same tab, and then G signs in again. In
    // between, G clicked New Request on another device, so the first read's "not seen" is out of
    // date and the second read's "seen" is the answer.
    const finishFirstReadForG = pendingRead();
    renderHook(() => useOnboardingCompleted(true, "profile-g"));
    const finishReadForH = pendingRead();
    renderHook(() => useOnboardingCompleted(true, "profile-h"));
    const finishSecondReadForG = pendingRead();
    const { result } = renderHook(() => useOnboardingCompleted(true, "profile-g"));

    // The first read for G answers first. It started before H signed in, so G must not take it.
    await act(async () => finishFirstReadForG(false));
    await act(async () => finishReadForH(false));
    await act(async () => finishSecondReadForG(true));
    expect(result.current).toBe(true);
  });

  it("keeps a New Request click made while the read is still in flight", async () => {
    const finishRead = pendingRead();
    const { result } = renderHook(() => useOnboardingCompleted(true, "profile-e"));
    act(() => completeOnboarding());
    expect(result.current).toBe(true);

    // The read started before the click, so its "not seen" is out of date.
    await act(async () => finishRead(false));
    expect(result.current).toBe(true);
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

  it("tells the header when the student closes the queue description hint", () => {
    // The header holds the New Request hint back on the queue list until this is true.
    const { result } = renderHook(() => ({
      hint: useOnboardingHint("read-queue-description"),
      dismissed: useOnboardingHintDismissed("read-queue-description"),
      otherDismissed: useOnboardingHintDismissed("staff-on-duty")
    }));
    act(() => result.current.hint.dismiss());
    expect(result.current.dismissed).toBe(true);
    expect(result.current.otherDismissed).toBe(false);
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

  it("marks onboarding complete and saves the student's row when they click New Request", async () => {
    // The components pass a null hint id once this is complete, which is what closes the hints.
    const { result } = renderHook(() => useOnboardingCompleted(true, "profile-f"));
    await waitFor(() => expect(result.current).toBe(false));

    act(() => completeOnboarding());
    expect(result.current).toBe(true);
    expect(markOnboardingSeen).toHaveBeenLastCalledWith(fakeClient, "office-hours-student-onboarding");
  });
});
