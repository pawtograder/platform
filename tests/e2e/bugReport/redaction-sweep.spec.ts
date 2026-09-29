/**
 * Package 4 go/no-go input: with the taint set and structural blocking alone (no model), does
 * any free text still reach a would-be upload, or render outside `<ReportBlock>`?
 *
 * Visits every route of the canary seed as the user who can see it, with that route listed
 * (student routes at `full`, class-wide ones at `structure`, as the policy rules allow), and
 * reports per route: canary hits in the redacted upload by kind, and free-text anchors rendered
 * outside a `data-report-block` element. Runs only with BUG_REPORT_SWEEP=1; prints
 * `[bug-report sweep]` lines. Only free text fails the test: names depend on the ingest points
 * that fill the taint set (package 2).
 */
/* eslint-disable no-console -- results printed for the PR */
import { test, expect } from "../../global-setup";
import { loginAsUser } from "../TestingUtils";
import { scanForCanaries } from "./canaries";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import { redactedUploadBytes } from "./report";
import { enableRecording, waitForRecorderState } from "./recorderTestUtils";
import { routePatternFor } from "./routePatterns";

test.skip(process.env.BUG_REPORT_SWEEP !== "1", "go/no-go sweep: set BUG_REPORT_SWEEP=1");

const ROUTE_KEYS = [
  "studentDashboard",
  "studentAssignments",
  "studentAssignment",
  "studentSubmission",
  "studentGrade",
  "studentGradebook",
  "officeHours",
  "helpRequest",
  "discussion",
  "discussionThread",
  "manageDashboard",
  "manageAssignments",
  "manageAssignment",
  "manageGroups",
  "graderSubmission",
  "graderSubmissionFiles",
  "manageGradebook",
  "manageEnrollments",
  "manageStudent",
  "manageOfficeHours",
  "manageHelpRequest",
  "manageDiscussionEngagement"
] as const;

let seed: CanarySeed;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  seed = await seedCanaryClass();
});

for (const key of ROUTE_KEYS) {
  test(`sweep ${key}`, async ({ page }) => {
    test.setTimeout(120_000);
    const url = (seed.routes as Record<string, string>)[key];
    const staff = url.includes("/manage") || url.includes("/grade/");
    const pattern = routePatternFor(url);
    await enableRecording(page, seed.course.id, [{ pattern, level: staff ? "structure" : "full" }]);
    await loginAsUser(page, staff ? seed.instructor : seed.students[0], seed.course);
    await page.goto(url);
    await waitForRecorderState(page, "recording");
    await page.waitForLoadState("load");
    // Let the page's data arrive and render; poll until the DOM stops growing.
    let last = -1;
    await expect
      .poll(
        async () => {
          const n = await page.evaluate(() => document.body.innerText.length);
          const stable = n === last;
          last = n;
          return stable;
        },
        { intervals: [1_000], timeout: 30_000 }
      )
      .toBe(true)
      .catch(() => {});
    const text = new TextDecoder().decode(await redactedUploadBytes(page));
    const hits = scanForCanaries(text, seed.registry).filter((h) => {
      if (h.entry.kind !== "grade") return true;
      return !/[0-9.]/.test(text[h.offset - 1] ?? "") && !/[0-9]/.test(text[h.offset + h.matched.length] ?? "");
    });
    const byKind: Record<string, string[]> = {};
    for (const h of hits) {
      (byKind[h.entry.kind] ??= []).push(`${h.entry.column} "${h.matched}" …${h.context.slice(20, 100)}…`);
    }
    for (const k of Object.keys(byKind)) byKind[k] = [...new Set(byKind[k])].slice(0, 5);
    const anchors = [...seed.registry.values()].filter((e) => e.kind === "free_text").flatMap((e) => e.anchors ?? []);
    const unblocked = await page.evaluate((list) => {
      const out: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const t = (node.textContent ?? "").toLowerCase();
        const el = node.parentElement;
        if (!el || el.closest("[data-report-block], script, style")) continue;
        if (!list.some((a) => t.includes(a))) continue;
        const component = el.closest("[data-sentry-component]")?.getAttribute("data-sentry-component") ?? el.tagName;
        out.push(`${component}: ${t.slice(0, 60)}`);
      }
      return out;
    }, anchors);
    console.log(
      `[bug-report sweep] ${JSON.stringify({ key, pattern, uploadHits: byKind, unblockedFreeText: unblocked })}`
    );
    expect(byKind.free_text ?? [], "free text in the upload").toEqual([]);
    expect(unblocked, "free text outside <ReportBlock>").toEqual([]);
  });
}
