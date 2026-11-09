import { assert, assertEquals } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { scrubEdgeBreadcrumb, stripQueryAndFragment } from "./SentryScrub.ts";

// Built at runtime so the values never appear in this file's source: the ContextLines integration
// copies source lines around a stack frame into the event.
const address = ["scrub-probe", "example.invalid"].join("@");
const personName = ["Probe", "Scrubperson"].join(" ");

Deno.test("console breadcrumbs are dropped", () => {
  assertEquals(scrubEdgeBreadcrumb({ category: "console", message: `Creating user ${address}` }), null);
});

Deno.test("fetch breadcrumbs keep the URL without its query or fragment", () => {
  const input = {
    category: "fetch",
    data: { method: "GET", url: `https://db.example.invalid/rest/v1/users?email=eq.${address}#x`, status_code: 200 }
  };
  const out = scrubEdgeBreadcrumb(structuredClone(input));
  assertEquals(out, {
    category: "fetch",
    data: { method: "GET", url: "https://db.example.invalid/rest/v1/users", status_code: 200 }
  });
});

Deno.test("other breadcrumbs pass through unchanged", () => {
  const input = { category: "github", message: "Reinviting user to team" };
  assertEquals(scrubEdgeBreadcrumb(input), input);
});

Deno.test("stripQueryAndFragment drops credentials too", () => {
  assertEquals(stripQueryAndFragment("https://u:p@h.example.invalid/a?b=c#d"), "https://h.example.invalid/a");
  assertEquals(stripQueryAndFragment("/rest/v1/rpc/x?a=1"), "/rest/v1/rpc/x");
});

Deno.test("events from a later Sentry.init carry no console text or URL query", async () => {
  const sent: string[] = [];
  const options = {
    dsn: "https://publickey@sentry.example.invalid/1",
    integrations: [],
    transport: () => ({
      send: (envelope: unknown) => {
        sent.push(JSON.stringify(envelope));
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true)
    })
  };
  // Two inits, as in a function that calls Sentry.init after SentryInit.ts did: the second client
  // replaces the first, and the scrub still applies because it lives on the global scope.
  Sentry.init(options);
  Sentry.init(options);
  try {
    console.log("Creating user", address, personName);
    Sentry.addBreadcrumb({
      category: "fetch",
      data: { method: "GET", url: `https://db.example.invalid/rest/v1/users?email=eq.${address}` }
    });
    Sentry.captureException(new Error("probe failure"), new Sentry.Scope());
    await Sentry.flush(2000);
    assertEquals(sent.length, 1);
    assert(!sent[0].includes(address), "the address reached the envelope");
    assert(!sent[0].includes(personName), "the name reached the envelope");
    assert(sent[0].includes("https://db.example.invalid/rest/v1/users"), "the fetch breadcrumb itself is kept");
  } finally {
    await Sentry.close();
  }
});
