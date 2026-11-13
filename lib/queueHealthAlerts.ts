import type { QueueHealth, QueueHealthThresholds } from "@/hooks/useQueueHealth";

/**
 * A queue is red when the waiting count reaches the class's limit, or when the oldest wait does.
 * Same rule the staff cards use to color the numbers, so the alert and the card agree.
 */
export function isQueueRed(health: QueueHealth, thresholds: QueueHealthThresholds): boolean {
  if (health.waiting >= thresholds.waiting_red) return true;
  return health.waiting > 0 && health.oldest_wait_seconds >= thresholds.oldest_wait_red_minutes * 60;
}

/** Queues that are red now but were not red at the last check. */
export function queuesTurnedRed(
  wasRed: ReadonlyMap<number, boolean>,
  healthByQueue: Record<number, QueueHealth>,
  thresholds: QueueHealthThresholds
): QueueHealth[] {
  return Object.values(healthByQueue).filter((h) => isQueueRed(h, thresholds) && !wasRed.get(h.queue_id));
}
