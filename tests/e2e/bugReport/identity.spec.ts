import { expect, test } from "@playwright/test";
import { createClass, createUsersInClass, loginAsUser, type TestingUser } from "../TestingUtils";
import {
  captureTunnel,
  payloadJsonOf,
  startStubSentry,
  STUB_SENTRY_DSN,
  type CapturedEnvelope,
  type StubSentry,
  type TunnelCapture
} from "./index";

/**
 * G1 (spec §7.3, ADR 3), PR tier: errors reported from the browser and from the Next server
 * identify the user by ID, and no envelope contains the user's email.
 *
 * Needs a build whose NEXT_PUBLIC_SENTRY_DSN is STUB_SENTRY_DSN (CI's e2e-local build sets it).
 * The server SDK then posts straight to the stub started here, and the browser posts to
 * /api/tunnel, which forwards to the same stub; `captureTunnel` in forward mode sees the browser
 * side too. Middleware error paths can't be forced from a browser; the Jest half
 * (tests/unit/bugReport-identity.test.ts) covers them.
 */

type EventPayload = {
  event_id?: string;
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  exception?: { values?: { type?: string; value?: string }[] };
  extra?: Record<string, unknown>;
};

function eventOf(envelope: CapturedEnvelope): EventPayload | undefined {
  const item = envelope.items.find((i) => i.header.type === "event");
  return item ? payloadJsonOf<EventPayload>(item) : undefined;
}

function mentions(envelope: CapturedEnvelope, text: string): boolean {
  return new TextDecoder().decode(envelope.raw).includes(text);
}

test.describe("G1: Sentry envelopes carry no email", () => {
  test.describe.configure({ mode: "serial" });
  let stub: StubSentry;
  let student: TestingUser;
  let course: Awaited<ReturnType<typeof createClass>>;

  test.beforeAll(async ({ browserName }) => {
    // The stub binds a fixed port, so only one browser project runs this file.
    if (browserName !== "chromium") return;
    stub = await startStubSentry();
    course = await createClass({ name: "Bug reporter G1" });
    [student] = await createUsersInClass([{ role: "student", class_id: course.id }]);
  });

  test.afterAll(async () => {
    await stub?.close();
  });

  test("client and server errors identify the user by ID only", async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== "chromium", "binds a fixed port; runs in one project");
    test.setTimeout(120_000);
    await loginAsUser(page, student, course);
    const tunnel: TunnelCapture = await captureTunnel(page, { forward: true });

    // Client: unsubscribing from a thread the user doesn't watch makes app code throw
    // NoRowsUpdatedError, which useUnsubscribe reports.
    await page.goto(`/course/${course.id}/unsubscribe/thread/2147480000`);
    const clientEnvelope = await tunnel.waitForEnvelope((e) => mentions(e, "NoRowsUpdatedError"));
    if (clientEnvelope.header.dsn !== STUB_SENTRY_DSN) {
      const message =
        `This build reports to a different DSN, not ${STUB_SENTRY_DSN}. Rebuild with ` +
        `NEXT_PUBLIC_SENTRY_DSN=${STUB_SENTRY_DSN} to run G1.`;
      if (process.env.CI) throw new Error(message);
      test.skip(true, message);
    }
    const clientAtStub = await stub.waitForEnvelope((e) => mentions(e, "NoRowsUpdatedError"));
    expect(clientEnvelope.status).toBe(200);
    expect(eventOf(clientAtStub)?.user?.id).toBe(student.user_id);
    expect(eventOf(clientAtStub)?.tags?.role).toBe("student");

    // Server: asking for a hint on a test result that doesn't exist makes /api/llm-hint set the
    // user and capture the PostgREST error on the server.
    const response = await page.request.post("/api/llm-hint", { data: { testId: 2147480000 } });
    expect(response.status()).toBe(404);
    const serverEnvelope = await stub.waitForEnvelope(
      (e) => eventOf(e)?.tags?.operation === "fetch_test_result" && eventOf(e)?.user?.id === student.user_id
    );
    expect(eventOf(serverEnvelope)?.user).toEqual({ id: student.user_id });

    // Nothing anywhere carries the email: not the browser's envelopes, not anything the stub got.
    const email = student.email.toLowerCase();
    const offenders = [...tunnel.envelopes, ...stub.envelopes].filter((e) =>
      new TextDecoder().decode(e.raw).toLowerCase().includes(email)
    );
    expect(offenders.map((e) => `${e.url} ${JSON.stringify(e.header)}`)).toEqual([]);

    const summary = [clientAtStub, serverEnvelope].map((e) => {
      const event = eventOf(e) as (EventPayload & { release?: string; environment?: string }) | undefined;
      return {
        url: e.url,
        release: event?.release,
        environment: event?.environment,
        user: event?.user,
        tags: event?.tags
      };
    });
    await testInfo.attach("g1-events.json", {
      body: JSON.stringify(summary, null, 2),
      contentType: "application/json"
    });

    await tunnel.stop();
  });
});
