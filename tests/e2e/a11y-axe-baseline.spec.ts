/**
 * axe-core baseline for the a11y-judge mutation gauntlet (repo-coupled).
 *
 * Opt-in only: `test.skip(!process.env.A11Y_AXE_BASELINE)`. Seeds the same nine
 * student pages as tests/e2e/a11y-evidence.spec.ts, then scans every
 * (variant, page) with axe-core and writes the raw results under
 *   a11y-axe-baseline/<runId>/<variant>/<pageId>/<state>.<config>.json
 * for tools/a11y-judge/axe-baseline/analyze.ts to diff.
 *
 * Variants: two clean runs (clean-a, clean-b; their disagreement is the noise
 * floor) plus one per seeded mutation, applied exactly as the evidence driver
 * applies it (addInitScript before login, restricted to the mutation's pageIds).
 *
 * Configs, per scan:
 *   gate          what CI enforces: WCAG 2.1 AA tags + heading-order, with
 *                 DEFAULT_EXCLUDES (tests/e2e/axeStudentA11y.ts)
 *   full          every enabled axe rule (incl. best-practice), no excludes
 *   experimental  axe's experimental rules only, no excludes
 *
 * States: every page is scanned after load. survey-taking is also scanned in
 * its invalid-submit error state (3.3.1) and after the autosave interaction
 * the evidence driver records for 4.1.3.
 *
 * Restrict with A11Y_AXE_VARIANTS=<csv> and A11Y_AXE_PAGES=<csv>. Set
 * A11Y_AXE_COLOR_SCHEME=dark to scan in dark mode (default light).
 */
import fs from "fs";
import path from "path";
import { addDays } from "date-fns";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import type { Page as PlaywrightCorePage } from "playwright-core";
import { test, expect } from "../global-setup";
import {
  createClass,
  createRegradeRequest,
  createUsersInClass,
  insertAssignment,
  insertHelpRequest,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { ADDITIONAL_RULES, DEFAULT_EXCLUDES, DEFAULT_WCAG_TAGS } from "./axeStudentA11y";
import { MUTATIONS, type Mutation } from "../../tools/a11y-judge/mutations";
import { SETTLE_MS, settlePage, waitForPageReady } from "../../tools/a11y-judge/agent/pageReady";
import { A11Y_CODE_FILES, A11Y_CODE_FILE_NAME } from "./a11yAgentSeeding";

const OUT_ROOT = path.resolve(process.cwd(), "a11y-axe-baseline");
const RUN_ID = process.env.A11Y_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const CONFIGS = ["gate", "full", "experimental"] as const;
/** The app follows the OS scheme (next-themes, defaultTheme "system"), so this picks light or dark mode. */
const COLOR_SCHEME: "light" | "dark" = process.env.A11Y_AXE_COLOR_SCHEME === "dark" ? "dark" : "light";
test.use({ colorScheme: COLOR_SCHEME });
type AxeConfig = (typeof CONFIGS)[number];

const csv = (v: string | undefined) =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * 243-tabindex-shuffle runs once at DOMContentLoaded, before the client-rendered
 * page mounts, so on today's app no element still carries a positive tabindex
 * when the scan runs. This variant applies the same shuffle after the page is
 * ready, so axe is scored against a defect that is actually present.
 */
const TABINDEX_AFTER_READY = "243-tabindex-shuffle@after-ready";

async function shuffleTabindexAfterReady(page: Page) {
  await page.evaluate((maxElements) => {
    const selector = "a[href], button, input, select, textarea, [tabindex]";
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => {
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && cs.visibility !== "hidden" && cs.display !== "none";
    });
    focusable
      .slice(0, maxElements)
      .reverse()
      .forEach((el, i) => el.setAttribute("tabindex", String(i + 1)));
  }, 12);
}

const ALL_VARIANTS = ["clean-a", "clean-b", ...MUTATIONS.map((m) => m.id), TABINDEX_AFTER_READY];
const VARIANTS = csv(process.env.A11Y_AXE_VARIANTS) ?? ALL_VARIANTS;
for (const v of VARIANTS) {
  if (!ALL_VARIANTS.includes(v)) throw new Error(`Unknown variant "${v}". Known: ${ALL_VARIANTS.join(", ")}`);
}

let course: Awaited<ReturnType<typeof createClass>>;
let student: TestingUser;
let instructor: TestingUser;
let surveyId: string;
const urls: Record<string, string> = {};

