import { test as base, Page } from "@playwright/test";
import { logMagicLink, supabase, TestingUser } from "@/tests/e2e/TestingUtils";
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

// On failure, dump DB state relevant to the failing test so CI artifacts
// carry enough context to root-cause data-state flakes that don't reproduce
// locally. Intentionally cheap and bounded: a handful of small queries scoped
// to the current course, plus a global anomaly scan that returns at most a
// few rows. Failures inside this helper must never mask the underlying test
// error, so everything is wrapped in try/catch.
async function collectFailureDiagnostics(page: Page) {
  const url = page.url();
  const courseMatch = url.match(/\/course\/(\d+)/);
  const courseId = courseMatch ? Number(courseMatch[1]) : null;

  const diag: Record<string, unknown> = {
    url,
    courseId,
    capturedAt: new Date().toISOString()
  };

  if (courseId != null) {
    const [topics, userRoles, assignments, threads, helpQueues] = await Promise.all([
      supabase
        .from("discussion_topics")
        .select("id, topic, ordinal, color, description")
        .eq("class_id", courseId)
        .order("id"),
      supabase.from("user_roles").select("id, role, user_id, private_profile_id").eq("class_id", courseId),
      supabase.from("assignments").select("id, title, slug, group_config, due_date").eq("class_id", courseId),
      supabase.from("discussion_threads").select("id, subject, topic_id").eq("class_id", courseId).is("parent", null),
      supabase.from("help_queues").select("id, name").eq("class_id", courseId)
    ]);

    diag.course = {
      topics: { count: topics.data?.length, rows: topics.data, error: topics.error?.message },
      userRoles: { count: userRoles.data?.length, rows: userRoles.data, error: userRoles.error?.message },
      assignments: { count: assignments.data?.length, rows: assignments.data, error: assignments.error?.message },
      rootThreads: { count: threads.data?.length, rows: threads.data, error: threads.error?.message },
      helpQueues: { count: helpQueues.data?.length, rows: helpQueues.data, error: helpQueues.error?.message }
    };
  }

  // Global anomaly scan: any class with > 4 default discussion_topics? Those
  // would indicate the trigger fired twice (or two trigger functions). This
  // is the exact shape we saw in CI artifacts for the discussion-threads
  // strict-mode locator failures (course/30 had 8 topics).
  //
  // We can't easily run a GROUP BY ... HAVING through PostgREST, so fetch a
  // bounded sample of just the default topic names and aggregate in JS. With
  // 4 default topics × ~hundreds-of-classes in CI, the 5000-row cap is plenty.
  const allTopics = await supabase
    .from("discussion_topics")
    .select("class_id, topic")
    .in("topic", ["Assignments", "Logistics", "Readings", "Memes"])
    .limit(5000);
  if (allTopics.error) {
    diag.anomalies = { error: allTopics.error.message };
  } else if (allTopics.data) {
    const counts = new Map<number, number>();
    for (const t of allTopics.data) {
      counts.set(t.class_id, (counts.get(t.class_id) ?? 0) + 1);
    }
    diag.anomalies = {
      classesWithDuplicateDefaultTopics: Array.from(counts.entries())
        .filter(([, c]) => c > 4)
        .map(([class_id, count]) => ({ class_id, defaultTopicCount: count }))
    };
  }

  // Bounded slice of recent classes, useful for narrowing whether CI is
  // looking at the right class when a failure URL is /course/N.
  const recentClasses = await supabase
    .from("classes")
    .select("id, name, slug")
    .order("id", { ascending: false })
    .limit(10);
  diag.recentClasses = recentClasses.data;

  return diag;
}

