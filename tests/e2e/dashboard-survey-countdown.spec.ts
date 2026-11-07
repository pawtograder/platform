import net from "node:net";
import type { Page, Request, Route } from "@playwright/test";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

// The "Surveys to complete" block on the student dashboard: the label and the cards under it.
function surveysToComplete(page: Page) {
  return page.getByText("Surveys to complete", { exact: true }).locator("..");
}

// There is no browser API to hide a tab from a test, so this stands in for switching tabs:
// it overrides what the page reads and fires the event the browser would fire.
async function setTabVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

// The refresh is a server action, a POST to the current page with a next-action header. An RSC GET
// counts too, because router.refresh() sends one, and it must show up here if it ever comes back.
// Link prefetches use the same header, so they are told apart by next-router-prefetch and the path.
function isDashboardRefresh(request: Request, courseId: number) {
  if (new URL(request.url()).pathname !== `/course/${courseId}`) return false;
  const headers = request.headers();
  return request.method() === "POST"
    ? Boolean(headers["next-action"])
    : headers["rsc"] === "1" && !headers["next-router-prefetch"];
}

async function showAgain(page: Page) {
  await setTabVisibility(page, "hidden");
  await setTabVisibility(page, "visible");
}

async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
  });
}

function isSameDocument(page: Page) {
  return page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true);
}

// A TCP proxy in front of the app, so a cut is a real one and the browser raises its own error, which
// is what app/global-error.tsx has to recognize. The refresh it's told to cut asks for no compression,
// so the proxy can find the response's root row. It sends up to that row and holds the connection until
// finishCut(), and can stay down afterward, like a network that's gone. The hold is because a stream
// that errors throws away what nobody has read, so the page has to have read the row first.
async function startCutProxy(baseURL: string) {
  const target = new URL(baseURL);
  const sockets = new Set<net.Socket>();
  let armed: { thenDown: boolean } | null = null;
  let down = false;
  let finishCut = () => {};
  const server = net.createServer((client) => {
    if (down) {
      client.destroy();
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    sockets.add(client).add(upstream);
    let cutting: { thenDown: boolean } | null = null;
    let headersSent = false;
    let cutScheduled = false;
    let body = Buffer.alloc(0);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => {
      if (!cutting) client.end();
    });
    client.on("data", (data) => {
      const head = data.toString("latin1");
      if (armed && /^POST \/course\/\d+ /.test(head) && /next-action:/i.test(head)) {
        cutting = armed;
        armed = null;
        upstream.write(Buffer.from(head.replace(/accept-encoding:[^\r]*\r\n/i, ""), "latin1"));
        return;
      }
      upstream.write(data);
    });
    upstream.on("data", (data) => {
      if (!cutting) {
        client.write(data);
        return;
      }
      if (cutScheduled) return;
      let chunk = data;
      if (!headersSent) {
        const headersEnd = chunk.indexOf("\r\n\r\n");
        if (headersEnd < 0) {
          client.write(chunk);
          return;
        }
        client.write(chunk.subarray(0, headersEnd + 4));
        headersSent = true;
        chunk = chunk.subarray(headersEnd + 4);
      }
      body = Buffer.concat([body, chunk]);
      const text = body.toString("latin1");
      const rootStart = text.search(/(^|\n)0:/);
      if (rootStart < 0) return;
      // A row ends at a bare newline. Inside one, CRLF is only the chunked encoding's framing.
      let rootEnd = text.indexOf("\n", rootStart + 1);
      while (rootEnd >= 0 && text[rootEnd - 1] === "\r") rootEnd = text.indexOf("\n", rootEnd + 1);
      if (rootEnd < 0) return;
      cutScheduled = true;
      client.write(body.subarray(0, rootEnd + 1));
      const { thenDown } = cutting;
      finishCut = () => {
        if (thenDown) {
          down = true;
          for (const socket of sockets) if (socket !== client) socket.destroy();
        }
        client.end();
        upstream.destroy();
      };
    });
  });
  await new Promise<void>((resolve) => server.listen(0, target.hostname, resolve));
  const proxied = new URL(baseURL);
  proxied.port = String((server.address() as net.AddressInfo).port);
  return {
    origin: proxied.origin,
    cutNextRefresh: (options = { thenDown: false }) => {
      armed = options;
    },
    finishCut: () => finishCut(),
    comeBackUp: () => {
      down = false;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
}

// Resolves once the page has read the refresh's root row. Next's own read has it by then too, since a
// read waiting on the stream gets each chunk as it arrives.
async function watchForRootRow(page: Page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await real(input, init);
      if (init?.method === "POST" && new Headers(init.headers).has("next-action")) {
        const reader = response.clone().body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        void (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            text += decoder.decode(value, { stream: true });
            if (/(^|\n)0:/.test(text)) (window as unknown as { __rootRow?: boolean }).__rootRow = true;
          }
        })().catch(() => {});
      }
      return response;
    };
  });
  return () =>
    expect
      .poll(() => page.evaluate(() => (window as unknown as { __rootRow?: boolean }).__rootRow === true))
      .toBe(true);
}

