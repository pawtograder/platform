import { expect, test } from "@playwright/test";
import { createClass, createUsersInClass, loginAsUser } from "../TestingUtils";
import { captureTunnel, exceptionFrames, payloadJsonOf, sentryApiFromEnv } from "./index";

/**
 * Smoke test against the real dev Sentry (nightly and release tiers; skipped when the SENTRY_*
 * variables are absent, as in the PR tier). It is F8 and the package 0 acceptance check: an
 * error thrown by app code in the browser goes through /api/tunnel, lands in the project within
 * 60 s, has a stack trace resolved from the uploaded source maps, and identifies the user by ID
 * only.
 *
 * Needs a full-profile build made with NEXT_PUBLIC_SENTRY_DSN and SENTRY_AUTH_TOKEN set, so
 * source maps were uploaded. If the event doesn't appear, sentryApi.waitFor throws a
 * SentryInfrastructureError: report it, don't retry.
 */

const sentry = sentryApiFromEnv();

test.describe("Sentry smoke (F8)", () => {
  test.skip(!sentry, "SENTRY_URL / SENTRY_ORG / SENTRY_PROJECT / SENTRY_AUTH_TOKEN not set");

  test("a browser error lands in Sentry with a resolved stack trace and no email", async ({ page }) => {
    test.setTimeout(180_000);
    const course = await createClass({ name: "Bug reporter smoke" });
    const [student] = await createUsersInClass([{ role: "student", class_id: course.id }]);
    await loginAsUser(page, student, course);

    const tunnel = await captureTunnel(page, { forward: true });
    // Unsubscribing from a thread the user doesn't watch throws NoRowsUpdatedError from app code
    // (app/course/[course_id]/unsubscribe/thread/[thread_id]/page.tsx), which useUnsubscribe
    // reports with Sentry.captureException.
    await page.goto(`/course/${course.id}/unsubscribe/thread/2147480000`);
    const envelope = await tunnel.waitForEnvelope((e) =>
      e.items.some((i) => i.header.type === "event" && JSON.stringify(payloadJsonOf(i)).includes("NoRowsUpdatedError"))
    );
    expect(envelope.status, "tunnel forwarded the envelope and Sentry accepted it").toBe(200);
    const eventId = String(envelope.header.event_id);

    const event = await sentry!.waitFor(`event ${eventId}`, () => sentry!.event(eventId));

    // Identity: ID and role only.
    expect(event.user?.id).toBe(student.user_id);
    expect(JSON.stringify(event).toLowerCase()).not.toContain(student.email.toLowerCase());
    const tags = Object.fromEntries(event.tags.map((t) => [t.key, t.value]));
    expect(tags.role).toBe("student");
    expect(tags.class_id).toBe(String(course.id));
    if (process.env.SENTRY_RELEASE) expect(event.release?.version).toBe(process.env.SENTRY_RELEASE);

    // Symbolicated: the throwing frame maps back to the page source, with source context.
    const frames = exceptionFrames(event);
    const pageFrame = frames.find((f) =>
      (f.filename ?? f.absPath ?? "").includes("unsubscribe/thread/[thread_id]/page")
    );
    expect(pageFrame, `frames: ${frames.map((f) => f.filename).join(", ")}`).toBeDefined();
    expect(pageFrame!.context?.some(([, line]) => line.includes("NoRowsUpdatedError"))).toBe(true);

    await tunnel.stop();
  });
});
