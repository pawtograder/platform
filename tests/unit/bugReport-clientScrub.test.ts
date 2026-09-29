/**
 * @jest-environment jsdom
 *
 * G1 (spec §7.3, ADR 3), browser half: error events from instrumentation-client.ts carry no name,
 * email, or query. The SDK's default integrations record click targets as selectors with
 * aria-label/title/alt/name text, fetch/xhr/navigation URLs with their queries, and console text,
 * and HttpContext copies the page URL and the Referer onto every event.
 *
 * instrumentation-client.ts can't import lib/bugReport/sentryScrub.ts, so it has its own copy of
 * the rules. This loads the file with `Sentry.init` intercepted, runs its beforeBreadcrumb over
 * the same cases as the server module's, and then starts the real browser SDK with its options
 * and checks the envelope an error produces after a click, a navigation, and a console call.
 */
import * as SentryCore from "@sentry/core";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { scrubBreadcrumb as serverScrubBreadcrumb, scrubErrorEvent } from "@/lib/bugReport/sentryScrub";

const EMAIL = "jane.clientscrub@example.edu";
const NAME = "Jane Clientscrub";

type InitOptions = {
  beforeBreadcrumb: (b: Breadcrumb) => Breadcrumb | null;
  beforeSend: (e: ErrorEvent) => ErrorEvent | null;
} & Record<string, unknown>;

let clientOptions: InitOptions;

jest.mock("posthog-js", () => ({ __esModule: true, default: { init: jest.fn() } }));

beforeAll(() => {
  const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
  jest.isolateModules(() => {
    jest.doMock("@sentry/nextjs", () => ({
      ...jest.requireActual("@sentry/browser"),
      init: (options: InitOptions) => {
        clientOptions = options;
      }
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/instrumentation-client");
  });
  jest.dontMock("@sentry/nextjs");
  quiet.mockRestore();
});

const cases: [string, Breadcrumb, Breadcrumb | null][] = [
  [
    "a click on a row labelled with a name and a button titled with an email",
    {
      category: "ui.click",
      message: `table > tr[aria-label="Student ${NAME} grades"] > td > button[type="button"][title="${EMAIL}"]`
    },
    { category: "ui.click", message: `table > tr > td > button[type="button"]` }
  ],
  [
    "alt, name, placeholder, value, and data-* selectors",
    {
      category: "ui.input",
      message: `img[alt="${NAME}"] input[name="email"][placeholder="${EMAIL}"][value='x'][data-student="${NAME}"]`
    },
    { category: "ui.input", message: "img input" }
  ],
  [
    "a selector cut off mid-value by the serializer's length limit",
    { category: "ui.click", message: `div > span[title="${NAME.slice(0, 6)}` },
    { category: "ui.click", message: "div > span" }
  ],
  [
    "a fetch with a PostgREST filter",
    {
      category: "fetch",
      data: { method: "GET", url: `https://api.example/rest/v1/users?email=in.(${EMAIL})`, status_code: 200 }
    },
    { category: "fetch", data: { method: "GET", url: "https://api.example/rest/v1/users", status_code: 200 } }
  ],
  [
    "a server http breadcrumb with query and fragment fields",
    {
      category: "http",
      data: { url: "https://api.example/rest/v1/users", "http.query": `?email=eq.${EMAIL}`, "http.fragment": "#x" }
    },
    { category: "http", data: { url: "https://api.example/rest/v1/users" } }
  ],
  [
    "a navigation",
    {
      category: "navigation",
      data: { from: `/course/1/office-hours/search?q=${EMAIL}`, to: `/course/1/manage#student=${NAME}` }
    },
    { category: "navigation", data: { from: "/course/1/office-hours/search", to: "/course/1/manage" } }
  ],
  [
    "a message with a URL",
    { category: "xhr", message: `GET https://api.example/x?name=${encodeURIComponent(NAME)} failed` },
    { category: "xhr", message: "GET https://api.example/x failed" }
  ],
  ["a console call", { category: "console", level: "log", message: `loaded ${EMAIL}` }, null],
  [
    "an unrelated breadcrumb, untouched",
    { category: "supabase.realtime", message: "channel joined" },
    { category: "supabase.realtime", message: "channel joined" }
  ]
];

describe("breadcrumb scrubbing: the server module and the client's inline copy agree", () => {
  it.each(cases)("%s", (_label, input, expected) => {
    expect(serverScrubBreadcrumb(structuredClone(input))).toEqual(expected);
    expect(clientOptions.beforeBreadcrumb(structuredClone(input))).toEqual(expected);
  });
});

describe("the client's beforeSend", () => {
  it("strips the page URL's query and fragment and drops the Referer", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ type: "Error", value: "boom" }] },
      request: {
        url: `https://app.example/course/1/office-hours/search?q=${EMAIL}#top`,
        headers: { Referer: `https://app.example/course/1/manage?student=${NAME}`, "User-Agent": "jsdom" }
      },
      breadcrumbs: [{ category: "console", message: EMAIL }]
    };
    const out = clientOptions.beforeSend(structuredClone(event));
    expect(out?.request).toEqual({
      url: "https://app.example/course/1/office-hours/search",
      headers: { "User-Agent": "jsdom" }
    });
    expect(out?.breadcrumbs).toEqual([]);
    // The server scrub is stricter (allowlisted headers only) but agrees on these.
    expect(scrubErrorEvent(structuredClone(event)).request).toEqual(out?.request);
  });

  it("still drops the noise it filtered before", () => {
    const event = { exception: { values: [{ type: "TypeError", value: "Failed to fetch" }] } } as ErrorEvent;
    expect(clientOptions.beforeSend(event)).toBeNull();
  });
});