function recordDashboardRefreshes(page: Page, courseId: number) {
  const refreshes: string[] = [];
  page.on("request", (request) => {
    if (isDashboardRefresh(request, courseId)) refreshes.push(request.url());
  });
  return refreshes;
}

test.describe("Student dashboard survey countdown", () => {
  let course: Course;
  let student: User;
  let instructor: User;

  async function seedPublishedSurvey(title: string, dueAt: number, availableAt?: number) {
    const { data, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        assigned_to_all: true,
        allow_response_editing: false,
        json: { pages: [{ elements: [{ type: "text", name: "q1", title: "How is it going?" }] }] },
        version: 1,
        status: "published",
        title,
        due_date: new Date(dueAt).toISOString(),
        ...(availableAt === undefined ? {} : { available_at: new Date(availableAt).toISOString() })
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(`Failed to seed survey: ${error.message}`);
    }
    return data.id;
  }

  // The course controller's first fetch of the class's surveys.
  function isSurveysList(url: string) {
    const { pathname, searchParams } = new URL(url);
    return pathname.endsWith("/rest/v1/surveys") && searchParams.get("class_id") === `eq.${course.id}`;
  }

  // The dashboard with one survey on it, marked, and the clock past the minute, so a show refreshes it.
  // This document's controller has its list too, which networkidle doesn't promise: on a busy machine the
  // page goes quiet for longer than that before its client code fetches anything. Otherwise what a test
  // does next races that fetch, so a survey it seeds may be in the list, and an outage it starts may fail
  // it. The wait matches on URL, so the login page goes first: its own list could answer it instead.
  async function openDashboard(page: Page, title: string, origin = "") {
    await loginAsUser(page, student, course);
    const dueAt = Date.now() + 30 * 60_000;
    await seedPublishedSurvey(title, dueAt);
    await page.clock.install();
    const refreshes = recordDashboardRefreshes(page, course.id);
    await page.goto("about:blank");
    const listAnswered = page.waitForResponse((response) => isSurveysList(response.url()));
    await page.goto(`${origin}/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText(title)).toBeVisible();
    await page.waitForLoadState("networkidle");
    await listAnswered;
    await markDocument(page);
    await page.clock.setSystemTime(dueAt - 15 * 60_000);
    return { surveys, refreshes, dueAt };
  }

  test.beforeAll(async () => {
    course = await createClass({ name: "Survey Countdown Course" });
    [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Countdown Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Countdown Instructor", useMagicLink: true }
    ]);
  });

  test.beforeEach(async () => {
    // One survey per test, so each card's text belongs to the survey the test seeded.
    const { error } = await supabase.from("surveys").delete().eq("class_id", course.id);
    if (error) {
      throw new Error(`Failed to clear surveys: ${error.message}`);
    }
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student, instructor]);
  });

  test("a survey left open on the dashboard turns Overdue within 30 s of its deadline, without a reload", async ({
    page
  }) => {
    await loginAsUser(page, student, course);
    const dueAt = Date.now() + 3 * 60_000;
    await seedPublishedSurvey("Deadline Survey", dueAt);

    await page.clock.install();
    await page.goto(`/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText("Deadline Survey")).toBeVisible();
    await expect(surveys.getByText("Pending", { exact: true })).toBeVisible();
    await expect(surveys.getByText(/^Due in \d+ minutes?$/)).toBeVisible();
    await markDocument(page);

    // Stop the clock just before the deadline; from here on time moves only when the test moves it.
    await page.clock.pauseAt(dueAt - 5_000);
    await expect(surveys.getByText("Pending", { exact: true })).toBeVisible();

    // 30 s past the deadline.
    await page.clock.runFor(35_000);
    await expect(surveys.getByText("Overdue", { exact: true })).toBeVisible();
    await expect(surveys.getByText(/^Was due .+ ago$/)).toBeVisible();
    await expect(surveys.getByText("Pending", { exact: true })).toHaveCount(0);
    expect(await isSameDocument(page)).toBe(true);
  });

  test("a hidden dashboard shows the current countdown as soon as it is shown again, and refreshes at most once a minute", async ({
    page
  }) => {
    await loginAsUser(page, student, course);
    const dueAt = Date.now() + 30 * 60_000;
    await seedPublishedSurvey("Background Tab Survey", dueAt);

    await page.clock.install();
    const refreshes = recordDashboardRefreshes(page, course.id);
    await page.goto(`/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText(/^Due in \d+ minutes$/)).toBeVisible();
    await page.waitForLoadState("networkidle");

    // Paused, no timer fires, so only showing the tab can change what the card says.
    await page.clock.pauseAt(dueAt - 25 * 60_000);
    await setTabVisibility(page, "hidden");
    await page.clock.setSystemTime(dueAt - 15 * 60_000);
    // It opens while the student is away, so only the refresh can bring its card.
    await seedPublishedSurvey("Opened While Away", dueAt + 5 * 60_000);
    await setTabVisibility(page, "visible");
    await expect(surveys.getByText("Due in 15 minutes", { exact: true })).toBeVisible();
    await expect(surveys.getByText("Opened While Away")).toBeVisible();
    expect(refreshes).toHaveLength(1);

    // Shown again inside the minute: this one must not refresh.
    await setTabVisibility(page, "hidden");
    await setTabVisibility(page, "visible");

    // A minute later it refreshes again, and brings the next survey that opened.
    await seedPublishedSurvey("Opened A Minute Later", dueAt + 10 * 60_000);
    await setTabVisibility(page, "hidden");
    await page.clock.setSystemTime(dueAt - 15 * 60_000 + 61_000);
    await setTabVisibility(page, "visible");
    await expect(surveys.getByText("Opened A Minute Later")).toBeVisible();
    // With that card on screen, an extra refresh inside the minute would have been counted by now.
    // The unit test pins the throttle exactly.
    expect(refreshes).toHaveLength(2);
  });

  // The network fails with the browser still reporting it's online, as on Wi-Fi that has only just
  // woken. The server fails with the network fine. router.refresh() fails differently in each, and
  // the page has to come through both with the router still working.
  for (const [name, failRefresh] of [
    ["the network", (route: Route) => route.abort("namenotresolved")],
    [
      "the server",
      (route: Route) =>
        isDashboardRefresh(route.request(), course.id)
          ? route.fulfill({ status: 500, body: "Internal Server Error" })
          : route.fallback()
    ]
  ] as const) {
    test(`a refresh that fails because of ${name} keeps the dashboard, and the next show and a link still work`, async ({
      page
    }) => {
      const { surveys, refreshes, dueAt } = await openDashboard(page, "Submitted While Away");

      // Answered, not just sent, so the route can't be removed before this refresh has failed.
      let refreshAnswered = () => {};
      const answered = new Promise<void>((resolve) => (refreshAnswered = resolve));
      const failThenSignal = async (route: Route) => {
        const isRefresh = isDashboardRefresh(route.request(), course.id);
        await failRefresh(route);
        if (isRefresh) refreshAnswered();
      };
      await page.route("**/*", failThenSignal);
      await showAgain(page);
      await answered;

      // Still failing through a second show, so what the student sees is checked while the failure
      // lasts. Retried because the page handles a failure a moment after the route answers it. Not
      // required: a stopped router sends no second refresh, and the new card below is what must catch
      // that, on what the student sees and not on this count.
      await expect
        .poll(
          async () => {
            await showAgain(page);
            return refreshes.length;
          },
          { timeout: 5_000 }
        )
        .toBeGreaterThan(1)
        .catch(() => {});
      await expect(surveys.getByText("Submitted While Away")).toBeVisible();
      expect(await isSameDocument(page)).toBe(true);
      await page.unroute("**/*", failThenSignal);

      // The failure gave the minute back, so this show refreshes with no change to the clock. It
      // brings a survey that opened and takes away one that was submitted.
      await seedPublishedSurvey("Opened After The Failure", dueAt + 5 * 60_000);
      const { data: submitted, error: findError } = await supabase
        .from("surveys")
        .select("id")
        .eq("class_id", course.id)
        .eq("title", "Submitted While Away")
        .single();
      if (findError) throw new Error(`Failed to find survey: ${findError.message}`);
      const { error: submitError } = await supabase.from("survey_responses").insert({
        survey_id: submitted.id,
        profile_id: student.private_profile_id,
        response: {},
        is_submitted: true,
        submitted_at: new Date().toISOString()
      });
      if (submitError) throw new Error(`Failed to submit survey: ${submitError.message}`);
      // Retried for the same reason. The second test pins exactly how many refreshes a healthy page sends.
      await expect(async () => {
        await showAgain(page);
        await expect(surveys.getByText("Opened After The Failure")).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 20_000 });
      await expect(surveys.getByText("Submitted While Away")).toHaveCount(0);

      // The router still works: a link renders the survey page, in the same document. This survey
      // opened after the page loaded, so the course controller has to find it by ID.
      await page.clock.resume();
      await surveys.getByRole("link", { name: /Opened After The Failure/ }).click();
      await expect(page.getByRole("heading", { name: "Opened After The Failure", level: 1 })).toBeVisible();
      expect(await isSameDocument(page)).toBe(true);
    });
  }

  // router.refresh() compares builds and reloads a tab a deploy left behind. The action has to do the
  // same, for a server that's another build and for one that no longer has this action.
  for (const [name, answerAsDeployed] of [
    ["another build", (route: Route) => route.continue({ postData: JSON.stringify(["another-build"]) })],
    [
      "a build without this action",
      (route: Route) => route.continue({ headers: { ...route.request().headers(), "next-action": "0".repeat(42) } })
    ]
  ] as const) {
    test(`a dashboard left open across a deploy to ${name} reloads at the next show`, async ({ page }) => {
      const { surveys, refreshes, dueAt } = await openDashboard(page, "Before The Deploy");
      await seedPublishedSurvey("After The Deploy", dueAt + 5 * 60_000);
      await page.route("**/*", (route) =>
        isDashboardRefresh(route.request(), course.id) ? answerAsDeployed(route) : route.fallback()
      );
      await showAgain(page);
      await expect(surveys.getByText("After The Deploy")).toBeVisible();
      expect(await isSameDocument(page)).toBe(false);
      expect(refreshes).toHaveLength(1);
    });
  }

  test("a signed-out dashboard goes to sign-in at the next show", async ({ page, context }) => {
    await openDashboard(page, "Signed Out");
    await context.clearCookies();
    await showAgain(page);
    await page.waitForURL(/\/sign-in/);
  });

  test("a refresh cut after its root row comes back as a working dashboard, with no click", async ({
    page,
    baseURL
  }) => {
    const proxy = await startCutProxy(baseURL!);
    try {
      const { surveys, dueAt } = await openDashboard(page, "Cut On The Wire", proxy.origin);
      await seedPublishedSurvey("Opened Before The Cut", dueAt + 5 * 60_000);
      const rootRowRead = await watchForRootRow(page);
      proxy.cutNextRefresh();
      await showAgain(page);
      await rootRowRead();
      proxy.finishCut();
      // Only the reload can bring this: the refresh that would have was cut, and nothing shows the tab again.
      await expect(surveys.getByText("Opened Before The Cut")).toBeVisible();
      expect(await isSameDocument(page)).toBe(false);
    } finally {
      proxy.close();
    }
  });

  test("a refresh cut with the network staying down keeps Try Again, and the next show recovers", async ({
    page,
    baseURL
  }) => {
    const proxy = await startCutProxy(baseURL!);
    try {
      const { surveys } = await openDashboard(page, "Cut And Gone", proxy.origin);
      const dashboard = page.url();
      const checkFailed = page.waitForEvent(
        "requestfailed",
        (request) => request.url().endsWith("/error-background.jpg") && request.method() === "HEAD"
      );
      const rootRowRead = await watchForRootRow(page);
      proxy.cutNextRefresh({ thenDown: true });
      await showAgain(page);
      await rootRowRead();
      proxy.finishCut();
      await checkFailed;
      // A reload now would be the browser's error page, with no way back but the student reloading.
      await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
      expect(page.url()).toBe(dashboard);
      expect(await isSameDocument(page)).toBe(true);

      proxy.comeBackUp();
      await showAgain(page);
      await expect(surveys.getByText("Cut And Gone")).toBeVisible();
      expect(await isSameDocument(page)).toBe(false);
    } finally {
      proxy.close();
    }
  });

  test.describe("a survey the course controller doesn't have yet", () => {
    const surveyHeading = (page: Page, title: string) => page.getByRole("heading", { name: title, level: 1 });
    const notFoundToasts = (page: Page) =>
      page.locator('[data-scope="toast"][data-part="root"]').filter({ hasText: "Survey Not Found" });

    function isSurveyFetch(url: string, surveyId: string, select: string) {
      const { pathname, searchParams } = new URL(url);
      return (
        pathname.endsWith("/rest/v1/surveys") &&
        searchParams.get("id") === `eq.${surveyId}` &&
        searchParams.get("select") === select
      );
    }

    test("isn't called missing while the controller is still fetching it", async ({ page }) => {
      const { surveys, dueAt } = await openDashboard(page, "Already Open");
      const surveyId = await seedPublishedSurvey("Just Opened", dueAt + 5 * 60_000);
      await showAgain(page);
      await expect(surveys.getByText("Just Opened")).toBeVisible();

      // The controller's fetch waits until the direct check has answered, so this is the same every
      // run: a page that decides from the controller alone has already gone to the list by then.
      let releaseFetch = () => {};
      const fetchReleased = new Promise<void>((resolve) => (releaseFetch = resolve));
      await page.route(/\/rest\/v1\/surveys\?/, async (route) => {
        if (isSurveyFetch(route.request().url(), surveyId, "*")) await fetchReleased;
        await route.fallback();
      });
      const directCheck = page.waitForResponse((response) => isSurveyFetch(response.url(), surveyId, "id"));
      await surveys.getByRole("link", { name: /Just Opened/ }).click();
      await directCheck;
      releaseFetch();

      await expect(surveyHeading(page, "Just Opened")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/surveys/${surveyId}$`));
      expect(await notFoundToasts(page).count()).toBe(0);
    });

    test("still opens after the controller's fetch failed once", async ({ page }) => {
      const { surveys, dueAt } = await openDashboard(page, "Already Open");
      const surveyId = await seedPublishedSurvey("Fetch Failed Once", dueAt + 5 * 60_000);
      await showAgain(page);
      await expect(surveys.getByText("Fetch Failed Once")).toBeVisible();

      let failed = false;
      await page.route(/\/rest\/v1\/surveys\?/, async (route) => {
        if (!failed && isSurveyFetch(route.request().url(), surveyId, "*")) {
          failed = true;
          await route.abort("failed");
          return;
        }
        await route.fallback();
      });
      await surveys.getByRole("link", { name: /Fetch Failed Once/ }).click();

      await expect(surveyHeading(page, "Fetch Failed Once")).toBeVisible();
      expect(failed).toBe(true);
      expect(await notFoundToasts(page).count()).toBe(0);
    });

    // A page that loads while the network is failing: the controller's first fetch fails, and it never
    // asks again. This is what CI found, when that fetch landed inside the outage of a test above.
    async function openWithSurveysListFailing(page: Page, title: string, alsoFails: (url: string) => boolean) {
      await loginAsUser(page, student, course);
      await seedPublishedSurvey(title, Date.now() + 30 * 60_000);
      let listFailed = false;
      await page.route(/\/rest\/v1\/surveys\?/, async (route) => {
        const url = route.request().url();
        if (isSurveysList(url)) listFailed = true;
        if (isSurveysList(url) || alsoFails(url)) {
          await route.abort("failed");
          return;
        }
        await route.fallback();
      });
      await page.goto(`/course/${course.id}`);
      await surveysToComplete(page)
        .getByRole("link", { name: new RegExp(title) })
        .click();
      return () => listFailed;
    }

    test("still opens after the controller's list failed to load", async ({ page }) => {
      const listFailed = await openWithSurveysListFailing(page, "List Failed", () => false);

      await expect(surveyHeading(page, "List Failed")).toBeVisible();
      expect(listFailed()).toBe(true);
      expect(await notFoundToasts(page).count()).toBe(0);
    });

    test("leaves for the list if the survey can't be fetched either", async ({ page }) => {
      const listFailed = await openWithSurveysListFailing(page, "All Failed", () => true);

      await page.waitForURL(new RegExp(`/course/${course.id}/surveys$`));
      expect(listFailed()).toBe(true);
    });

    test("still opens after it was visited before it opened", async ({ page }) => {
      const { surveys, dueAt } = await openDashboard(page, "Already Open");
      const surveyId = await seedPublishedSurvey("Opens Later", dueAt + 5 * 60_000, Date.now() + 60 * 60_000);
      // A client-side navigation, so the same controller is the one that remembers it found nothing.
      const push = (url: string) =>
        page.evaluate((target) => {
          (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push(target);
        }, url);

      await push(`/course/${course.id}/surveys/${surveyId}`);
      await page.waitForURL(new RegExp(`/course/${course.id}/surveys$`));

      const { error } = await supabase
        .from("surveys")
        .update({ available_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", surveyId);
      if (error) throw new Error(`Failed to open survey: ${error.message}`);

      await push(`/course/${course.id}`);
      await expect(surveys.getByText("Already Open")).toBeVisible();
      await showAgain(page);
      await expect(surveys.getByText("Opens Later")).toBeVisible();
      await surveys.getByRole("link", { name: /Opens Later/ }).click();

      await expect(surveyHeading(page, "Opens Later")).toBeVisible();
    });
  });

  test("a dashboard opened with the browser clock past the deadline shows Overdue at once", async ({ page }) => {
    await loginAsUser(page, student, course);
    const dueAt = Date.now() + 5 * 60_000;
    await seedPublishedSurvey("Clock Ahead Survey", dueAt);

    // The server renders "Due in 5 minutes"; the browser's clock is already past the deadline,
    // as it is for a dashboard restored from the router cache. useNow reads the browser clock on
    // mount, so the card is Overdue before the first 30 s tick.
    // From a blank page, so the dashboard load below is the first page to see the moved clock.
    await page.goto("about:blank");
    await page.clock.install({ time: dueAt + 5 * 60_000 });
    await page.goto(`/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText("Clock Ahead Survey")).toBeVisible();
    await expect(surveys.getByText("Overdue", { exact: true })).toBeVisible();
    await expect(surveys.getByText(/^Was due \d+ minutes ago$/)).toBeVisible();
  });
});
