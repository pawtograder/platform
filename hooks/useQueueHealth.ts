"use client";

import { useEffect, useMemo, useState } from "react";
import { useCourse } from "@/hooks/useCourseController";
import {
  useHelpQueueAssignments,
  useHelpQueues,
  useHelpRequests,
  useOfficeHoursController
} from "@/hooks/useOfficeHoursRealtime";
import { computeQueueHealth, type QueueHealth } from "@/lib/queueHealth";
import { parseQueueHealthThresholds, type QueueHealthThresholds } from "@/lib/queueHealthThresholds";

export type { QueueHealth } from "@/lib/queueHealth";
export type { QueueHealthThresholds } from "@/lib/queueHealthThresholds";
export { DEFAULT_QUEUE_HEALTH_THRESHOLDS } from "@/lib/queueHealthThresholds";

/** How often the wait times count up. It only moves the clock; it sends no request. */
const CLOCK_TICK_MS = 15_000;

/**
 * Health numbers for every active queue in the class, keyed by queue id, plus the class's
 * thresholds for the colors. Computed in the browser from the office-hours TableControllers, so
 * the counts change as soon as a realtime broadcast arrives, and the page makes no extra database
 * calls for them.
 */
export function useQueueHealth(enabled: boolean = true): {
  byQueue: Record<number, QueueHealth>;
  thresholds: QueueHealthThresholds;
} {
  // The limits come from the course, which the classes realtime update keeps current.
  const course = useCourse();
  const thresholds = useMemo(() => parseQueueHealthThresholds(course?.office_hours_health_thresholds), [course]);
  const queues = useHelpQueues();
  const requests = useHelpRequests();
  const assignments = useHelpQueueAssignments();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const controller = useOfficeHoursController();
  // Wait for all three tables' first load. Otherwise the red-queue alert would take a half-loaded
  // snapshot as its baseline and then announce queues that were already red.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.all([
      controller.helpQueues.readyPromise,
      controller.helpRequests.readyPromise,
      controller.helpQueueAssignments.readyPromise
    ]).then(
      () => {
        if (!cancelled) setLoaded(true);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [controller, enabled]);

  useEffect(() => {
    if (!enabled) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  const byQueue = useMemo(
    () => (enabled && loaded ? computeQueueHealth(queues, requests, assignments, nowMs) : {}),
    [enabled, loaded, queues, requests, assignments, nowMs]
  );

  return useMemo(() => ({ byQueue, thresholds }), [byQueue, thresholds]);
}
