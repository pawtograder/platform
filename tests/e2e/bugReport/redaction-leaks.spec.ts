/**
 * Package 3 leak tests (PR tier): D3, D8-D15, D17. Each one ends with
 * `scanForCanaries(would-be upload) = []`, where the would-be upload is what
 * `redactedUploadBytes` returns: the recorder's frozen buffer redacted in the worker, plus the
 * replay event's fields and the feedback payload.
 *
 * Needs a build made with E2E_ENABLE=true (the harness page, the test route policy, and the
 * redaction test hook are compiled out otherwise). No Sentry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { addDays } from "date-fns";
import type { Page } from "@playwright/test";
import { test, expect } from "../../global-setup";
import { loginAsUser, supabase, type TestingUser } from "../TestingUtils";
import { describeHits, scanForCanaries, type CanaryHit } from "./canaries";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import type { CanaryEntry } from "./canaryRegistry";
import { redactedReport, redactedUploadBytes, waitForRecording } from "./report";
import { allSerializedNodes, enableRecording } from "./recorderTestUtils";
import type { RoutePolicyEntry } from "@/lib/bugReport/routePolicy";
import { UNMASK_COMPONENT_FILES } from "@/app/course/[course_id]/e2e-harness/bug-report/leakValues";

const HARNESS: RoutePolicyEntry = { pattern: "/course/[course_id]/e2e-harness/bug-report", level: "full" };
const ROOT = path.join(__dirname, "..", "..", "..");

let seed: CanarySeed;
let surveyUuid: string;

function canary(kind: CanaryEntry["kind"], column: string, rowId?: string | number): string {
  for (const [value, entry] of seed.registry) {
    if (entry.kind === kind && entry.column === column && (rowId === undefined || entry.rowId === rowId)) return value;
  }
  throw new Error(`no ${kind} canary for ${column}${rowId === undefined ? "" : ` row ${rowId}`}`);
}

/** One animation frame, so rrweb's mutation observer has emitted what the last step rendered. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
}

async function expectNoCanaries(page: Page, options?: Parameters<typeof redactedUploadBytes>[1]) {
  await settle(page);
  const bytes = await redactedUploadBytes(page, options);
  const text = new TextDecoder().decode(bytes);
  const hits = scanForCanaries(text, seed.registry).filter((h) => !insideLongerNumber(h, text));
  expect(hits, describeHits(hits)).toEqual([]);
  return text;
}

/**
 * A grade canary such as "88.36" also matches inside unrelated numbers, like the SVG path
 * "l588.36 454.73" of an icon. Those aren't leaks of the grade.
 */
function insideLongerNumber(hit: CanaryHit, text: string): boolean {
  if (hit.entry.kind !== "grade") return false;
  const before = text[hit.offset - 1] ?? "";
  const after = text[hit.offset + hit.matched.length] ?? "";
  return /[0-9.]/.test(before) || /[0-9]/.test(after);
}

/** Text nodes in the live page containing `needle` that are not inside a `data-report-block` element. */
async function unblockedOccurrences(page: Page, needle: string): Promise<string[]> {
  return page.evaluate((n) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (!text.toLowerCase().includes(n.toLowerCase())) continue;
      const el = node.parentElement;
      if (!el || el.closest("[data-report-block]") || el.closest("script, style")) continue;
      out.push(
        `${el.tagName.toLowerCase()}[data-sentry-component=${el.closest("[data-sentry-component]")?.getAttribute("data-sentry-component") ?? "?"}]: ${text.slice(0, 80)}`
      );
    }
    return out;
  }, needle);
}

async function openRecorded(page: Page, user: TestingUser, url: string, policy: RoutePolicyEntry[] = []) {
  await enableRecording(page, seed.course.id, policy);
  await loginAsUser(page, user, seed.course);
  await page.goto(url);
  await waitForRecording(page);
}

