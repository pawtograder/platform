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

// Credentials the isolate has handled: the Forgejo tokens it minted for workspaces and the short-lived
// Coder keys that write them into Coder. Error text and request URLs can carry them, so every event
// has them replaced wherever they appear. Bounded, since an isolate serves many requests.
const SECRETS: string[] = [];
const MAX_SECRETS = 200;
const REDACTED = "[redacted]";
// A Coder API key: a 10-character id, a hyphen, a 22-character secret.
const CODER_API_KEY = /\b[0-9A-Za-z]{10}-[0-9A-Za-z]{22}\b/g;

/**
 * Keeps this value out of every later Sentry event from the isolate. Call it as soon as a credential
 * is in hand, before anything that could throw.
 */
export function redactSecret(value: string): void {
  // Short values would redact ordinary text, and no credential here is that short.
  if (value.length < 16 || SECRETS.includes(value)) return;
  SECRETS.push(value);
  if (SECRETS.length > MAX_SECRETS) SECRETS.shift();
}

export function redactSecretsInText(text: string): string {
  let out = text;
  for (const secret of SECRETS) out = out.split(secret).join(REDACTED);
  return out.replace(CODER_API_KEY, REDACTED);
}

/** A copy with every string redacted. Copies, because the event shares objects with the scopes. */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = redactDeep(v, depth + 1);
  return out;
}

/**
 * Applies scrubEdgeBreadcrumb to the event's breadcrumbs and redacts credentials everywhere in it.
 * Never drops the event.
 */
export function scrubEdgeEvent<E extends Event>(event: E): E {
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubEdgeBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  }
  return redactDeep(event) as E;
}

Sentry.getGlobalScope().addEventProcessor((event) => scrubEdgeEvent(event));