// Identical to the evidence driver's survey so the pages match what the judge saw.
const SURVEY_JSON = {
  pages: [
    {
      name: "page1",
      elements: [
        { type: "text", name: "q1", title: "What is your name?", isRequired: true },
        {
          type: "radiogroup",
          name: "q2",
          title: "How is the course pace?",
          choices: ["Too slow", "Just right", "Too fast"]
        },
        { type: "checkbox", name: "q3", title: "Which topics were hardest?", choices: ["Graphs", "DP", "Systems"] },
        { type: "comment", name: "q4", title: "Any other feedback?" }
      ]
    }
  ]
};

type PageSpec = {
  id: string;
  /** Navigate and wait until the page is ready to scan. */
  open(page: Page, mutationTolerant: boolean): Promise<void>;
};

async function ready(page: Page, strict: Locator, fallback: Locator | undefined, mutationTolerant: boolean) {
  await waitForPageReady(page, strict, { structuralFallback: fallback, mutationTolerant });
  await settlePage(page);
}

const PAGES: PageSpec[] = [
  {
    id: "survey-taking",
    async open(page, tolerant) {
      await page.goto(urls.survey);
      await ready(
        page,
        page.getByRole("heading", { name: /what is your name/i }),
        page.locator(".sd-question").first(),
        tolerant
      );
    }
  },
  {
    id: "autograder-results",
    async open(page, tolerant) {
      await page.goto(urls.results);
      await ready(page, page.getByText(/test results/i).first(), undefined, tolerant);
    }
  },
  {
    id: "grade-summary",
    async open(page, tolerant) {
      await page.goto(urls.grade);
      await ready(page, page.getByText(/autograder/i).first(), undefined, tolerant);
    }
  },
  {
    id: "gradebook",
    async open(page, tolerant) {
      await page.goto(urls.gradebook);
      await ready(page, page.getByRole("heading", { name: /gradebook/i }).first(), undefined, tolerant);
    }
  },
  {
    id: "discussion",
    async open(page, tolerant) {
      await page.goto(urls.discussionList);
      await page.waitForTimeout(SETTLE_MS);
      await page.goto(urls.discussionThread);
      await ready(page, page.getByText("Evidence thread subject").first(), undefined, tolerant);
    }
  },
  {
    id: "assignments-list",
    async open(page, tolerant) {
      await page.goto(urls.assignmentsList);
      await ready(page, page.getByText("Evidence Assignment").first(), undefined, tolerant);
    }
  },
  {
    id: "submission-files",
    async open(page, tolerant) {
      await page.goto(urls.submissionFiles);
      await ready(page, page.getByText(A11Y_CODE_FILE_NAME).first(), page.locator(".monaco-editor").first(), tolerant);
      await page
        .locator(".monaco-editor")
        .first()
        .waitFor({ state: "visible", timeout: 60_000 })
        .catch(() => {});
    }
  },
  {
    id: "regrade-requests",
    async open(page, tolerant) {
      await page.goto(urls.regradeRequests);
      await ready(page, page.getByText(/regrade/i).first(), page.locator("#main-content, main").first(), tolerant);
    }
  },
  {
    id: "office-hours",
    async open(page, tolerant) {
      await page.goto(urls.officeHours);
      await ready(
        page,
        page.getByRole("region", { name: /office hours/i }).first(),
        page.locator("#main-content, main").first(),
        tolerant
      );
    }
  }
];
const PAGE_FILTER = csv(process.env.A11Y_AXE_PAGES);
const SELECTED_PAGES = PAGE_FILTER ? PAGES.filter((p) => PAGE_FILTER.includes(p.id)) : PAGES;

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type RuleResult = AxeResults["violations"][number];

function slimRules(rules: RuleResult[]) {
  return rules.map((r) => ({
    id: r.id,
    impact: r.impact,
    tags: r.tags,
    help: r.help,
    nodes: r.nodes.map((n) => ({
      target: n.target,
      html: n.html.slice(0, 240),
      failureSummary: n.failureSummary?.slice(0, 400)
    }))
  }));
}

/** Snap animations to their end state so color sampling is deterministic (mirrors the gate helper). */
async function withFrozenAnimations<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  const id = "axe-baseline-animation-freeze";
  await page
    .evaluate((styleId) => {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `*, *::before, *::after {
        animation-duration: 0s !important; animation-delay: 0s !important;
        transition-duration: 0s !important; transition-delay: 0s !important; }`;
      document.head.appendChild(style);
    }, id)
    .catch(() => {});
  try {
    return await fn();
  } finally {
    await page.evaluate((styleId) => document.getElementById(styleId)?.remove(), id).catch(() => {});
  }
}

