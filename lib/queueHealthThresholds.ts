export type QueueHealthThresholds = {
  /** The waiting count turns red at this many students or more. */
  waiting_red: number;
  /** The oldest wait turns red at this many minutes or more. */
  oldest_wait_red_minutes: number;
};

export const DEFAULT_QUEUE_HEALTH_THRESHOLDS: QueueHealthThresholds = { waiting_red: 5, oldest_wait_red_minutes: 30 };

/** Reads the class's stored limits, falling back to the defaults for anything missing or malformed. */
export function parseQueueHealthThresholds(value: unknown): QueueHealthThresholds {
  if (!value || typeof value !== "object") return DEFAULT_QUEUE_HEALTH_THRESHOLDS;
  const stored = value as Partial<Record<keyof QueueHealthThresholds, unknown>>;
  // Only positive, finite numbers count. Zero or a negative limit would mark every queue red.
  const waiting =
    typeof stored.waiting_red === "number" && Number.isFinite(stored.waiting_red) && stored.waiting_red > 0
      ? stored.waiting_red
      : DEFAULT_QUEUE_HEALTH_THRESHOLDS.waiting_red;
  const minutes =
    typeof stored.oldest_wait_red_minutes === "number" &&
    Number.isFinite(stored.oldest_wait_red_minutes) &&
    stored.oldest_wait_red_minutes > 0
      ? stored.oldest_wait_red_minutes
      : DEFAULT_QUEUE_HEALTH_THRESHOLDS.oldest_wait_red_minutes;
  return { waiting_red: waiting, oldest_wait_red_minutes: minutes };
}
