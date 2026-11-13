import { isQueueRed, queuesTurnedRed } from "@/lib/queueHealthAlerts";
import type { QueueHealth } from "@/hooks/useQueueHealth";

const T = { waiting_red: 5, oldest_wait_red_minutes: 30 };
const h = (over: Partial<QueueHealth>): QueueHealth => ({
  queue_id: 1,
  queue_name: "Q",
  waiting: 0,
  oldest_wait_seconds: 0,
  helping: 0,
  staffed_tas: 1,
  unstaffed_seconds: null,
  resolved_today: 0,
  median_wait_seconds_today: 0,
  ...over
});

describe("isQueueRed", () => {
  it("is red at the waiting limit", () => expect(isQueueRed(h({ waiting: 5 }), T)).toBe(true));
  it("is not red just under the waiting limit", () =>
    expect(isQueueRed(h({ waiting: 4, oldest_wait_seconds: 60 }), T)).toBe(false));
  it("is red when the oldest wait reaches the limit", () =>
    expect(isQueueRed(h({ waiting: 1, oldest_wait_seconds: 1800 }), T)).toBe(true));
  it("ignores an oldest wait when nobody is waiting", () =>
    expect(isQueueRed(h({ waiting: 0, oldest_wait_seconds: 9999 }), T)).toBe(false));
});

describe("queuesTurnedRed", () => {
  it("returns only queues that just went red", () => {
    const wasRed = new Map([
      [1, true],
      [2, false]
    ]);
    const byQueue = {
      1: h({ queue_id: 1, waiting: 6 }),
      2: h({ queue_id: 2, waiting: 6 }),
      3: h({ queue_id: 3, waiting: 1 })
    };
    expect(queuesTurnedRed(wasRed, byQueue, T).map((q) => q.queue_id)).toEqual([2]);
  });
});
