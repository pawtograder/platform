import { test as base, Page } from "@playwright/test";
import { logMagicLink, supabase, TestingUser } from "@/tests/e2e/TestingUtils";

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

// Function to inject visual test setup
const injectVisualTestSetup = async (page: Page) => {
  await page.evaluate(() => {
    // Set the data-visual-tests attribute on the html element
    if (document.documentElement) {
      document.documentElement.setAttribute("data-visual-tests", "");
    }

    // Check if our style is already injected to avoid duplicates
    if (!document.getElementById("visual-test-style")) {
      // Create and inject CSS that removes all border-radius
      const style = document.createElement("style");
      style.id = "visual-test-style";
      style.textContent = `
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
      `;
      if (document.head) {
        document.head.appendChild(style);
      }
    }
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
        await testInfo.attach("db-state.json", {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify(diag, null, 2))
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
    await page.addInitScript(() => {
      // Set the data-visual-tests attribute on the html element
      if (document.documentElement) {
        document.documentElement.setAttribute("data-visual-tests", "");
      }

      // Check if our style is already injected to avoid duplicates
      if (!document.getElementById("visual-test-style")) {
        // Create and inject CSS that removes all border-radius
        const style = document.createElement("style");
        style.id = "visual-test-style";
        style.textContent = `
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
        `;
        if (document.head) {
          document.head.appendChild(style);
        }
      }
    });

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