async function analyze(page: Page, config: AxeConfig) {
  const builder = () => new AxeBuilder({ page: page as unknown as PlaywrightCorePage });
  const withGateExcludes = (b: AxeBuilder) => DEFAULT_EXCLUDES.reduce((acc, sel) => acc.exclude(sel), b);
  const runs: AxeResults[] = [];
  if (config === "gate") {
    runs.push(await withGateExcludes(builder().withTags(DEFAULT_WCAG_TAGS)).analyze());
    runs.push(await withGateExcludes(builder().withRules(ADDITIONAL_RULES)).analyze());
  } else if (config === "full") {
    runs.push(await builder().analyze());
  } else {
    runs.push(await builder().withTags(["experimental"]).analyze());
  }
  const rulesRun = new Set<string>();
  for (const r of runs) {
    for (const bucket of [r.violations, r.incomplete, r.passes, r.inapplicable]) {
      for (const rule of bucket) rulesRun.add(rule.id);
    }
  }
  return {
    config,
    axeVersion: runs[0]?.testEngine.version,
    violations: slimRules(runs.flatMap((r) => r.violations)),
    incomplete: slimRules(runs.flatMap((r) => r.incomplete)),
    passCount: runs.reduce((n, r) => n + r.passes.length, 0),
    rulesRun: [...rulesRun].sort()
  };
}

/**
 * DOM counts for each mutation's footprint, so a clean axe result on a mutated
 * page can be told apart from a mutation that never took effect.
 */
async function probeMutationFootprint(page: Page) {
  return page.evaluate(() => {
    const count = (sel: string) => document.querySelectorAll(sel).length;
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"));
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    return {
      imgTotal: count("img"),
      imgAltImage: count('img[alt="image"]'),
      svgNamedIcon:
        count('svg[aria-label="icon"]') +
        Array.from(document.querySelectorAll("svg > title")).filter((t) => t.textContent === "icon").length,
      positiveTabindex: Array.from(document.querySelectorAll("[tabindex]")).filter(
        (el) => Number(el.getAttribute("tabindex")) > 0
      ).length,
      headingsTotal: headings.length,
      headingsSection: headings.filter((h) => (h.textContent || "").trim() === "Section").length,
      outlineNoneStyle: Boolean(document.getElementById("__a11y-mut-247-outline-none")),
      surveyQuestionsReordered: count('.sd-question[data-a11y-mut132="done"]'),
      iconButtons: buttons.filter((b) => (b.innerText || "").trim() === "").length,
      iconButtonsWithoutName: buttons.filter(
        (b) =>
          (b.innerText || "").trim() === "" &&
          !b.getAttribute("aria-label") &&
          !b.getAttribute("aria-labelledby") &&
          !b.getAttribute("title")
      ).length,
      ariaDescribedby: count("[aria-describedby]"),
      alertsWithText: Array.from(document.querySelectorAll("[role='alert']")).filter(
        (el) => (el.textContent || "").trim() !== ""
      ).length,
      liveRegions: count("[aria-live], [role='status'], [role='alert'], [role='log']"),
      surveyErrorBoxesWithText: Array.from(document.querySelectorAll(".sd-question__erbox")).filter(
        (el) => (el.textContent || "").trim() !== ""
      ).length,
      ariaInvalid: count('[aria-invalid="true"]')
    };
  });
}

async function scanState(page: Page, variant: string, pageId: string, state: string) {
  await page.waitForFunction(() => document.title.trim().length > 0, undefined, { timeout: 10_000 }).catch(() => {});
  const dir = path.join(OUT_ROOT, RUN_ID, variant, pageId);
  fs.mkdirSync(dir, { recursive: true });
  const footprint = await probeMutationFootprint(page);
  for (const config of CONFIGS) {
    const result = await withFrozenAnimations(page, () => analyze(page, config));
    fs.writeFileSync(
      path.join(dir, `${state}.${config}.json`),
      JSON.stringify(
        {
          variant,
          pageId,
          state,
          colorScheme: COLOR_SCHEME,
          url: page.url(),
          scannedAt: new Date().toISOString(),
          footprint,
          ...result
        },
        null,
        2
      )
    );
  }
}

function recordError(variant: string, pageId: string, error: unknown) {
  const dir = path.join(OUT_ROOT, RUN_ID, variant, pageId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "error.txt"),
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  );
}

/** Clear the student's saved answers so each variant starts from the unanswered form. */
async function resetSurvey() {
  const { error } = await supabase
    .from("survey_responses")
    .delete()
    .eq("survey_id", surveyId)
    .eq("profile_id", student.private_profile_id);
  expect(error).toBeNull();
}

test.describe.configure({ mode: "default" });

