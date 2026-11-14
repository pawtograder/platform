/**
 * A pass-through `window.fetch` wrapper that bug-report code can listen to.
 *
 * supabase-js captures `fetch` when a client is constructed, so a wrapper installed later
 * never sees PostgREST, RPC, or edge-function calls. This is installed at module load of the
 * recorder mount (root layout), ahead of any Supabase client, and does nothing but call the
 * original fetch until a listener subscribes: the recorder subscribes while recording (fetch
 * breadcrumbs), and package 2's ingest can subscribe for response bodies.
 *
 * No rrweb or Sentry import; it ships in the main bundle.
 */

export type FetchObservation = {
  method: string;
  url: string;
  /** 0 when the request failed without a response. */
  status: number;
  /** Milliseconds from call to response headers (or failure). */
  duration: number;
  /** The response, for listeners that need the body; clone it before reading. */
  response?: Response;
  /** The original request input, for listeners that need it. */
  input: RequestInfo | URL;
};

export type FetchListener = (observation: FetchObservation) => void;

const listeners = new Set<FetchListener>();
let installed = false;

function describeRequest(input: RequestInfo | URL, init?: RequestInit): { method: string; url: string } {
  let url: string;
  let method = init?.method;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else {
    url = input.url;
    method ??= input.method;
  }
  try {
    url = new URL(url, window.location.href).href;
  } catch {
    // Keep it as given.
  }
  return { method: (method ?? "GET").toUpperCase(), url };
}

function notify(observation: FetchObservation): void {
  for (const listener of listeners) {
    try {
      listener(observation);
    } catch {
      // A broken listener must never break the app's fetch.
    }
  }
}

/** Install the wrapper once per page load. Safe to call repeatedly and on the server (no-op). */
export function installFetchHook(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const originalFetch = window.fetch;
  const wrapped: typeof window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (listeners.size === 0) return originalFetch.call(this ?? window, input, init);
    const started = performance.now();
    const { method, url } = describeRequest(input, init);
    const pending = originalFetch.call(this ?? window, input, init);
    pending.then(
      (response) =>
        notify({ method, url, status: response.status, duration: performance.now() - started, response, input }),
      () => notify({ method, url, status: 0, duration: performance.now() - started, input })
    );
    return pending;
  };
  window.fetch = wrapped;
}

/** Subscribe to completed fetches. Returns the unsubscribe function. */
export function onFetch(listener: FetchListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
