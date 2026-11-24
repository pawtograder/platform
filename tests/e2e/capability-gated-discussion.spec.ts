/**
 * #1010: moderation controls on a discussion thread follow moderate_discussion
 * (20261123180300_discussion_by_capability.sql). A default grader holds it and sees Pin, Mark
 * Duplicate and Edit on a student's post. A TA on a custom role with it turned off sees none of
 * them, but still sees the staff tools (Manage Error Pins), which stay on the staff check.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("Discussion moderation controls follow moderate_discussion", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let grader: TestingUser;
  let noModTa: TestingUser;
  let asker: TestingUser;
  let replier: TestingUser;
  let rootId: number;
  let subject: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Discussion Gates ${suffix}` });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    noModTa = await createUserInClass({ role: "grader", class_id: course.id });
    asker = await createUserInClass({ role: "student", class_id: course.id });
    replier = await createUserInClass({ role: "student", class_id: course.id });
    const student = asker;

    const { data: topic, error: topicError } = await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", course.id)
      .order("ordinal", { ascending: true })
      .limit(1)
      .single();
    expect(topicError).toBeNull();
    subject = `E2E moderation gates ${suffix}`;
    const { data: thread, error: threadError } = await supabase
      .from("discussion_threads")
      .insert({
        subject,
        body: "A student's question",
        topic_id: topic!.id,
        is_question: true,
        instructors_only: false,
        author: student.private_profile_id,
        class_id: course.id,
        draft: false,
        root_class_id: course.id
      })
      .select("id")
      .single();
    expect(threadError).toBeNull();
    rootId = thread!.id;
    expect((await supabase.from("discussion_threads").update({ root: rootId }).eq("id", rootId)).error).toBeNull();
    // A reply by another student, so there is something to mark as the answer.
    const { error: replyError } = await supabase.from("discussion_threads").insert({
      subject: "Re",
      body: "Another student's reply",
      topic_id: topic!.id,
      is_question: false,
      instructors_only: false,
      author: replier.private_profile_id,
      class_id: course.id,
      draft: false,
      root_class_id: course.id,
      parent: rootId,
      root: rootId
    });
    expect(replyError).toBeNull();

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "No Moderation TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (
        await supabase
          .from("role_capabilities")
          .delete()
          .eq("role_id", role!.id)
          .eq("capability", "moderate_discussion")
      ).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", noModTa.user_id)
          .eq("class_id", course.id)
      ).error
    ).toBeNull();
  });

  // useCapability is false while loading, so a hidden button only means something once the
  // answer is in: wait for a successful lookup by the thread page itself, then for
  // ClassCapabilitiesProvider's loaded marker. The marker alone isn't enough (it also shows after
  // the lookup fails), and the course page's own lookup can answer while the thread page loads, so
  // only a response that arrives after the browser has switched to the thread page counts. The
  // course page's unfinished requests are cancelled at that switch.
  async function openThread(page: Page, user: TestingUser) {
    await loginAsUser(page, user, course);
    const threadPath = `/course/${course.id}/discussion/${rootId}`;
    let onThreadPage = false;
    const onNavigated = (frame: ReturnType<Page["mainFrame"]>) => {
      if (frame === page.mainFrame() && new URL(frame.url()).pathname === threadPath) onThreadPage = true;
    };
    page.on("framenavigated", onNavigated);
    const capabilities = page.waitForResponse(
      (r) => onThreadPage && r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await gotoCourseUrlWhenHeadingVisible(page, threadPath, subject);
    await capabilities;
    page.off("framenavigated", onNavigated);
    await expect(page.locator('[data-capabilities-loaded="true"]').first()).toBeAttached();
    await expect(page.getByRole("button", { name: "Reply" }).first()).toBeVisible();
  }

  // The reply's own box: the innermost element holding both its text and its Reply link. Its Edit
  // control is a link with no address, so it has no link role and is found by its text.
  const replyContainer = (page: Page) =>
    page
      .locator("div")
      .filter({ hasText: "Another student's reply" })
      .filter({ has: page.getByText("Reply", { exact: true }) })
      .last();
  const replyEdit = (page: Page) => replyContainer(page).getByText("Edit", { exact: true });

  test("a default grader sees the moderation controls", async ({ page }) => {
    await openThread(page, grader);
    await expect(page.getByRole("button", { name: "Pin", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark duplicate", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true }).first()).toBeVisible();
    await expect(replyEdit(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage Error Pins" }).first()).toBeVisible();
  });

  test("a TA without moderate_discussion sees no moderation controls, but keeps the staff tools", async ({ page }) => {
    await openThread(page, noModTa);
    await expect(page.getByRole("button", { name: "Pin", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark duplicate", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(replyContainer(page)).toBeVisible();
    await expect(replyEdit(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Manage Error Pins" }).first()).toBeVisible();
  });

  test("Mark as Answer shows to the question's author and moderators, not to the reply's author", async ({ page }) => {
    const markAnswer = () => page.getByRole("button", { name: "Mark as Answer", exact: true });
    for (const [user, sees] of [
      [grader, true],
      [asker, true],
      [noModTa, false],
      [replier, false]
    ] as const) {
      await openThread(page, user);
      await expect(page.getByText("Another student's reply").first()).toBeVisible();
      await expect(markAnswer()).toHaveCount(sees ? 1 : 0);
    }
  });
});
