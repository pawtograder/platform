import "server-only";

/**
 * SSR latency/directness profiler for the server-side Supabase clients.
 *
 * Purpose: prove (or disprove) that the server-side API calls a page makes during
 * SSR are fast and go DIRECTLY to the API upstream — i.e. that any page slowness is
 * NOT the application's server-side data fetching. Enabled only when SSR_PROFILE is
 * set, so it is a zero-overhead no-op in normal operation.
 *
 * Two structured JSON log lines to stdout:
 *   {ssr_profile:"connect", host, port, remote, connect_ms}  — once per new socket:
 *       TCP+TLS connect time and the actual remote IP dialed. Proves the connection is
 *       DIRECT (and to which upstream), not proxied/slow. Absent lines ⇒ keep-alive reuse.
 *   {ssr_profile:"<tag>", method, host, path, status, dur_ms} — once per API call:
 *       full request wall time.
 *
 * Grep the web pod logs for `ssr_profile` during a load test: if every dur_ms stays
 * low and connect_ms is small while the browser sees multi-second stalls, the SSR path
 * is exonerated and the fault lies on the inbound/edge path.
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ENABLED = !!process.env.SSR_PROFILE;

// Shared undici dispatcher whose connector logs TCP+TLS connect time + remote address.
// Built lazily, only when profiling is on; falls back to default fetch if unavailable.
let dispatcherPromise: Promise<unknown | null> | undefined;
function getDispatcher(): Promise<unknown | null> {
  if (dispatcherPromise) return dispatcherPromise;
  dispatcherPromise = (async () => {
    try {
      const undici = await import("undici");
      const base = undici.buildConnector({});
      const connector: typeof base = (opts, cb) => {
        const t0 = performance.now();
        base(opts, (err, socket) => {
          // Preserve undici's discriminated callback shape ([err,null] | [null,socket]).
          if (err || !socket) {
            cb(err, null);
            return;
          }
          console.log(
            JSON.stringify({
              ssr_profile: "connect",
              host: opts.hostname,
              port: opts.port,
              remote: (socket as { remoteAddress?: string }).remoteAddress,
              connect_ms: Math.round(performance.now() - t0)
            })
          );
          cb(null, socket);
        });
      };
      return new undici.Agent({ connect: connector, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000 });
    } catch {
      return null;
    }
  })();
  return dispatcherPromise;
}

/**
 * Wrap a base fetch (default global fetch, or Next's caching fetch) with profiling.
 * Returns the base fetch unchanged when SSR_PROFILE is not set.
 */
export function withProfiling(tag: string, baseFetch: FetchLike = fetch): FetchLike {
  if (!ENABLED) return baseFetch;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method || (input instanceof Request ? input.method : "GET")) as string;
    let host = "?";
    let path = "?";
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch {
      // leave defaults
    }
    const disp = await getDispatcher();
    const finalInit: RequestInit & { dispatcher?: unknown } = disp ? { ...init, dispatcher: disp } : { ...init };

    const t0 = performance.now();
    try {
      const res = await baseFetch(input, finalInit as RequestInit);
      console.log(
        JSON.stringify({ ssr_profile: tag, method, host, path, status: res.status, dur_ms: Math.round(performance.now() - t0) })
      );
      return res;
    } catch (e) {
      console.log(
        JSON.stringify({ ssr_profile: tag, method, host, path, error: (e as Error)?.message, dur_ms: Math.round(performance.now() - t0) })
      );
      throw e;
    }
  };
}
