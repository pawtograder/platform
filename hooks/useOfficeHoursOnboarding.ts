"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConnectionStatus, useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { useIsTableControllerReady } from "@/lib/TableController";
import {
  hintToShow,
  markOnboardingCompleted,
  readOnboardingCompleted,
  type OnboardingHintId
} from "@/lib/officeHoursOnboarding";

/*
 * The onboarding hints live in two components: the queue description hint is on the office hours
 * page, and the New Request hint is in the office hours header. Both read and write this one
 * module-level store, so that only one hint is open at a time across the two components.
 *
 * - `wanted` holds the hints that a mounted component wants to show. A component adds its hint
 *   when it mounts and removes it when it unmounts.
 * - `dismissed` holds the hints the student closed since the page loaded. It is kept in memory
 *   only, so the hints come back on the next page load until the onboarding is complete.
 * - `completed` is read from localStorage the first time a component asks for it in the browser.
 */
const wanted = new Map<OnboardingHintId, number>();
const dismissed = new Set<OnboardingHintId>();
let completed: boolean | null = null;
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

function isCompleted(): boolean {
  if (completed === null) completed = readOnboardingCompleted();
  return completed;
}

/**
 * Whether this student has completed the onboarding.
 *
 * During the server render and the first browser render this returns true, so no hint opens before
 * the page has hydrated. After the component mounts, it returns the value saved in localStorage.
 */
export function useOnboardingCompleted(): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? isCompleted() : true;
}

/**
 * Whether the office hours data the hints depend on has loaded: the realtime connection, the queues,
 * and the staff shifts.
 *
 * Until the shifts load, every queue looks unstaffed, so the New Request hint would say "No one is on
 * duty" even when someone is. The page and the header both wait on this, so the queue description
 * hint and the New Request hint register in the same render and open in their usual order.
 */
export function useOnboardingDataLoaded(): boolean {
  const controller = useOfficeHoursController();
  const { isLoading } = useConnectionStatus();
  const queuesLoaded = useIsTableControllerReady(controller.helpQueues);
  const shiftsLoaded = useIsTableControllerReady(controller.helpQueueAssignments);
  return !isLoading && queuesLoaded && shiftsLoaded;
}

/** Saves that the student clicked an enabled New Request button, which closes every hint for good. */
export function completeOnboarding() {
  markOnboardingCompleted();
  completed = true;
  notify();
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

  useEffect(() => {
    if (id === null) return;
    wanted.set(id, (wanted.get(id) ?? 0) + 1);
    notify();
    return () => {
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

  const open = id !== null && hintToShow(new Set(wanted.keys()), dismissed) === id;
  return { open, dismiss };
}