test.describe("bug report redaction leak tests", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    seed = await seedCanaryClass();
    // A survey with a submitted response from the first student, for the taint-block page (D3).
    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: seed.course.id,
        created_by: seed.instructor.public_profile_id,
        assigned_to_all: true,
        json: { pages: [{ name: "p1", elements: [{ type: "comment", name: "feedback", title: "Feedback" }] }] },
        version: 1,
        status: "published",
        title: "Canary Survey",
        description: "Canary survey",
        due_date: addDays(new Date(), 7).toISOString()
      })
      .select("id, survey_id")
      .single();
    if (error || !survey) throw new Error(`survey seed failed: ${error?.message}`);
    surveyUuid = survey.survey_id;
    const { error: responseError } = await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: seed.students[0].private_profile_id,
      response: { feedback: "The canary survey answer" },
      is_submitted: true,
      submitted_at: new Date().toISOString()
    });
    if (responseError) throw new Error(`survey response seed failed: ${responseError.message}`);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([seed?.instructor, seed?.students[0]]);
  });

  function leakValues() {
    const [a, b] = seed.students;
    return {
      name: a.private_profile_name,
      otherName: b.private_profile_name,
      email: a.email,
      handle: canary("handle", "users.github_username", a.user_id)
    };
  }

  async function openLeakHarness(page: Page) {
    const v = leakValues();
    await openRecorded(
      page,
      seed.students[0],
      `/course/${seed.course.id}/e2e-harness/bug-report?fixture=leaks&v=${encodeURIComponent(JSON.stringify(v))}`,
      [HARNESS]
    );
    await expect(page.getByTestId("leak-fixture")).toBeVisible();
    return v;
  }

  test("D8-D10, D17: split names, derived forms, attributes, title and URL on the harness", async ({ page }) => {
    const workers: string[] = [];
    page.on("worker", (w) => workers.push(w.url()));
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
      );
    });
    const v = await openLeakHarness(page);
    // D10: a value typed into an unmasked input is recorded as an input event.
    await page.getByTestId("d10-input").fill(v.email);
    await expect(page).toHaveTitle(new RegExp(v.name));

    // The raw recording holds the canaries: the fixture is unmasked, so only the walker helps.
    const raw = await page.evaluate(() => JSON.stringify(window.__bugReportRecorder!.freeze()));
    expect(scanForCanaries(raw, seed.registry).length).toBeGreaterThan(0);

    const upload = await expectNoCanaries(page);
    const report = await redactedReport(page);
    expect(report.worker).toBe(true);
    expect(workers.some((u) => u.includes("/_next/static/"))).toBe(true);
    const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    // The worker loads under the app's CSP (report-only in E2E builds, so violations are reported
    // rather than blocked; the test polls with page.evaluate, which reports nothing).
    expect(csp).toEqual([]);

    // The review list has no canary, and still shows the harness's own text.
    const remainingHits = scanForCanaries(JSON.stringify(report.remaining), seed.registry);
    expect(remainingHits, describeHits(remainingHits)).toEqual([]);
    expect(report.remaining.some((r) => r.value.includes("Email the student"))).toBe(true);
    for (const kind of ["text", "attribute", "url"]) {
      expect(
        report.remaining.some((r) => r.kind === kind),
        `remaining has ${kind}`
      ).toBe(true);
    }
    // D17: the URL (whose query holds every canary) is uploaded with the canaries masked, and
    // the title, when the recording has it, shows only mask characters where the name was.
    expect(upload).toContain("fixture=leaks&v=");
    for (const title of report.remaining.filter((r) => r.kind === "title")) {
      expect(title.value).not.toContain(v.name);
    }
    expect(await page.title()).toContain(v.name);
  });

  test("D11: console.log of a profile object", async ({ page }) => {
    const v = await openLeakHarness(page);
    await page.evaluate((profile) => {
      // eslint-disable-next-line no-console
      console.log("profile loaded", profile);
    }, v);
    await expectNoCanaries(page);
  });

  test("D12: a name inserted 30 s after load", async ({ page }) => {
    await page.clock.install();
    const v = await openLeakHarness(page);
    await expect(page.getByTestId("d12-late")).toHaveText("Assigned to: nobody yet");
    await page.clock.fastForward(31_000);
    await expect(page.getByTestId("d12-late")).toHaveText(`Assigned to: ${v.otherName}`);
    await expectNoCanaries(page);
  });

  test("D15: every data-report-unmask component, fed canaries through props", async ({ page }) => {
    // Every source file carrying the attribute must be rendered by the leaks fixture.
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry.name) && /data-report-unmask(=|\s|>)/.test(fs.readFileSync(p, "utf8")))
          found.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, "app"));
    walk(path.join(ROOT, "components"));
    const components = found.filter((f) => !f.includes("e2e-harness/bug-report/harness.tsx"));
    expect([...components].sort()).toEqual([...UNMASK_COMPONENT_FILES].sort());

    await openLeakHarness(page);
    await expect(page.getByTestId("unmask-harness-name")).toHaveText(leakValues().name);
    await expectNoCanaries(page);
  });

  test("D13: help-request body and discussion post are blocked placeholders", async ({ page }) => {
    const student = seed.students[0];
    const anchors = (column: string) =>
      [...seed.registry.values()].filter((e) => e.column === column).flatMap((e) => e.anchors ?? []);

    await openRecorded(page, student, seed.routes.helpRequest, [
      { pattern: "/course/[course_id]/office-hours/request/[request_id]", level: "structure" }
    ]);
    // The request page shows the chat (the messages); the request body shows in the queue list.
    const messageAnchor = anchors("help_request_messages.message")[0];
    await expect(page.getByText(new RegExp(messageAnchor, "i")).first()).toBeAttached();
    for (const a of [...anchors("help_requests.request"), ...anchors("help_request_messages.message")]) {
      expect(await unblockedOccurrences(page, a), `help request text "${a}"`).toEqual([]);
    }
    await settle(page);
    const buffer = (await redactedReport(page)).buffer;
    expect(allSerializedNodes(buffer).some((n) => n.attributes?.rr_width !== undefined)).toBe(true);
    await expectNoCanaries(page);

    // The request body, in the student's own request list.
    await page.goto(`${seed.routes.officeHours}?view=my-requests`);
    await waitForRecording(page);
    const requestAnchor = anchors("help_requests.request")[0];
    await expect(page.getByText(new RegExp(requestAnchor, "i")).first()).toBeAttached();
    for (const a of anchors("help_requests.request")) {
      expect(await unblockedOccurrences(page, a), `help request body "${a}"`).toEqual([]);
    }
    await expectNoCanaries(page);

    await page.goto(seed.routes.discussionThread);
    await waitForRecording(page);
    const bodyAnchor = anchors("discussion_threads.body")[0];
    await expect(page.getByText(new RegExp(bodyAnchor, "i")).first()).toBeAttached();
    for (const a of [...anchors("discussion_threads.body"), ...anchors("discussion_threads.subject")]) {
      expect(await unblockedOccurrences(page, a), `discussion text "${a}"`).toEqual([]);
    }
    await expectNoCanaries(page);
  });

  test("D14: grade canaries are in blocked cells", async ({ page }) => {
    const grades = (rowFilter?: (e: CanaryEntry) => boolean) =>
      [...seed.registry].filter(([, e]) => e.kind === "grade" && (!rowFilter || rowFilter(e))).map(([v]) => v);

    // The student's own gradebook (level full).
    await openRecorded(page, seed.students[0], seed.routes.studentGradebook);
    const own = grades();
    await expect
      .poll(async () => {
        for (const g of own) if ((await page.getByText(g).count()) > 0) return true;
        return false;
      })
      .toBe(true);
    for (const g of own) expect(await unblockedOccurrences(page, g), `grade ${g}`).toEqual([]);
    await expectNoCanaries(page);
  });

  test("D14: instructor gradebook cells are blocked", async ({ page }) => {
    await openRecorded(page, seed.instructor, seed.routes.manageGradebook, [
      { pattern: "/course/[course_id]/manage/gradebook", level: "structure" }
    ]);
    const all = [...seed.registry].filter(([, e]) => e.kind === "grade").map(([v]) => v);
    await expect
      .poll(async () => {
        for (const g of all) if ((await page.getByText(g).count()) > 0) return true;
        return false;
      })
      .toBe(true);
    for (const g of all) expect(await unblockedOccurrences(page, g), `grade ${g}`).toEqual([]);
    await expectNoCanaries(page);
  });

  test("D3: server page with a taint block (survey responses)", async ({ page }) => {
    const name = seed.students[0].private_profile_name;
    await openRecorded(page, seed.instructor, `/course/${seed.course.id}/manage/surveys/${surveyUuid}/responses`);
    await expect(page.getByText(name).first()).toBeVisible();
    const block = await page.locator('script#report-taint[type="application/json"]').textContent();
    expect(JSON.parse(block ?? "{}").values.name).toContain(name);
    expect(await unblockedOccurrences(page, "The canary survey answer")).toEqual([]);
    await expectNoCanaries(page);
  });
});