const VISUAL_TEST_CSS = `
  /* Visual test override - remove all border radius */
  html[data-visual-tests] *,
  html[data-visual-tests] *::before,
  html[data-visual-tests] *::after {
    border-radius: 0 !important;
    border-top-left-radius: 0 !important;
    border-top-right-radius: 0 !important;
    border-bottom-left-radius: 0 !important;
    border-bottom-right-radius: 0 !important;
  }

  /*
   * Preserve accessible/text queryability while replacing volatile values with
   * stable placeholders in screenshots. Transparent text alone can still
   * change layout when a date or relative time is longer in one run than
   * another, so visual mode fixes inline sizing and paints deterministic
   * pseudo-content instead.
   */
  html[data-visual-tests] [data-visual-test="transparent"] {
    --visual-test-placeholder: "████████████";
    --visual-test-placeholder-width: 18ch;
    display: inline-block !important;
    inline-size: var(--visual-test-placeholder-width) !important;
    max-inline-size: var(--visual-test-placeholder-width) !important;
    min-inline-size: var(--visual-test-placeholder-width) !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    vertical-align: baseline !important;
    position: relative !important;
    color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
  }

  html[data-visual-tests] [data-visual-test="transparent"]::after {
    content: var(--visual-test-placeholder) !important;
    position: absolute !important;
    inset-inline-start: 0 !important;
    inset-block-start: 0 !important;
    color: CanvasText !important;
    opacity: 0.22 !important;
    font: inherit !important;
    letter-spacing: 0 !important;
    pointer-events: none !important;
  }

  html[data-visual-tests] [data-visual-test="transparent"] * {
    color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
  }

  html[data-visual-tests] [data-visual-placeholder="date"] {
    --visual-test-placeholder: "MMM 00, 0000 00:00 TZ";
    --visual-test-placeholder-width: 22ch;
  }

  html[data-visual-tests] [data-visual-placeholder="relative-time"] {
    --visual-test-placeholder: "relative time";
    --visual-test-placeholder-width: 16ch;
  }

  html[data-visual-tests] [data-visual-placeholder="timestamp"] {
    --visual-test-placeholder: "timestamp";
    --visual-test-placeholder-width: 12ch;
  }

  html[data-visual-tests] [data-visual-placeholder="review-status"] {
    --visual-test-placeholder: "review date/status";
    --visual-test-placeholder-width: 28ch;
  }

  html[data-visual-tests] [data-visual-placeholder="repository"] {
    --visual-test-placeholder: "org/repo-NN";
    --visual-test-placeholder-width: 28ch;
  }

  html[data-visual-tests] [data-visual-placeholder="request-id"] {
    --visual-test-placeholder: "Request #NNN";
    --visual-test-placeholder-width: 12ch;
  }

  html[data-visual-tests] [data-visual-placeholder="submission-id"] {
    --visual-test-placeholder: "NN";
    --visual-test-placeholder-width: 4ch;
  }

  html[data-visual-tests] [data-visual-test="transparent"] svg,
  html[data-visual-tests] [data-visual-test="transparent"] img,
  html[data-visual-tests] [data-visual-test="transparent"] canvas {
    opacity: 0 !important;
  }

  /*
   * Remove transient UI entirely. The element remains in the DOM, but does
   * not affect visual layout or screenshots while visual tests are active.
   */
  html[data-visual-tests] [data-visual-test="removed"] {
    display: none !important;
  }

  /*
   * The grading summary aside is normally position:sticky + height:100vh +
   * overflow:auto so the rubric stays in view while the user scrolls the
   * code/files column. Playwright's fullPage screenshot tiles the page; that
   * tile flow plus the sticky+overflow combination means the rubric content
   * can be captured at an inconsistent internal scrollTop between runs (e.g.
   * empty in run A, populated in run B). Inside visual tests we collapse all
   * three so the aside lays out at its natural height with no internal
   * scroll, and the rubric content lands at the same y coordinates every
   * time.
   */
  html[data-visual-tests] [data-grading-summary-aside] {
    position: static !important;
    top: auto !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }

  /*
   * The "Annotate line N with a check:" popup positions itself with
   * position:fixed at the right-click clientY/clientX. Playwright's fullPage
   * screenshot effectively reinterprets fixed coords as document coords, so
   * any difference in scrollY at right-click time shifts the popup's final y
   * between runs. Pinning the popup to top-left (with a small visible margin)
   * during visual tests removes that source of variability without changing
   * production layout. The screenshot still verifies the popup contents.
   */
  html[data-visual-tests] [data-annotation-popup] {
    position: absolute !important;
    top: 200px !important;
    left: 200px !important;
  }

  /*
   * Universal animation / transition kill switch. Any in-flight animation
   * (Chakra Skeleton shimmer, route loading skeletons, button hover
   * transitions, focus rings, NavigationProgressBar's keyframed shimmer,
   * lucide icon spinners, etc.) lands at a non-deterministic frame depending
   * on when Playwright captures the page. Forcing every animation/transition
   * to a zero duration paints the steady-state on the first frame, so the
   * screenshot is reproducible.
   *
   * 'caret-color: transparent' removes the blinking text-cursor inside any
   * focused input — its position is captured intermittently by fullPage
   * screenshots even when the rest of the page is otherwise idle.
   */
  html[data-visual-tests] *,
  html[data-visual-tests] *::before,
  html[data-visual-tests] *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }

  html[data-visual-tests] input,
  html[data-visual-tests] textarea,
  html[data-visual-tests] [contenteditable="true"] {
    caret-color: transparent !important;
  }

  /*
   * Skeletons paint a shimmering linear-gradient via @chakra-ui/react that
   * cycles every ~1.2s. Zeroing animations above stops the cycle, but a
   * frozen gradient stop still differs run-to-run depending on which frame
   * the browser had advanced to when the screenshot was taken. Replace the
   * gradient with a flat fill in visual mode so the painted skeleton is
   * byte-identical between runs.
   */
  html[data-visual-tests] .chakra-skeleton,
  html[data-visual-tests] [data-part="skeleton"],
  html[data-visual-tests] [data-scope="skeleton"] {
    background: var(--chakra-colors-bg-muted, #e2e8f0) !important;
    background-image: none !important;
  }

  /*
   * The NavigationProgressBar overlays the top 2-3px of the viewport with a
   * keyframed shimmer for ~600ms after every client-side route change. It
   * shows up as a thin colored band in the top edge of fullPage screenshots
   * captured just after a navigation. Hide it entirely in visual mode — the
   * production code path is unchanged.
   */
  html[data-visual-tests] [data-navigation-progress],
  html[data-visual-tests] .nav-progress-bar {
    display: none !important;
  }

`;

