"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { useIsTableControllerReady } from "@/lib/TableController";
import { hintToShow, onboardingCompletedFrom, type OnboardingHintId } from "@/lib/officeHoursOnboarding";
import { hasSeenOnboarding, markOnboardingSeen, ONBOARDING_KEYS } from "@/lib/onboardingSeen";
import { createClient } from "@/utils/supabase/client";

/*
 * The onboarding hints live in two components: the queue description hint is on the office hours
 * page, and the New Request hint is in the office hours header. Both read and write this one
 * module-level store, so that only one hint is open at a time across the two components.
 *
 * - `wanted` holds the hints that a mounted component wants to show. A component adds its hint
 *   when it mounts and removes it when it unmounts.
 * - `dismissed` holds the hints the student closed since the page loaded. It is kept in memory
 *   only, so the hints come back on the next page load until the onboarding is complete.
 * - `completed` comes from the student's row in user_onboarding_seen. It is null until that read
 *   finishes, and the read happens once, the first time an active component asks.
 * - `owner` is the class profile that `completed` and `dismissed` belong to. Signing out and in as
 *   someone else, or moving to another course, doesn't always reload the page, so when the profile
 *   changes, the store forgets both and reads the table again.
 */
const ONBOARDING_KEY = ONBOARDING_KEYS.OFFICE_HOURS_STUDENT_ONBOARDING;
const wanted = new Map<OnboardingHintId, number>();
const dismissed = new Set<OnboardingHintId>();
let owner: string | null = null;
let completed: boolean | null = null;
let completedRead: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function startOverFor(profileId: string) {
  if (owner === profileId) return;
  owner = profileId;
  completed = null;
  completedRead = null;
  dismissed.clear();
  notify();
}

function readCompletedOnce() {
  if (completedRead) return;
  const readFor = owner;
  completedRead = onboardingCompletedFrom(() => hasSeenOnboarding(createClient(), ONBOARDING_KEY)).then((value) => {
    // Another profile took over while the read was in flight, and it has its own read.
    if (owner !== readFor) return;
    // completeOnboarding may have run while the read was in flight. Keep its answer.
    if (completed === null) completed = value;
    notify();
  });
}

/**
 * Whether this student has completed the onboarding.
 *
 * This returns true until the student's row in user_onboarding_seen has been read, so no hint opens
 * during the server render or before the answer arrives. If the read fails, it stays true.
 *
 * `active` is false when the course hasn't turned the feature on, or the user isn't a student
 * looking at the student pages. Then this returns true without reading the table. `profileId` is
 * the student's private profile in this class, which says whose answer the store holds.
 */
export function useOnboardingCompleted(active: boolean, profileId: string | null | undefined): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0
  );
  useEffect(() => {
    if (!active || !profileId) return;
    startOverFor(profileId);
    readCompletedOnce();
  }, [active, profileId]);
  if (!active || !profileId || owner !== profileId) return true;
  return completed !== false;
}

/**
 * Whether the office hours data the hints depend on has loaded: the queues and the staff shifts.
 * Until the shifts load, every queue looks unstaffed, so the New Request hint would say "No one is
 * on duty" even when someone is.
 *
 * This waits on the tables, not on the realtime connection, so the hints still open when realtime
 * can't connect (#1341).
 */
export function useOnboardingDataLoaded(): boolean {
  const controller = useOfficeHoursController();
  const queuesLoaded = useIsTableControllerReady(controller.helpQueues);
  const shiftsLoaded = useIsTableControllerReady(controller.helpQueueAssignments);
  return queuesLoaded && shiftsLoaded;
}

/** Whether the student closed this hint since the page loaded. */
export function useOnboardingHintDismissed(id: OnboardingHintId): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0
  );
  return dismissed.has(id);
}

/**
 * Saves that the student clicked an enabled New Request button, which closes every hint for good.
 * The hints close on this page load right away. If saving the row fails, they can open again on a
 * later visit.
 */
export function completeOnboarding() {
  completed = true;
  notify();
  markOnboardingSeen(createClient(), ONBOARDING_KEY).catch(() => {
    // Nothing to show the student: the hints are already closed for this visit.
  });
}

/**
 * Registers a hint this component wants to show, and says whether it is the one open right now.
 * Pass null when the component doesn't want to show a hint.
 */
export function useOnboardingHint(id: OnboardingHintId | null): { open: boolean; dismiss: () => void } {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0
  );

  // The id that this component's effect registered last. When `id` changes, for example from
  // "no-staff-on-duty" to "staff-on-duty" when a TA starts working, the store still holds the old
  // id until the effect runs again. Counting the store alone, the old id would win for one render
  // and `open` would be false. The popover closes on that render and doesn't open again. So `open`
  // counts this component's new id in place of its old one.
  const registeredId = useRef<OnboardingHintId | null>(null);

  useEffect(() => {
    if (id === null) return;
    registeredId.current = id;
    wanted.set(id, (wanted.get(id) ?? 0) + 1);
    notify();
    return () => {
      registeredId.current = null;
      const remaining = (wanted.get(id) ?? 1) - 1;
      if (remaining <= 0) wanted.delete(id);
      else wanted.set(id, remaining);
      notify();
    };
  }, [id]);

  const dismiss = useCallback(() => {
    if (id === null) return;
    dismissed.add(id);
    notify();
  }, [id]);

  const candidates = new Set(wanted.keys());
  if (registeredId.current !== null && registeredId.current !== id) candidates.delete(registeredId.current);
  if (id !== null) candidates.add(id);
  const open = id !== null && hintToShow(candidates, dismissed) === id;
  return { open, dismiss };
}
