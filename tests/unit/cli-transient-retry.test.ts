/**
 * @jest-environment node
 */

/**
 * CLI transient-retry helper.
 *
 * Used by the assessment export's per-assignment + gradebook stream
 * consumers to recover from edge-runtime CPU/wall-clock kills and gateway
 * timeouts that surface as undici "terminated" errors mid-stream.
 */

import { isTransientStreamError, withTransientRetry } from "../../cli/utils/transientRetry";

describe("isTransientStreamError", () => {
  it("matches undici 'terminated' (the local Supabase isolate-kill case)", () => {
    expect(isTransientStreamError(new TypeError("terminated"))).toBe(true);
  });

  it("matches socket-reset family of errors", () => {
    expect(isTransientStreamError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientStreamError(new Error("socket hang up"))).toBe(true);
    expect(isTransientStreamError(new Error("UND_ERR_SOCKET"))).toBe(true);
  });

  it("matches generic 'fetch failed' wrappers (Node fetch wraps lower-level errors)", () => {
    expect(isTransientStreamError(new TypeError("fetch failed"))).toBe(true);
  });

  it("matches gateway error codes 503 and 504 in messages", () => {
    expect(isTransientStreamError(new Error("HTTP 504: Gateway Timeout"))).toBe(true);
    expect(isTransientStreamError(new Error("HTTP 503: Service Unavailable"))).toBe(true);
  });

  it("matches truncated NDJSON streams (edge isolate killed before {end})", () => {
    expect(isTransientStreamError(new Error("assignment cyb1: stream ended without {end}"))).toBe(true);
  });

  it("matches edge CPU / worker limit errors", () => {
    expect(isTransientStreamError(new Error("CPU time exceeded"))).toBe(true);
    expect(isTransientStreamError(new Error("WORKER_LIMIT"))).toBe(true);
  });

  it("walks the error chain via .cause", () => {
    // undici wraps the underlying socket reset as `cause`; the visible
    // top-level message is generic, but the cause is what tells us the
    // failure is transient. Forgetting to walk the chain was the original
    // bug the helper was written to defend against.
    const cause = new Error("ECONNRESET");
    const wrapped = new TypeError("fetch failed", { cause });
    expect(isTransientStreamError(wrapped)).toBe(true);
  });

  it("does not classify auth/validation errors as transient", () => {
    expect(isTransientStreamError(new Error("Authentication failed: invalid token"))).toBe(false);
    expect(isTransientStreamError(new Error("Permission denied"))).toBe(false);
    expect(isTransientStreamError(new Error("class is required"))).toBe(false);
  });

  it("does not classify count-mismatch errors as transient (those mean data is wrong, not flaky)", () => {
    expect(
      isTransientStreamError(new Error("Stream count mismatch for scores: server reported 100 but received 95"))
    ).toBe(false);
  });

  it("handles non-Error throws without crashing", () => {
    expect(isTransientStreamError("ECONNRESET")).toBe(true);
    expect(isTransientStreamError(null)).toBe(false);
    expect(isTransientStreamError(undefined)).toBe(false);
    expect(isTransientStreamError(42)).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("returns the result on first-try success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withTransientRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and succeeds on second attempt", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new TypeError("terminated")).mockResolvedValue("recovered");
    const onRetry = jest.fn();
    const result = await withTransientRetry(fn, { baseDelayMs: 1, onRetry });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(TypeError), expect.any(Number));
  });

  it("throws non-transient errors immediately without retry", async () => {
    const err = new Error("Authentication failed");
    const fn = jest.fn().mockRejectedValue(err);
    const onRetry = jest.fn();
    await expect(withTransientRetry(fn, { baseDelayMs: 1, onRetry })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("gives up and re-throws after exhausting attempts (default 3)", async () => {
    const err = new TypeError("terminated");
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withTransientRetry(fn, { baseDelayMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects custom attempts count", async () => {
    const err = new TypeError("terminated");
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withTransientRetry(fn, { attempts: 5, baseDelayMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("uses exponential backoff between attempts", async () => {
    const err = new TypeError("terminated");
    const fn = jest.fn().mockRejectedValue(err);
    const delays: number[] = [];
    await expect(withTransientRetry(fn, { baseDelayMs: 100, onRetry: (_a, _e, d) => delays.push(d) })).rejects.toBe(
      err
    );
    // 3 attempts → 2 retries with delays 100ms (2^0) and 200ms (2^1).
    expect(delays).toEqual([100, 200]);
  });
});
