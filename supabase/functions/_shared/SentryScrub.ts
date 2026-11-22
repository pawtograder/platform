// Keeps console text and URL queries out of edge-function Sentry events. Bug reporter ADR 3: events
// identify a user by Pawtograder ID and role only, never by name or email.
//
// The Deno SDK's default Breadcrumbs integration records every console call, arguments included,
// and every fetch with its full URL, PostgREST filters included. It stores them on the isolation
// scope, which in @sentry/deno 10.10 is one object for the whole isolate (there is no async-context
// strategy). Edge code logs addresses and names: createUserInClass logs "Creating user <email>",
// and the notification worker logs "Sending email to <address> with subject <subject>". Without
// this scrub, those lines ride on every later event in the isolate, other users' included.
//
// The scrub is a global-scope event processor, not a `beforeBreadcrumb` option. Several functions
// call Sentry.init themselves after SentryInit.ts has, and each init replaces the client and its
// options. Global-scope processors run for every client's events. The rules match
// lib/bugReport/sentryScrub.ts, the scrub for the Next server and edge runtimes; edge functions
// can't import it.
//
// Importing this module installs the processor. SentryInit.ts imports it, so does every function
// that loads HandlerUtils.ts. A function that calls Sentry.init without loading either imports it
// directly.
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { Breadcrumb, Event } from "npm:@sentry/deno@10.10.0";

const URL_CATEGORIES = new Set(["fetch", "xhr", "http", "navigation", "history"]);
const URL_DATA_KEYS = ["url", "from", "to"] as const;

/** Drops the query string, the fragment, and any user:password@ from a URL, absolute or relative. */
export function stripQueryAndFragment(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/**
 * The breadcrumb without console text or URL queries, or null to drop it. Returns a copy: the
 * breadcrumbs on an event are the same objects the isolation scope keeps.
 */
export function scrubEdgeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const category = breadcrumb.category ?? "";
  // Console text is whatever the code logged, rows and addresses included.
  if (category === "console") return null;
  if (!URL_CATEGORIES.has(category)) return breadcrumb;
  const scrubbed: Breadcrumb = { ...breadcrumb };
  if (breadcrumb.data) {
    const data = { ...breadcrumb.data };
    for (const key of URL_DATA_KEYS) {
      const value = data[key];
      if (typeof value === "string") data[key] = stripQueryAndFragment(value);
    }
    delete data["http.query"];
    delete data["http.fragment"];
    scrubbed.data = data;
  }
  if (typeof breadcrumb.message === "string") {
    scrubbed.message = breadcrumb.message.replace(/[?#][^\s"'<>]*/g, "");
  }
  return scrubbed;
}

// No cap: an evicted credential would reach Sentry unredacted, and Forgejo tokens have no pattern
// to fall back on. The set lives only as long as the isolate.
const SECRETS = new Set<string>();
const REDACTED = "[redacted]";
const CODER_API_KEY = /\b[0-9A-Za-z]{10}-[0-9A-Za-z]{22}\b/g;

/** Call as soon as a credential is in hand, before anything that could throw. */
export function redactSecret(value: string): void {
  if (value.length < 16) return;
  SECRETS.add(value);
}

export function redactSecretsInText(text: string): string {
  let out = text;
  for (const secret of SECRETS) out = out.split(secret).join(REDACTED);
  return out.replace(CODER_API_KEY, REDACTED);
}

const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";
const MAX_DEPTH = 20;

/**
 * Copies: the event shares objects with the scopes. Processors run before the SDK's cycle-aware normalize, so
 * this tracks identity itself: an object already on the path is a cycle, and an object reached again by another
 * path reuses its copy. Without that, a small object referring to itself from a few keys is copied once per
 * path, exponentially many times up to the depth limit. An object past the limit becomes a marker, never the
 * original: its strings were not redacted, and a copy holding it could be reused where more depth was left.
 */
function redactDeep(value: unknown, depth = 0, copies = new Map<object, unknown>(), path = new Set<object>()): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (path.has(value)) return CIRCULAR;
  if (copies.has(value)) return copies.get(value);
  path.add(value);
  let out: unknown;
  if (Array.isArray(value)) out = value.map((v) => redactDeep(v, depth + 1, copies, path));
  else {
    const copy: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) copy[key] = redactDeep(v, depth + 1, copies, path);
    out = copy;
  }
  path.delete(value);
  copies.set(value, out);
  return out;
}

export function scrubEdgeEvent<E extends Event>(event: E): E {
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubEdgeBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  }
  return redactDeep(event) as E;
}

Sentry.getGlobalScope().addEventProcessor((event) => scrubEdgeEvent(event));
