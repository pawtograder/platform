/**
 * Package 4 go/no-go input: with the taint set and structural blocking alone (no model), does
 * any free text still reach a would-be upload, or render outside `<ReportBlock>`?
 *
 * Visits every route of the canary seed as the user who can see it, with that route listed
 * (student routes at `full`, class-wide ones at `structure`, as the policy rules allow), and
 * reports per route: canary hits in the redacted upload by kind, and free-text anchors rendered
 * outside a `data-report-block` element. Runs only with BUG_REPORT_SWEEP=1; prints
 * `[bug-report sweep]` lines. It asserts nothing about names: the ingest points that fill the
 * taint set belong to package 2.
 */
/* eslint-disable no-console -- results printed for the PR */
import { test } from "../../global-setup";
import { loginAsUser } from "../TestingUtils";
import { scanForCanaries } from "./canaries";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import { redactedUploadBytes } from "./report";
import { enableRecording, waitForRecorderState } from "./recorderTestUtils";
import { routePatternFor } from "./routePatterns";

test.skip(process.env.BUG_REPORT_SWEEP !== "1", "go/no-go sweep: set BUG_REPORT_SWEEP=1");

let seed: CanarySeed;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  seed = await seedCanaryClass();
});

test("free text with taint set and blocking only", async ({ page }) => {
  test.setTimeout(1_200_000);
  const results: Record<string, unknown>[] = [];
  const freeTextAnchors = [...seed.registry.values()]
    .filter((e) => e.kind === "free_text")
    .flatMap((e) => e.anchors ?? []);
  for (const [key, url] of Object.entries(seed.routes)) {
    const staff = url.includes("/manage") || url.includes("/grade/");
    const user = staff ? seed.instructor : seed.students[0];
    const pattern = routePatternFor(url);
    await page.context().clearCookies();
    await enableRecording(page, seed.course.id, [{ pattern, level: staff ? "structure" : "full" }]);
    await loginAsUser(page, user, seed.course);
    const row: Record<string, unknown> = { key, pattern };
    try {
      await page.goto(url);
      await waitForRecorderState(page, "recording");
      await page.waitForLoadState("networkidle").catch(() => {});
      const bytes = await redactedUploadBytes(page);
      const text = new TextDecoder().decode(bytes);
      const hits = scanForCanaries(text, seed.registry).filter((h) => {
        if (h.entry.kind !== "grade") return true;
        return !/[0-9.]/.test(text[h.offset - 1] ?? "") && !/[0-9]/.test(text[h.offset + h.matched.length] ?? "");
      });
      const byKind: Record<string, string[]> = {};
      for (const h of hits)
        (byKind[h.entry.kind] ??= []).push(`${h.entry.column} "${h.matched}" …${h.context.slice(20, 100)}…`);
      for (const k of Object.keys(byKind)) byKind[k] = [...new Set(byKind[k])].slice(0, 5);
      row.uploadHits = byKind;
      row.unblockedFreeText = await page.evaluate((anchors) => {
        const out: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const t = (node.textContent ?? "").toLowerCase();
          const el = node.parentElement;
          if (!el || el.closest("[data-report-block], script, style")) continue;
          const a = anchors.find((x) => t.includes(x));
          if (a)
            out.push(
              `${el.closest("[data-sentry-component]")?.getAttribute("data-sentry-component") ?? el.tagName}: ${t.slice(0, 60)}`
            );
        }
        return out;
      }, freeTextAnchors);
    } catch (e) {
      row.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    }
    results.push(row);
    console.log(`[bug-report sweep] ${JSON.stringify(row)}`);
  }
});
