import { computeQueueHealth } from "@/lib/queueHealth";

const NOW = Date.parse("2026-11-23T20:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

const queues = [
  { id: 1, name: "Main", is_active: true },
  { id: 2, name: "Closed", is_active: false }
];

describe("computeQueueHealth", () => {
  it("leaves out inactive queues", () => {
    const health = computeQueueHealth(queues, [{ help_queue: 2, status: "open", created_at: ago(60) }], [], NOW);
    expect(Object.keys(health)).toEqual(["1"]);
  });

  it("counts waiting and helping requests, and times the oldest open one", () => {
    const health = computeQueueHealth(
      queues,
      [
        { help_queue: 1, status: "open", created_at: ago(120) },
        { help_queue: 1, status: "open", created_at: ago(600) },
        { help_queue: 1, status: "in_progress", created_at: ago(900) },
        { help_queue: 1, status: "resolved", created_at: ago(5000) }
      ],
      [{ help_queue_id: 1, ended_at: null }],
      NOW
    );
    expect(health[1]).toMatchObject({ waiting: 2, oldest_wait_seconds: 600, helping: 1, staffed_tas: 1 });
    expect(health[1].unstaffed_seconds).toBeNull();
  });

  it("counts a shift with no ended_at as staffed", () => {
    const health = computeQueueHealth(
      queues,
      [],
      [
        { help_queue_id: 1, ended_at: null },
        { help_queue_id: 1, ended_at: ago(30) }
      ],
      NOW
    );
    expect(health[1].staffed_tas).toBe(1);
    expect(health[1].unstaffed_seconds).toBeNull();
  });

  it("reports how long since the last shift ended when nobody is on shift", () => {
    const health = computeQueueHealth(
      queues,
      [],
      [
        { help_queue_id: 1, ended_at: ago(3600) },
        { help_queue_id: 1, ended_at: ago(300) }
      ],
      NOW
    );
    expect(health[1]).toMatchObject({ staffed_tas: 0, unstaffed_seconds: 300 });
  });

  it("reports no unstaffed time for a queue that never had a shift", () => {
    expect(computeQueueHealth(queues, [], [], NOW)[1].unstaffed_seconds).toBeNull();
  });
});
