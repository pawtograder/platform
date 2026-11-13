"use client";

import { useEffect, useMemo, useState } from "react";
import { useCourse } from "@/hooks/useCourseController";
import { parseQueueHealthThresholds, type QueueHealthThresholds } from "@/lib/queueHealthThresholds";
import { createClient } from "@/utils/supabase/client";

export type QueueHealth = {
  queue_id: number;
  queue_name: string;
  waiting: number;
  oldest_wait_seconds: number;
  helping: number;
  staffed_tas: number;
  unstaffed_seconds: number | null;
  resolved_today: number;
  median_wait_seconds_today: number;
};

export type { QueueHealthThresholds } from "@/lib/queueHealthThresholds";
export { DEFAULT_QUEUE_HEALTH_THRESHOLDS } from "@/lib/queueHealthThresholds";

const REFRESH_MS = 30_000;

/**
 * Health numbers for every queue in the class, keyed by queue id, plus the class's thresholds for
 * the colors. Refreshes every 30 seconds.
 */
export function useQueueHealth(
  classId: number,
  enabled: boolean = true
): {
  byQueue: Record<number, QueueHealth>;
  thresholds: QueueHealthThresholds;
} {
  const [byQueue, setByQueue] = useState<Record<number, QueueHealth>>({});
  // The limits come from the course, which the classes realtime update keeps current.
  const course = useCourse();
  const thresholds = useMemo(() => parseQueueHealthThresholds(course?.office_hours_health_thresholds), [course]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const supabase = createClient();
    const load = async () => {
      // The RPC is not in the generated types yet, so the call is typed here.
      const { data, error } = await (
        supabase as unknown as {
          rpc: (fn: string, args: object) => Promise<{ data: QueueHealth[] | null; error: { message: string } | null }>;
        }
      ).rpc("office_hours_queue_health", { p_class_id: classId });
      if (cancelled || error || !data) return;
      setByQueue(Object.fromEntries(data.map((row) => [row.queue_id, row])));
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [classId, enabled]);

  return useMemo(() => ({ byQueue, thresholds }), [byQueue, thresholds]);
}
