/**
 * Test-side control of the Discord mock.
 *
 * Reads the mock's base URL from DISCORD_MOCK_URL and defaults to http://127.0.0.1:8788, the port
 * server.ts listens on. Nothing here imports the server at runtime, so a spec can talk to a mock
 * started by any means -- a background `npx tsx tests/mocks/discord/server.ts`, a Playwright
 * webServer entry, or a globalSetup that starts it in-process.
 *
 * Every function throws on a non-2xx control-plane response. A test that cannot reach the mock
 * should fail loudly rather than quietly assert against an empty call log, which would pass.
 */

import type { MockState } from "./state";
import type { CallLogEntry } from "./server";

export type { CallLogEntry } from "./server";
export type { FaultRule, MockState } from "./state";

/** The mock's own root, where the /__mock/ control plane lives. */
export function mockBaseUrl(): string {
  return (process.env.DISCORD_MOCK_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
}

/** The value to put in DISCORD_API_BASE_URL so edge functions send Discord traffic to the mock. */
export function discordApiBaseUrl(): string {
  return `${mockBaseUrl()}/api/v10`;
}

async function control<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${mockBaseUrl()}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Discord mock control ${method} ${path} failed: ${response.status} ${text}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** Clear the world and the call log back to the `healthy` scenario. */
export async function resetMock(): Promise<MockState> {
  const result = await control<{ state: MockState }>("POST", "/__mock/reset");
  return result.state;
}

/**
 * Apply a named scenario, clearing the call log with it.
 *
 * Names come from state.ts; `listScenarios()` reads them off the running mock.
 */
export async function setScenario(name: string): Promise<MockState> {
  const result = await control<{ state: MockState }>("POST", `/__mock/scenario/${encodeURIComponent(name)}`);
  return result.state;
}

/**
 * Patch the world. Objects merge key by key, arrays and scalars replace.
 *
 * Pass `{ replace: true, state: {...} }` to start from an empty world instead of the current one.
 */
export async function setState(patch: Record<string, unknown>): Promise<MockState> {
  const result = await control<{ state: MockState }>("POST", "/__mock/state", patch);
  return result.state;
}

export async function getState(): Promise<MockState> {
  return await control<MockState>("GET", "/__mock/state");
}

/** Every Discord request the mock has answered, oldest first. Control calls are not included. */
export async function getCalls(): Promise<CallLogEntry[]> {
  return await control<CallLogEntry[]>("GET", "/__mock/calls");
}

export async function clearCalls(): Promise<number> {
  const result = await control<{ cleared: number }>("DELETE", "/__mock/calls");
  return result.cleared;
}

export async function listScenarios(): Promise<string[]> {
  const result = await control<{ scenarios: string[] }>("GET", "/__mock/scenarios");
  return result.scenarios;
}

/** True once the mock answers its health endpoint. Poll this before starting a run. */
export async function waitForMock(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      await control<{ ok: boolean }>("GET", "/__mock/health");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Discord mock at ${mockBaseUrl()} did not become ready in ${timeoutMs}ms: ${lastError}`);
}

/**
 * Wait for a request matching `predicate`, and return it.
 *
 * The error on timeout carries the whole call log. An assertion that a role was assigned fails for
 * two very different reasons -- the request never happened, or it happened and was refused -- and
 * the log is what tells them apart, so it is worth printing rather than making someone re-run.
 */
export async function waitForCall(
  predicate: (call: CallLogEntry) => boolean,
  timeoutMs = 10_000
): Promise<CallLogEntry> {
  const deadline = Date.now() + timeoutMs;
  let seen: CallLogEntry[] = [];
  while (Date.now() < deadline) {
    seen = await getCalls();
    const match = seen.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const dump = seen.map((call) => `  ${call.status} ${call.method} ${call.path}`).join("\n");
  throw new Error(
    `No Discord call matched the predicate within ${timeoutMs}ms. ${seen.length} call(s) logged:\n${dump}`
  );
}
