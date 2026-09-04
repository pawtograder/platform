/**
 * refreshWorkflowMetrics() throttle (lib/metrics.ts).
 *
 * The throttle is the only bound on how often /api/metrics hits the database
 * that survives things the chart cannot control: a second Prometheus, a
 * hand-edited ServiceMonitor, or an operator running a curl loop. The scrape
 * interval is a cluster-side setting; this is ours. These tests assert the four
 * properties that make it correct rather than merely present:
 *
 *   1. a second call inside the interval issues NO RPCs;
 *   2. a call after the interval does;
 *   3. a FAILED refresh does not advance the timestamp (otherwise one bad
 *      minute of database backs the leader off for five, and the gauges go flat
 *      in a way that is indistinguishable from "nothing ran");
 *   4. an interval of 0 disables throttling;
 *   5. two CONCURRENT calls share one pass. The timestamp throttle alone is a
 *      check-then-act race: both callers read the old timestamp before either
 *      finishes and both run all five aggregates, which is exactly the
 *      multiplied DB load the throttle exists to bound. A second Prometheus or
 *      an overlapping curl loop reaches this every time;
 *   6. a FAILED pass still clears the in-flight promise, so one rejection does
 *      not wedge every future refresh.
 *
 * The Supabase admin client is mocked at the module boundary so no test here
 * touches a database.
 */

const rpc = jest.fn();

jest.mock("@/utils/supabase/client", () => ({
  createAdminClient: () => ({ rpc })
}));

type GlobalWithMetrics = typeof globalThis & {
  __pawtograderMetrics?: { lastWorkflowRefreshMs: number; workflowRefreshInFlight?: Promise<void> };
};

// Every RPC resolves successfully with no rows unless a test says otherwise.
// Empty data is enough: the point under test is whether the call happens.
function rpcSucceeds() {
  rpc.mockResolvedValue({ data: [], error: null });
}

function rpcFails() {
  rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "57014" } });
}

async function loadMetrics() {
  // Fresh module registry per test so the prom-client registry (and the
  // lastWorkflowRefreshMs it carries) starts clean.
  let mod!: typeof import("@/lib/metrics");
  await jest.isolateModulesAsync(async () => {
    mod = await import("@/lib/metrics");
  });
  return mod;
}

describe("refreshWorkflowMetrics throttle", () => {
  const OLD_ENV = process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS;

  beforeEach(() => {
    rpc.mockReset();
    rpcSucceeds();
    delete (globalThis as GlobalWithMetrics).__pawtograderMetrics;
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    if (OLD_ENV === undefined) {
      delete process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS;
    } else {
      process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = OLD_ENV;
    }
  });

  it("issues no RPCs on a second call inside the interval", async () => {
    process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = "300";
    const { refreshWorkflowMetrics } = await loadMetrics();

    await refreshWorkflowMetrics();
    const first = rpc.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    // 299s later: still inside the window.
    jest.setSystemTime(Date.now() + 299_000);
    await refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(first);
  });

  it("issues RPCs again once the interval has elapsed", async () => {
    process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = "300";
    const { refreshWorkflowMetrics } = await loadMetrics();

    await refreshWorkflowMetrics();
    const first = rpc.mock.calls.length;

    jest.setSystemTime(Date.now() + 301_000);
    await refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(first * 2);
  });

  it("does not advance the timestamp when the refresh fails", async () => {
    process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = "300";
    const { refreshWorkflowMetrics } = await loadMetrics();

    rpcFails();
    await refreshWorkflowMetrics();
    const first = rpc.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect((globalThis as GlobalWithMetrics).__pawtograderMetrics?.lastWorkflowRefreshMs).toBe(0);

    // Immediately afterwards — well inside the interval — a broken database must
    // be RETRIED, not backed off. This is the whole point: a failed refresh that
    // advanced the clock would turn a transient error into five minutes of
    // silently frozen gauges.
    rpcSucceeds();
    jest.setSystemTime(Date.now() + 1_000);
    await refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(first * 2);

    // ...and the successful pass DOES arm the throttle.
    expect((globalThis as GlobalWithMetrics).__pawtograderMetrics?.lastWorkflowRefreshMs).toBe(Date.now());
  });

  it("runs ONE pass when two callers arrive concurrently", async () => {
    process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = "300";
    const { refreshWorkflowMetrics } = await loadMetrics();

    // Hold every RPC open so both callers are inside refreshWorkflowMetrics()
    // at the same time — the race is only observable while a pass is running.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rpc.mockImplementation(async () => {
      await gate;
      return { data: [], error: null };
    });

    const a = refreshWorkflowMetrics();
    const b = refreshWorkflowMetrics();
    // Let both reach the await before anything resolves.
    await Promise.resolve();
    release();
    await Promise.all([a, b]);

    // Five aggregate RPCs, issued once — not ten.
    expect(rpc.mock.calls.length).toBe(5);
    expect((globalThis as GlobalWithMetrics).__pawtograderMetrics?.lastWorkflowRefreshMs).toBe(Date.now());

    // The second caller must have WAITED for the pass rather than skipping it:
    // a scrape that returns before the registry is populated exports an empty
    // body, which reads on a dashboard exactly like "this pod is not scraped".
    rpc.mockReset();
    rpcSucceeds();
    jest.setSystemTime(Date.now() + 301_000);
    await refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(5);
  });

  it("clears the in-flight pass when the refresh throws", async () => {
    process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = "300";
    const { refreshWorkflowMetrics } = await loadMetrics();

    // Reject rather than resolve with { error }: this is the path where
    // Promise.allSettled is not what catches it, so it exercises the finally.
    rpc.mockRejectedValue(new Error("connection refused"));
    await expect(refreshWorkflowMetrics()).resolves.toBeUndefined();
    expect((globalThis as GlobalWithMetrics).__pawtograderMetrics?.workflowRefreshInFlight).toBeUndefined();
    expect((globalThis as GlobalWithMetrics).__pawtograderMetrics?.lastWorkflowRefreshMs).toBe(0);

    // A wedged in-flight promise would make every later refresh a no-op.
    rpc.mockReset();
    rpcSucceeds();
    await refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(5);
  });

  it("disables throttling when the interval is 0", async () => {
    process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = "0";
    const { refreshWorkflowMetrics } = await loadMetrics();

    await refreshWorkflowMetrics();
    const first = rpc.mock.calls.length;

    // No clock movement at all.
    await refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(first * 2);
  });

  it("falls back to the 300s default when the env var is absent or unparseable", async () => {
    delete process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS;
    const { refreshWorkflowMetrics, DEFAULT_WORKFLOW_REFRESH_INTERVAL_SECONDS } = await loadMetrics();
    expect(DEFAULT_WORKFLOW_REFRESH_INTERVAL_SECONDS).toBe(300);

    await refreshWorkflowMetrics();
    const first = rpc.mock.calls.length;
    jest.setSystemTime(Date.now() + 299_000);
    await refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(first);

    // A typo must fall back to the default, not to 0 — silently removing the
    // only bound on refresh frequency is the worse failure.
    delete (globalThis as GlobalWithMetrics).__pawtograderMetrics;
    process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS = "five minutes";
    const again = await loadMetrics();
    rpc.mockClear();
    await again.refreshWorkflowMetrics();
    const n = rpc.mock.calls.length;
    jest.setSystemTime(Date.now() + 299_000);
    await again.refreshWorkflowMetrics();
    expect(rpc.mock.calls.length).toBe(n);
  });
});
