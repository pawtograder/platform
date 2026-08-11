/**
 * @jest-environment node
 *
 * Node environment: next/server's NextRequest needs the global `Request`, which jsdom lacks.
 *
 * The middleware's catch used to forward `request.headers` verbatim, skipping the sanitized copy
 * the happy path builds. A client-supplied `X-User-ID` therefore survived — and downstream layouts
 * treat that header as an authenticated identity, resolved through a SERVICE-ROLE client, so RLS
 * does not catch it either. The catch was also bare (`catch {}`), so the path was invisible.
 */
import { NextRequest } from "next/server";

jest.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    throw new Error("simulated: no Supabase env / auth transport failure");
  }
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn()
}));

import { updateSession } from "@/utils/supabase/middleware";
import * as Sentry from "@sentry/nextjs";

/**
 * Next encodes middleware request-header rewrites onto the response as
 * `x-middleware-request-<name>`, with `x-middleware-override-headers` listing the names.
 */
function requestHeaderOnResponse(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name.toLowerCase()}`);
}

function overriddenHeaderNames(res: Response): string[] {
  return (res.headers.get("x-middleware-override-headers") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

describe("updateSession — failure path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("strips a client-supplied X-User-ID when the Supabase client cannot be created", async () => {
    const request = new NextRequest("https://example.test/course/1", {
      headers: {
        "X-User-ID": "11111111-2222-3333-4444-555555555555",
        "X-Keep-Me": "yes"
      }
    });

    const res = await updateSession(request);

    expect(requestHeaderOnResponse(res, "X-User-ID")).toBeNull();
    expect(overriddenHeaderNames(res)).not.toContain("x-user-id");

    // Non-vacuity: an unrelated header DOES survive, so the assertions above are detecting the
    // strip rather than a mechanism that never forwards request headers at all.
    expect(requestHeaderOnResponse(res, "X-Keep-Me")).toBe("yes");
    expect(overriddenHeaderNames(res)).toContain("x-keep-me");
  });

  it("reports the swallowed exception instead of failing silently", async () => {
    const request = new NextRequest("https://example.test/course/1");

    await updateSession(request);

    // The tag, not just the count: routing depends on it, and a regression that drops
    // `feature: middleware-session` still reports one call.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { feature: "middleware-session" }
    });
  });

  it("passes the request through rather than refusing outright", async () => {
    // Deliberately not a 503: the matcher covers /sign-in and /, so refusing here would turn a
    // transient Supabase failure into a total outage. With the header stripped, the /course
    // layouts already redirect on a missing user id.
    const request = new NextRequest("https://example.test/");

    const res = await updateSession(request);

    expect(res.status).toBeLessThan(400);
  });
});
