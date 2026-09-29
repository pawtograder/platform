/**
 * Scrubbing for the error events the Next server and edge runtimes send to Sentry (ADR 3: events
 * carry the user's ID and role, never a name, an email, or a session).
 *
 * `integrations: []` adds to the SDK's default integrations rather than replacing them, so the
 * server SDK runs RequestData, Http, NodeFetch, and Console. By default RequestData copies the
 * whole request onto the event: the `cookie` header and the parsed cookies (the Supabase session
 * cookie holds the access and refresh tokens, and the user's email and name in `user_metadata`),
 * the Referer, and the query string. The configs turn those off in RequestData, and `beforeSend`
 * runs `scrubErrorEvent` as a second layer in case another path fills `event.request`.
 *
 * Imports are type-only: this runs in the edge runtime as well as Node.
 */
import type { ErrorEvent } from "@sentry/nextjs";

/** Request headers `scrubRequest` keeps if some path other than RequestData sets them. */
export const SAFE_REQUEST_HEADERS: ReadonlySet<string> = new Set(["user-agent"]);

/**
 * What RequestData may copy from the incoming request: the method and the URL (whose query
 * `scrubErrorEvent` then strips). RequestData can only take all headers or none, so none.
 */
export const REQUEST_DATA_INCLUDE = {
  cookies: false,
  data: false,
  headers: false,
  ip: false,
  query_string: false,
  url: true
} as const;

/** Drops the query string, the fragment, and any user:password@ from a URL, absolute or relative. */
export function stripQueryAndFragment(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

type ScrubbableRequest = NonNullable<ErrorEvent["request"]>;

/** Removes cookies, the query, the body, and every header outside SAFE_REQUEST_HEADERS. */
export function scrubRequest(request: ScrubbableRequest): void {
  delete request.cookies;
  delete request.query_string;
  delete request.data;
  delete request.env;
  if (request.headers) {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (SAFE_REQUEST_HEADERS.has(name.toLowerCase())) kept[name] = value;
    }
    request.headers = kept;
  }
  if (typeof request.url === "string") request.url = stripQueryAndFragment(request.url);
}

/** `beforeSend` for the server and edge configs. Never drops the event. */
export function scrubErrorEvent<E extends ErrorEvent>(event: E): E {
  if (event.request) scrubRequest(event.request);
  // captureRequestError records the request path, query included, in the nextjs context.
  const nextjs = event.contexts?.nextjs as { request_path?: unknown } | undefined;
  if (nextjs && typeof nextjs.request_path === "string") {
    nextjs.request_path = stripQueryAndFragment(nextjs.request_path);
  }
  return event;
}