describe("the real browser SDK with the client's options", () => {
  it("sends an error event with no name, email, or query", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/browser") as typeof import("@sentry/browser");
    document.body.innerHTML = `<table><tr aria-label="Student ${NAME} grades"><td><button type="button" title="${EMAIL}">x</button></td></tr></table>`;
    Object.defineProperty(document, "referrer", {
      value: `https://app.example/course/1/manage?student=${encodeURIComponent(NAME)}`,
      configurable: true
    });
    window.history.pushState({}, "", `/course/1/office-hours/search?q=${encodeURIComponent(EMAIL)}`);

    const sent: string[] = [];
    Sentry.init({
      ...clientOptions,
      tunnel: undefined,
      dsn: "http://public@127.0.0.1:9/1",
      transport: () => ({
        send: async (envelope) => {
          const bytes = SentryCore.serializeEnvelope(envelope);
          sent.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
          return {};
        },
        flush: async () => true
      })
    });
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.history.pushState({}, "", `/course/1/manage?student=${encodeURIComponent(NAME)}`);
    // eslint-disable-next-line no-console -- the Console integration turns this into a breadcrumb
    console.log(`student ${EMAIL}`);
    Sentry.captureException(new Error("client scrub boom"));
    await Sentry.flush(2000);

    const envelope = sent.find((s) => s.includes("client scrub boom"));
    expect(envelope).toBeDefined();
    const event = JSON.parse(envelope!.split("\n")[2]) as ErrorEvent;
    for (const value of event.exception?.values ?? []) delete value.stacktrace;
    const text = JSON.stringify(event);
    // The click and the navigation made it, just without the text.
    expect(event.breadcrumbs?.map((b) => b.category)).toEqual(expect.arrayContaining(["ui.click", "navigation"]));
    expect(event.breadcrumbs?.some((b) => b.category === "console")).toBe(false);
    expect(event.request?.url).toBe("http://localhost/course/1/manage");
    expect(Object.keys(event.request?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("referer");
    for (const leak of [EMAIL, encodeURIComponent(EMAIL), NAME, encodeURIComponent(NAME), "Clientscrub"]) {
      expect(text).not.toContain(leak);
    }
    await Sentry.close(2000);
  });
});
