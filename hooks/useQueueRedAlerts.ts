"use client";

import { useEffect, useRef } from "react";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useFeatureEnabled } from "@/hooks/useCourseFeatures";
import type { QueueHealth, QueueHealthThresholds } from "@/hooks/useQueueHealth";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { getNotificationManager } from "@/lib/notifications/NotificationManager";
import { isQueueRed, queuesTurnedRed } from "@/lib/queueHealthAlerts";

/**
 * Instructor: a browser notification when a queue turns red (see isQueueRed). Fires once each time
 * a queue goes from not-red to red, so a queue that stays red does not keep alerting. Queues that
 * are already red on the first load are not announced.
 *
 * Health is computed in the browser on a 30 second refresh, so this only runs while an instructor
 * has the staff office hours page open.
 */
export function useQueueRedAlerts(health: {
  byQueue: Record<number, QueueHealth>;
  thresholds: QueueHealthThresholds;
}): void {
  const enabled = useFeatureEnabled(COURSE_FEATURES.OFFICE_HOURS_TURN_ALERT);
  const { role } = useClassProfiles();
  const isInstructor = role.role === "instructor";
  const wasRed = useRef(new Map<number, boolean>());
  const seeded = useRef(false);

  useEffect(() => {
    if (!enabled || !isInstructor || Object.keys(health.byQueue).length === 0) return;
    const newlyRed = queuesTurnedRed(wasRed.current, health.byQueue, health.thresholds);
    for (const h of Object.values(health.byQueue)) wasRed.current.set(h.queue_id, isQueueRed(h, health.thresholds));
    if (!seeded.current) {
      seeded.current = true;
      return;
    }
    for (const h of newlyRed) {
      const reason =
        h.waiting >= health.thresholds.waiting_red
          ? `${h.waiting} students are waiting`
          : `the oldest student has waited ${Math.round(h.oldest_wait_seconds / 60)} min`;
      getNotificationManager().notify({
        title: "Queue needs attention",
        body: `${h.queue_name} is red: ${reason}.`,
        tag: `office-hours-queue-red-${h.queue_id}`
      });
    }
  }, [enabled, isInstructor, health]);
}
