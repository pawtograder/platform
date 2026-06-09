import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "@/tests/global-setup";
import dotenv from "dotenv";
import { createClass, createUserInClass, loginAsUser, TestingUser } from "@/tests/e2e/TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

test.setTimeout(120_000);

// Regression for the Sentry crash "No private profile id found" on /course/[course_id].
// A signed-in user with no active user_role in the target course (not enrolled / dropped /
// disabled) used to 406 the `.single()` role lookup, which the page turned into an uncaught
// 500. The layout already redirects such users home; the page must do the same instead of
// throwing.
let enrolledCourse: Course;
let foreignCourse: Course;
let user: TestingUser;

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  // The user is a real student in `enrolledCourse` but has no role at all in `foreignCourse`.
  enrolledCourse = await createClass({ name: "Landing No-Role - Enrolled" });
  foreignCourse = await createClass({ name: "Landing No-Role - Foreign" });
  user = await createUserInClass({
    name: "No Role Wanderer",
    email: "no-role-wanderer@pawtograder.net",
    role: "student",
    class_id: enrolledCourse.id,
    useMagicLink: true
  });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([user]);
});

test.describe("Course landing with no role in the course", () => {
  test("redirects home instead of crashing with a 500", async ({ page }) => {
    // Surface a server-rendered crash if it reappears: a 500 status on the document, or the
    // distinctive error string leaking into the page.
    const serverErrors: number[] = [];
    page.on("response", (resp) => {
      if (resp.request().resourceType() === "document" && resp.status() >= 500) {
        serverErrors.push(resp.status());
      }
    });

    await loginAsUser(page, user);

    await page.goto(`/course/${foreignCourse.id}`);
    await page.waitForLoadState("networkidle");

    // Redirected away from the broken course route (the root may redirect onward, so we only
    // assert we did not stay on /course/<foreignCourse.id>).
    expect(page.url()).not.toContain(`/course/${foreignCourse.id}`);

    // No 500 document response and no leaked error text.
    expect(serverErrors, "course landing should not 500 for a user with no role").toEqual([]);
    await expect(page.getByText("No private profile id found")).toHaveCount(0);
  });
});
