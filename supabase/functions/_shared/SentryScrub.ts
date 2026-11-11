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

/** Applies scrubEdgeBreadcrumb to the event's breadcrumbs. Never drops the event. */
export function scrubEdgeEvent<E extends Event>(event: E): E {
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubEdgeBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  }
  return event;
}

Sentry.getGlobalScope().addEventProcessor((event) => scrubEdgeEvent(event));
