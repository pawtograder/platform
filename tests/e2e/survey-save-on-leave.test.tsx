import type { TablesInsert } from "../../utils/supabase/SupabaseTypes";
import type { Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page as PlaywrightCorePage } from "playwright-core";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

// Answers typed on a survey must reach survey_responses even when the student reloads before the
// 1 s autosave debounce fires or loses the network, and the page must say whether they are saved.
// The maintainer ruled out keeping drafts in browser storage (#977), so the database is the only
// place an answer may be kept.

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

const ONE_QUESTION_JSON = {
  pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }]
};

const OFFLINE_STATUS = "You're offline. Your answers will save when you reconnect.";
const SAVED_STATUS = "All changes saved";

test.describe("Survey answers survive leaving the page and losing the network", () => {
  let course: Course;
  let student: User;
  let instructor: User;

  test.beforeAll(async () => {
    course = await createClass();
    [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Save On Leave Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Save On Leave Instructor", useMagicLink: true }
    ]);
  });
  test.afterEach(async ({ page, logMagicLinksOnFailure }) => {
    await page.context().setOffline(false);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await logMagicLinksOnFailure([student, instructor]);
  });

  const seedSurvey = async (title: string) => {
    const insert: TablesInsert<"surveys"> = {
      class_id: course.id,
      created_by: instructor.public_profile_id,
      assigned_to_all: true,
      allow_response_editing: false,
      json: ONE_QUESTION_JSON,
      version: 1,
      status: "published",
      title,
      description: "Description"
    };
    const { data, error } = await supabase.from("surveys").insert(insert).select("id").single();
    if (error || !data) throw new Error(`Failed to seed survey: ${error?.message}`);
    return data;
  };

  // The student's stored answer to q1 and whether the row is submitted, or null when there is no row.
  const storedResponse = async (surveyId: string) => {
    const { data, error } = await supabase
      .from("survey_responses")
      .select("response, is_submitted")
      .eq("survey_id", surveyId)
      .eq("profile_id", student.private_profile_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { q1: (data.response as { q1?: string }).q1, is_submitted: data.is_submitted } : null;
  };

  // Records every write the page makes to localStorage, sessionStorage, IndexedDB, the Cache API
  // and document.cookie, across reloads, so a test can check that no answer was kept in the browser.
  const recordBrowserStorageWrites = async (page: Page) => {
    const writes: string[] = [];
    await page.exposeFunction("__recordBrowserStorageWrite", (entry: string) => {
      writes.push(entry);
    });
    await page.addInitScript(() => {
      const record = (kind: string, detail: unknown) => {
        let text: string;
        try {
          text = typeof detail === "string" ? detail : JSON.stringify(detail);
        } catch {
          text = String(detail);
        }
        void (window as unknown as { __recordBrowserStorageWrite: (entry: string) => Promise<void> })
          .__recordBrowserStorageWrite(`${kind} ${text}`)
          .catch(() => {});
      };
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        record(this === window.sessionStorage ? "sessionStorage" : "localStorage", `${key}=${value}`);
        return setItem.call(this, key, value);
      };
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name: string, version?: number) {
        record("indexedDB.open", name);
        return version === undefined ? open.call(this, name) : open.call(this, name, version);
      };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        record("indexedDB.put", value);
        return put.call(this, value, key);
      };
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
        record("indexedDB.add", value);
        return add.call(this, value, key);
      };
      if (typeof CacheStorage !== "undefined") {
        const cacheOpen = CacheStorage.prototype.open;
        CacheStorage.prototype.open = function (cacheName: string) {
          record("caches.open", cacheName);
          return cacheOpen.call(this, cacheName);
        };
      }
      const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
      if (cookie?.get && cookie.set) {
        const { get, set } = cookie;
        Object.defineProperty(Document.prototype, "cookie", {
          configurable: true,
          get() {
            return get.call(this);
          },
          set(value: string) {
            record("cookie", value);
            set.call(this, value);
          }
        });
      }
    });
    return writes;
  };

  test("an answer typed right before a reload is stored and shown after the reload", async ({ page }) => {
    const survey = await seedSurvey("Fast Reload Survey");
    await loginAsUser(page, student, course);
    const storageWrites = await recordBrowserStorageWrites(page);
    await page.clock.install();

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await expect(input).toBeEditable();

    // Stop the page's timers, so the 1 s autosave debounce cannot fire before the reload.
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await input.fill("Typed right before reload");
    // The shared fixture routes avatar images, and any page.route puts every request through
    // Playwright's interception. A keepalive request sent while the page unloads then sits paused
    // until the page closes, which a browser without a test harness doesn't do. Drop the routes so
    // the reload behaves like a real one.
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    await page.clock.resume();

    await expect
      .poll(() => storedResponse(survey.id), { timeout: 10_000 })
      .toEqual({ q1: "Typed right before reload", is_submitted: false });
    await expect(page.getByRole("textbox", { name: "Question 1" })).toHaveValue("Typed right before reload");
    expect(storageWrites.filter((write) => write.includes("Typed right before reload"))).toEqual([]);
  });

  test("an answer given offline is saved after reconnecting, and the page says which", async ({ page }) => {
    const survey = await seedSurvey("Offline Answer Survey");
    await loginAsUser(page, student, course);
    const storageWrites = await recordBrowserStorageWrites(page);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await expect(input).toBeEditable();
    // Set on this document only: a reload would clear it.
    await page.evaluate(() => {
      (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
    });

    await page.context().setOffline(true);
    await input.fill("Answered while offline");
    await expect(page.getByRole("status").filter({ hasText: OFFLINE_STATUS })).toBeVisible();
    expect(await storedResponse(survey.id)).toBeNull();

    await page.context().setOffline(false);
    await expect
      .poll(() => storedResponse(survey.id), { timeout: 15_000 })
      .toEqual({ q1: "Answered while offline", is_submitted: false });
    await expect(page.getByRole("status").filter({ hasText: SAVED_STATUS })).toBeVisible();
    await expect(page.getByText(OFFLINE_STATUS)).toHaveCount(0);
    // Saved without a reload: the marker set on this document is still there.
    const sameDocument = await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument);
    expect(sameDocument).toBe(true);
    expect(storageWrites.filter((write) => write.includes("Answered while offline"))).toEqual([]);
  });

  test("a Complete that fails offline keeps the form, and succeeds once back online", async ({ page }) => {
    const survey = await seedSurvey("Offline Complete Survey");
    await loginAsUser(page, student, course);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await input.fill("Answer before going offline");
    await expect
      .poll(() => storedResponse(survey.id), { timeout: 10_000 })
      .toEqual({ q1: "Answer before going offline", is_submitted: false });

    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Complete" }).click();

    // Back in the form with the answers, not on the thank-you screen, and told what happened.
    await expect(input).toHaveValue("Answer before going offline");
    await expect(input).toBeEditable();
    await expect(page.getByRole("alert").filter({ hasText: "Your survey wasn't submitted" })).toBeVisible();

    // The answers keep autosaving as a draft while the student is back in the form.
    await input.fill("Changed after the failed Complete");
    await expect(page.getByRole("status").filter({ hasText: OFFLINE_STATUS })).toBeVisible();
    await page.context().setOffline(false);
    await expect
      .poll(() => storedResponse(survey.id), { timeout: 15_000 })
      .toEqual({ q1: "Changed after the failed Complete", is_submitted: false });

    await page.getByRole("button", { name: "Complete" }).click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys$`), { timeout: 15_000 });
    await expect
      .poll(() => storedResponse(survey.id))
      .toEqual({ q1: "Changed after the failed Complete", is_submitted: true });
  });

  test("a Complete the server refuses keeps the form, and can be pressed again", async ({ page }) => {
    const survey = await seedSurvey("Server Error Complete Survey");
    await loginAsUser(page, student, course);
    // The first submit gets a 500 from the server; everything else goes through.
    let refusedSubmit = false;
    await page.route("**/rest/v1/survey_responses*", async (route) => {
      const body = route.request().postDataJSON() as { is_submitted?: boolean } | null;
      if (route.request().method() !== "POST" || !body?.is_submitted || refusedSubmit) return route.fallback();
      refusedSubmit = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "XX000", message: "internal error", details: null, hint: null })
      });
    });

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await input.fill("Answer before a server error");
    await expect
      .poll(() => storedResponse(survey.id), { timeout: 10_000 })
      .toEqual({ q1: "Answer before a server error", is_submitted: false });
    await page.getByRole("button", { name: "Complete" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Your survey wasn't submitted" })).toBeVisible();
    await expect(input).toHaveValue("Answer before a server error");
    await expect(input).toBeEditable();
    expect(await storedResponse(survey.id)).toEqual({ q1: "Answer before a server error", is_submitted: false });

    await page.getByRole("button", { name: "Complete" }).click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys$`), { timeout: 15_000 });
    await expect
      .poll(() => storedResponse(survey.id))
      .toEqual({ q1: "Answer before a server error", is_submitted: true });
  });

  // Holds the first draft upsert forever: the request is sent but never gets a response.
  const neverAnswerFirstWrite = async (page: Page) => {
    let writes = 0;
    await page.route("**/rest/v1/survey_responses*", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      writes += 1;
      if (writes === 1) return;
      await route.fallback();
    });
    return () => writes;
  };

  test("a save that never gets a response does not hold up later saves", async ({ page }) => {
    // The stuck request is only given up on after the page's 10 s save time limit.
    test.setTimeout(90_000);
    const survey = await seedSurvey("Stuck Save Survey");
    await loginAsUser(page, student, course);
    const writesSent = await neverAnswerFirstWrite(page);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await input.fill("First answer");
    await expect.poll(writesSent, { timeout: 10_000 }).toBe(1);
    await input.fill("Second answer");

    await expect
      .poll(() => storedResponse(survey.id), { timeout: 30_000 })
      .toEqual({ q1: "Second answer", is_submitted: false });
  });

  test("a save that never gets a response does not hold up Complete", async ({ page }) => {
    test.setTimeout(90_000);
    const survey = await seedSurvey("Stuck Save Complete Survey");
    await loginAsUser(page, student, course);
    const writesSent = await neverAnswerFirstWrite(page);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    await page.getByRole("textbox", { name: "Question 1" }).fill("Answer behind a stuck save");
    await expect.poll(writesSent, { timeout: 10_000 }).toBe(1);
    await page.getByRole("button", { name: "Complete" }).click();

    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys$`), { timeout: 30_000 });
    await expect
      .poll(() => storedResponse(survey.id))
      .toEqual({ q1: "Answer behind a stuck save", is_submitted: true });
  });

  test("an answer typed while an earlier save is still on its way is stored when the student reloads", async ({
    page,
    browserName
  }) => {
    test.skip(browserName !== "chromium", "Holds the first save with the Chrome DevTools Protocol");
    const survey = await seedSurvey("Reload Behind Slow Save Survey");
    await loginAsUser(page, student, course);
    // The first save has to stay unanswered through the reload. A page.route would also hold up
    // the keepalive request sent while the page unloads (see the fast-reload test), and removing
    // it releases the held request. So hold that one request with the DevTools Protocol and let
    // every other request through.
    await page.unrouteAll({ behavior: "wait" });
    const cdp = await page.context().newCDPSession(page);
    let writes = 0;
    cdp.on("Fetch.requestPaused", (event) => {
      if (event.request.method === "POST" && ++writes === 1) return;
      void cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/rest/v1/survey_responses*" }] });

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await input.fill("First answer");
    await expect.poll(() => writes, { timeout: 10_000 }).toBe(1);
    // The first save is still waiting for the server when the student types more and reloads.
    await input.fill("Typed while the first save was on its way");
    await page.reload();

    await expect
      .poll(() => storedResponse(survey.id), { timeout: 10_000 })
      .toEqual({ q1: "Typed while the first save was on its way", is_submitted: false });
    await expect(page.getByRole("textbox", { name: "Question 1" })).toHaveValue(
      "Typed while the first save was on its way"
    );
  });

  // The submit upsert reaches the server, but its response never comes back to the page.
  const loseTheSubmitResponse = async (page: Page) => {
    await page.route("**/rest/v1/survey_responses*", async (route) => {
      const body = route.request().postDataJSON() as { is_submitted?: boolean } | null;
      if (route.request().method() !== "POST" || !body?.is_submitted) return route.fallback();
      await route.fetch();
    });
  };

  test("a Complete that reaches the database but gets no answer back is reported as submitted", async ({ page }) => {
    // The page gives up on the submit after its 10 s limit, then has to find out what happened.
    test.setTimeout(90_000);
    const survey = await seedSurvey("Lost Answer Complete Survey");
    await loginAsUser(page, student, course);
    await loseTheSubmitResponse(page);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    await page.getByRole("textbox", { name: "Question 1" }).fill("Submitted, answer lost");
    await expect
      .poll(() => storedResponse(survey.id), { timeout: 10_000 })
      .toEqual({ q1: "Submitted, answer lost", is_submitted: false });
    await page.getByRole("button", { name: "Complete" }).click();

    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys$`), { timeout: 30_000 });
    expect(await storedResponse(survey.id)).toEqual({ q1: "Submitted, answer lost", is_submitted: true });
  });

  test("a Complete whose answer is lost counts as submitted when the student's clock runs ahead", async ({ page }) => {
    test.setTimeout(90_000);
    const survey = await seedSurvey("Fast Clock Complete Survey");
    await loginAsUser(page, student, course);
    // The student's computer clock is two minutes ahead of the server's. The database stamps
    // submitted_at itself on the first submit, so the two clocks disagree about when it happened.
    await page.clock.install({ time: new Date(Date.now() + 2 * 60_000) });
    await loseTheSubmitResponse(page);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    await page.getByRole("textbox", { name: "Question 1" }).fill("Submitted with a fast clock");
    await expect
      .poll(() => storedResponse(survey.id), { timeout: 10_000 })
      .toEqual({ q1: "Submitted with a fast clock", is_submitted: false });
    await page.getByRole("button", { name: "Complete" }).click();

    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys$`), { timeout: 30_000 });
    expect(await storedResponse(survey.id)).toEqual({ q1: "Submitted with a fast clock", is_submitted: true });
  });

  test("a Complete that never gets an answer and never reached the database keeps the form", async ({ page }) => {
    test.setTimeout(90_000);
    const survey = await seedSurvey("Unanswered Complete Survey");
    await loginAsUser(page, student, course);
    // The submit is held and never sent on, so only the draft row with the same answer exists.
    await page.route("**/rest/v1/survey_responses*", async (route) => {
      const body = route.request().postDataJSON() as { is_submitted?: boolean } | null;
      if (route.request().method() !== "POST" || !body?.is_submitted) return route.fallback();
    });

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await input.fill("Never submitted");
    await expect
      .poll(() => storedResponse(survey.id), { timeout: 10_000 })
      .toEqual({ q1: "Never submitted", is_submitted: false });
    await page.getByRole("button", { name: "Complete" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "The server took too long to respond." })).toBeVisible({
      timeout: 30_000
    });
    await expect(input).toHaveValue("Never submitted");
    await expect(input).toBeEditable();
    expect(await storedResponse(survey.id)).toEqual({ q1: "Never submitted", is_submitted: false });
  });

  test("the save status changes when a save starts and when it lands, not on every keystroke", async ({ page }) => {
    const survey = await seedSurvey("Status Per Save Survey");
    await loginAsUser(page, student, course);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await expect(input).toBeEditable();
    // Every text the save status shows, in order, as a screen reader would hear it.
    await page.evaluate(
      (statusTexts) => {
        const seen: string[] = [];
        (window as unknown as { __saveStatusTexts: string[] }).__saveStatusTexts = seen;
        new MutationObserver(() => {
          const shown = Array.from(document.querySelectorAll('[role="status"]'))
            .map((element) => element.textContent ?? "")
            .find((text) => statusTexts.includes(text));
          if (shown && seen[seen.length - 1] !== shown) seen.push(shown);
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      },
      ["Saving…", SAVED_STATUS, OFFLINE_STATUS, "Not saved yet. Retrying…", "Your latest answers aren't saved."]
    );

    await input.pressSequentially("One key at a time", { delay: 40 });
    await expect(page.getByRole("status").filter({ hasText: SAVED_STATUS })).toBeVisible();
    const seen = await page.evaluate(() => (window as unknown as { __saveStatusTexts: string[] }).__saveStatusTexts);
    expect(seen).toEqual(["Saving…", SAVED_STATUS]);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the save status meets text contrast in ${colorScheme} mode`, async ({ page }) => {
      test.setTimeout(90_000);
      const survey = await seedSurvey(`Status Contrast Survey (${colorScheme})`);
      await loginAsUser(page, student, course);
      await page.emulateMedia({ colorScheme });

      await page.goto(`/course/${course.id}/surveys/${survey.id}`);
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`));
      const input = page.getByRole("textbox", { name: "Question 1" });

      const expectReadable = async (text: string) => {
        const status = page.getByRole("status").filter({ hasText: text });
        await expect(status).toBeVisible({ timeout: 30_000 });
        await status.evaluate((element) => element.setAttribute("data-save-status-under-test", ""));
        // @axe-core/playwright types against playwright-core's Page, as in axeStudentA11y.ts.
        const results = await new AxeBuilder({ page: page as unknown as PlaywrightCorePage })
          .include("[data-save-status-under-test]")
          .withRules(["color-contrast"])
          .analyze();
        await status.evaluate((element) => element.removeAttribute("data-save-status-under-test"));
        expect(results.violations, `"${text}" in ${colorScheme} mode`).toEqual([]);
        expect(results.incomplete, `"${text}" in ${colorScheme} mode`).toEqual([]);
        expect(results.passes.map((rule) => rule.id)).toContain("color-contrast");
      };

      await input.fill("Saved answer");
      await expectReadable(SAVED_STATUS);

      await page.context().setOffline(true);
      await input.fill("Offline answer");
      await expectReadable(OFFLINE_STATUS);
      await page.context().setOffline(false);
      await expectReadable(SAVED_STATUS);

      // Every draft save now fails, so the retries run out.
      await page.route("**/rest/v1/survey_responses*", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      });
      await input.fill("Answer the server keeps refusing");
      await expectReadable("Not saved yet. Retrying…");
      await expectReadable("Your latest answers aren't saved.");
    });
  }
});