// Function to inject visual test setup
const injectVisualTestSetup = async (page: Page) => {
  // Best-effort: this fires from a `domcontentloaded` handler, so an in-flight
  // client-side navigation can destroy the execution context mid-evaluate
  // ("Execution context was destroyed, most likely because of a navigation").
  // The next domcontentloaded re-injects, and addInitScript covers fresh loads,
  // so a single lost injection is harmless — swallow it rather than letting it
  // surface as a spurious test failure on whatever step happened to be running.
  await page
    .evaluate((visualTestCss) => {
      // Set the data-visual-tests attribute on the html element
      if (document.documentElement) {
        document.documentElement.setAttribute("data-visual-tests", "");
      }

      // Check if our style is already injected to avoid duplicates
      if (!document.getElementById("visual-test-style")) {
        // Create and inject CSS that removes all border-radius
        const style = document.createElement("style");
        style.id = "visual-test-style";
        style.textContent = visualTestCss;
        if (document.head) {
          document.head.appendChild(style);
        }
      }
    }, VISUAL_TEST_CSS)
    .catch(() => {
      /* navigation destroyed the context — the next domcontentloaded re-injects */
    });
};

type E2EFixtures = {
  logMagicLinksOnFailure: (users: (TestingUser | undefined)[]) => Promise<void>;
  _autoFailureDiagnostics: void;
};

// Extend the base test to include visual test setup
export const test = base.extend<E2EFixtures>({
  logMagicLinksOnFailure: async ({}, use, testInfo) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(async (users) => {
      if (testInfo.status === testInfo.expectedStatus) return;
      await logMagicLink(users);
    });
  },
  // Auto-fixture (`auto: true`) so every test gets failure diagnostics
  // without opt-in. Depends on `page` so the post-test block can read the
  // failing URL.
  _autoFailureDiagnostics: [
    async ({ page }, use, testInfo) => {
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      try {
        const diag = await collectFailureDiagnostics(page);
        // Path-based attach: body-based testInfo.attach({ body: Buffer })
        // is silently dropped by Playwright's HTML reporter in our CI setup
        // (verified empirically — the fixture ran and the attach call
        // resolved, but nothing landed in playwright-report/data/). Writing
        // the file to testInfo.outputPath() first and attaching by `path:`
        // routes through the reporter's normal file-copy flow.
        const diagPath = testInfo.outputPath("db-state.json");
        mkdirSync(path.dirname(diagPath), { recursive: true });
        writeFileSync(diagPath, JSON.stringify(diag, null, 2));
        await testInfo.attach("db-state.json", {
          contentType: "application/json",
          path: diagPath
        });
      } catch (err) {
        // Never let diagnostics swallow the underlying failure. Attach the
        // error string so we can spot diagnostics regressions, but don't
        // rethrow.
        await testInfo
          .attach("db-state-error.txt", {
            contentType: "text/plain",
            body: Buffer.from(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err))
          })
          .catch(() => {});
      }
    },
    { auto: true }
  ],
  page: async ({ page }, use) => {
    // Set up initial script for new page loads
    await page.addInitScript((visualTestCss) => {
      // Set the data-visual-tests attribute on the html element
      if (document.documentElement) {
        document.documentElement.setAttribute("data-visual-tests", "");
      }

      // Check if our style is already injected to avoid duplicates
      if (!document.getElementById("visual-test-style")) {
        // Create and inject CSS that removes all border-radius
        const style = document.createElement("style");
        style.id = "visual-test-style";
        style.textContent = visualTestCss;
        if (document.head) {
          document.head.appendChild(style);
        }
      }
    }, VISUAL_TEST_CSS);

    // Listen for all navigations and re-inject the setup
    page.on("domcontentloaded", async () => {
      await injectVisualTestSetup(page);
    });

    // Also inject on the current page if it's already loaded
    await injectVisualTestSetup(page);

    // Not a hook!
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  }
});

export { expect } from "@playwright/test";
