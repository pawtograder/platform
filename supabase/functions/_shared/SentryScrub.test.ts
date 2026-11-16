import { assert, assertEquals } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  redactSecret,
  redactSecretsInText,
  scrubEdgeBreadcrumb,
  scrubEdgeEvent,
  stripQueryAndFragment
} from "./SentryScrub.ts";

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

// Built at runtime for the same reason as above.
const forgejoToken = ["0123456789abcdef", "0123456789abcdef", "01234567"].join("");
const coderKey = ["AbCdE12345", "-", "abcdefghijklmnopqrstuv"].join("");

Deno.test("a registered credential is redacted anywhere in the event, and the original is untouched", () => {
  redactSecret(forgejoToken);
  const breadcrumb = { category: "github", message: `pushed with ${forgejoToken}` };
  const event = {
    message: `clone https://x:${forgejoToken}@git.example.invalid/ failed`,
    exception: { values: [{ type: "Error", value: `Coder said ${coderKey}` }] },
    extra: { nested: [{ deep: forgejoToken }] },
    breadcrumbs: [breadcrumb]
  };
  const out = scrubEdgeEvent(structuredClone(event));
  const text = JSON.stringify(out);
  assert(!text.includes(forgejoToken), text);
  assert(!text.includes(coderKey), text);
  assertEquals(out.message, "clone https://x:[redacted]@git.example.invalid/ failed");
  assertEquals(breadcrumb.message, `pushed with ${forgejoToken}`);
});

Deno.test("redactSecretsInText leaves ordinary text, UUIDs and short values alone", () => {
  redactSecret("short");
  const text = "user 7d1c7c9e-0000-4000-8000-000000000001 opened repo-42 (short)";
  assertEquals(redactSecretsInText(text), text);
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
