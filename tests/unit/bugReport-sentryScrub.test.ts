/**
 * @jest-environment node
 *
 * G1 (spec §7.3, ADR 3), server and edge configs: an error event reported while handling a
 * request carries no session cookie, no Authorization or Referer header, and no query string.
 *
 * `integrations: []` adds to the SDK's default integrations, and the default RequestData copies
 * the whole request onto the event. This loads sentry.server.config.ts and sentry.edge.config.ts
 * with `Sentry.init` intercepted, starts the real SDK for each runtime with the options they
 * passed, captures an error the way Next's request wrappers do (the request goes into
 * `normalizedRequest`), and inspects the serialized envelope.
 */
import * as SentryCore from "@sentry/core";
import { sessionLeaks } from "../e2e/bugReport/sessionLeaks";

const USER_EMAIL = "g1-scrub-canary@example.edu";
const USER_NAME = "Canary Scrubperson";

function fakeJwt(claims: Record<string, unknown> = { sub: "u", email: USER_EMAIL }): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJl`;
}

function sessionCookie(): string {
  const session = {
    access_token: fakeJwt(),
    refresh_token: "r3fr3sh",
    user: { email: USER_EMAIL, user_metadata: { name: USER_NAME } }
  };
  return `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}; other=1`;
}

type InitOptions = Record<string, unknown>;

function loadConfig(file: string, runtime: string): InitOptions {
  let captured: InitOptions | undefined;
  jest.isolateModules(() => {
    jest.doMock("@sentry/nextjs", () => ({
      ...jest.requireActual(runtime),
      init: (options: InitOptions) => {
        captured = options;
      }
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(file);
  });
  jest.dontMock("@sentry/nextjs");
  if (!captured) throw new Error(`${file} did not call Sentry.init`);
  return captured;
}

async function captureRequestError(runtime: string, options: InitOptions): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sentry = require(runtime) as typeof import("@sentry/node");
  const sent: string[] = [];
  Sentry.init({
    ...options,
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
  Sentry.withScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        method: "GET",
        url: "https://app.example/course/1/office-hours/search?q=jane.doe%40example.edu#frag",
        query_string: "q=jane.doe%40example.edu",
        headers: {
          cookie: sessionCookie(),
          authorization: `Bearer ${fakeJwt()}`,
          referer: `https://app.example/course/1/manage?student=${encodeURIComponent(USER_NAME)}`,
          "user-agent": "jest-agent"
        }
      }
    });
    scope.setContext("nextjs", { request_path: "/course/1/office-hours/search?q=jane", router_kind: "App Router" });
    Sentry.captureException(new Error("g1 scrub boom"));
  });
  await Sentry.flush(2000);
  await Sentry.close(2000);
  const envelope = sent.find((s) => s.includes("g1 scrub boom"));
  if (!envelope) throw new Error(`no error envelope was sent (${sent.length} envelopes)`);
  // ContextLines copies this file's own source, canaries included, into the stack frames.
  const [header, itemHeader, payload] = envelope.split("\n");
  const event = JSON.parse(payload) as { exception?: { values?: { stacktrace?: unknown }[] } };
  for (const value of event.exception?.values ?? []) delete value.stacktrace;
  return [header, itemHeader, JSON.stringify(event)].join("\n");
}

describe.each([
  ["sentry.server.config.ts", "@sentry/node"],
  ["sentry.edge.config.ts", "@sentry/vercel-edge"]
])("G1: %s scrubs the request on error events", (file, runtime) => {
  let envelope: string;
  beforeAll(async () => {
    const options = loadConfig(`@/${file.replace(/\.ts$/, "")}`, runtime);
    envelope = await captureRequestError(runtime, options);
  });

  it("carries no cookie, no token, and no email", () => {
    expect(sessionLeaks(envelope, USER_EMAIL)).toEqual([]);
    expect(envelope).not.toContain(USER_NAME);
    expect(envelope).not.toContain(encodeURIComponent(USER_NAME));
  });

  it("keeps the URL without its query or fragment, and no Referer or Authorization", () => {
    const event = JSON.parse(envelope.split("\n")[2]) as {
      request?: { url?: string; headers?: Record<string, string>; query_string?: unknown };
      contexts?: { nextjs?: { request_path?: string } };
    };
    // Edge doesn't run RequestData unless the config adds it; either way no query survives.
    if (event.request?.url) expect(event.request.url).toBe("https://app.example/course/1/office-hours/search");
    expect(event.request?.query_string).toBeUndefined();
    for (const name of Object.keys(event.request?.headers ?? {})) {
      expect(["user-agent"]).toContain(name.toLowerCase());
    }
    expect(envelope).not.toMatch(/referer/i);
    expect(envelope).not.toMatch(/authorization/i);
    expect(envelope).not.toContain("jane");
    expect(event.contexts?.nextjs?.request_path).toBe("/course/1/office-hours/search");
  });
});

describe("sessionLeaks (the G1 envelope check)", () => {
  it("flags each kind of leak", () => {
    expect(sessionLeaks('{"cookies":{}}', USER_EMAIL)).toEqual(["a cookie key"]);
    expect(sessionLeaks('{"h":"sb-abc-auth-token=x"}', USER_EMAIL)).toEqual(["an sb- auth-token cookie name"]);
    expect(sessionLeaks(`{"t":"${fakeJwt({ sub: "u" })}"}`, USER_EMAIL)).toEqual(["a JWT-shaped string"]);
    for (const pad of ["", "a", "ab"]) {
      const encoded = Buffer.from(`{"email":"${pad}${USER_EMAIL}"}`).toString("base64url");
      expect(sessionLeaks(encoded, USER_EMAIL).length).toBeGreaterThan(0);
    }
    expect(sessionLeaks('{"user":{"id":"3f1d"}}', USER_EMAIL)).toEqual([]);
  });
});