test.beforeAll(async () => {
  test.skip(!process.env.A11Y_AXE_BASELINE, "axe baseline is opt-in (set A11Y_AXE_BASELINE=1)");

  course = await createClass({ name: "E2E A11y Axe Baseline Class" });
  [student, instructor] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Evidence Student", useMagicLink: true },
    { role: "instructor", class_id: course.id, name: "Evidence Instructor", useMagicLink: true }
  ]);

  const { data: survey, error: surveyErr } = await supabase
    .from("surveys")
    .insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      assigned_to_all: true,
      allow_response_editing: true,
      json: SURVEY_JSON,
      version: 1,
      status: "published",
      title: "Evidence Survey",
      description: "Multi-question survey for a11y evidence collection"
    })
    .select("id, survey_id")
    .single();
  expect(surveyErr).toBeNull();
  surveyId = survey!.id;
  urls.survey = `/course/${course.id}/surveys/${survey!.id}`;

  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Evidence Assignment",
    assignment_slug: `e2e-a11y-axe-${course.id}`
  });
  const sub = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id,
    files: A11Y_CODE_FILES
  });
  urls.results = `/course/${course.id}/assignments/${assignment.id}/submissions/${sub.submission_id}/results`;
  urls.grade = urls.results.replace(/results$/, "grade");
  urls.submissionFiles = urls.results.replace(/results$/, "files");
  urls.assignmentsList = `/course/${course.id}/assignments`;

  await createRegradeRequest(
    sub.submission_id,
    assignment.id,
    student.private_profile_id,
    instructor.private_profile_id,
    assignment.rubricChecks[0]!.id,
    course.id,
    "opened"
  );
  urls.regradeRequests = `/course/${course.id}/regrade-requests`;

  await insertHelpRequest({
    class_id: course.id,
    student_profile_id: student.private_profile_id,
    request: "Seeded question: my tests pass locally but fail on the autograder.",
    active_staff_profile_id: instructor.private_profile_id
  });
  urls.officeHours = `/course/${course.id}/office-hours`;

  const { data: topicRow } = await supabase
    .from("discussion_topics")
    .select("id")
    .eq("class_id", course.id)
    .order("ordinal", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: thread, error: threadErr } = await supabase
    .from("discussion_threads")
    .insert({
      subject: "Evidence thread subject",
      body: "A body long enough to render the two-pane discussion shell for evidence collection.",
      topic_id: topicRow!.id,
      is_question: false,
      instructors_only: false,
      author: student.private_profile_id,
      class_id: course.id,
      draft: false,
      root_class_id: course.id
    })
    .select("id")
    .single();
  expect(threadErr).toBeNull();
  urls.discussionThread = `/course/${course.id}/discussion/${thread!.id}`;
  urls.discussionList = `/course/${course.id}/discussion`;
  urls.gradebook = `/course/${course.id}/gradebook`;
});

for (const variant of VARIANTS) {
  const mutation: Mutation | null = MUTATIONS.find((m) => m.id === variant) ?? null;
  const afterReady = variant === TABINDEX_AFTER_READY;
  for (const spec of SELECTED_PAGES) {
    if (mutation?.pageIds && !mutation.pageIds.includes(spec.id)) continue;

    test(`axe-baseline: ${variant} / ${spec.id}`, async ({ page }) => {
      test.setTimeout(240_000);
      const tolerant = Boolean(mutation);
      const open = async () => {
        await spec.open(page, tolerant);
        if (afterReady) await shuffleTabindexAfterReady(page);
      };
      try {
        if (spec.id === "survey-taking") await resetSurvey();
        if (mutation) await mutation.apply(page);
        await loginAsUser(page, student, course);
        await open();
        await scanState(page, variant, spec.id, "load");

        if (spec.id === "survey-taking") {
          // 3.3.1: Complete with the required q1 empty, so validation errors render.
          const complete = page.locator("input.sd-navigation__complete-btn").first();
          if ((await complete.count()) > 0) {
            await complete.click({ force: true }).catch(() => {});
            await page.waitForTimeout(1200);
            await scanState(page, variant, spec.id, "invalid-submit");
          }

          // 4.1.3: the evidence driver's autosave interaction (type, blur, pick a radio).
          await open();
          const q1 = tolerant
            ? page.locator('.sd-question input[type="text"]').first()
            : page.getByRole("textbox", { name: /what is your name/i });
          await q1.focus();
          await page.keyboard.type("Alice");
          await page.keyboard.press("Tab");
          await page.waitForTimeout(1800);
          await page.keyboard.press("Space");
          await page.waitForTimeout(1800);
          await scanState(page, variant, spec.id, "after-autosave");
          await resetSurvey();
        }
      } catch (error) {
        // Record and move on: one broken page must not hide the other scans.
        recordError(variant, spec.id, error);
      }
    });
  }
}
