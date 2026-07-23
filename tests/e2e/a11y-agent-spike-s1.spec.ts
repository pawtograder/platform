/**
 * Spike S1 / Wave-1 gate driver (a11y-judge v2 — pre-agent scripted flows).
 *
 * Drives the seeded survey end-to-end through the REAL AtHarness API (SR
 * commands only; no locators, no mouse) and records spoken logs + timings.
 *
 * Gates it serves:
 *  - S1: survey completed + submitted (survey_responses.is_submitted), command
 *    latency < 1s incl. the Monaco-heavy results page.
 *  - S3: A11Y_SPIKE_VARIANT=a|b reseeds with different names; normalized logs
 *    must be identical (tools/a11y-judge/agent/spikes/s3-diff-logs.ts).
 *  - Wave 1: two back-to-back runs (A11Y_SPIKE_RUN=r1|r2) through AtHarness
 *    produce normalized-identical logs.
 *
 * Opt-in: A11Y_SPIKE_S1=1 npx playwright test tests/e2e/a11y-agent-spike-s1.spec.ts --project=chromium
 */
import fs from "fs";
import path from "path";
import { addDays } from "date-fns";
import type { Page } from "@playwright/test";
import { test, expect } from "../global-setup";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { AtHarness, type AtObservation } from "../../tools/a11y-judge/agent/atHarness";
import { settlePage, waitForPageReady } from "../../tools/a11y-judge/agent/pageReady";

test.describe.configure({ mode: "serial" });
// Injected bundle must not be blocked by the app CSP; test-only context.
test.use({ bypassCSP: true });

const OUT_DIR = path.resolve(process.cwd(), "a11y-trajectories", "spike-s1");
const VARIANT = process.env.A11Y_SPIKE_VARIANT ?? "a";
const RUN_SUFFIX = process.env.A11Y_SPIKE_RUN ? `.${process.env.A11Y_SPIKE_RUN}` : "";

const SEEDS: Record<string, Record<string, string>> = {
  a: {
    className: "Algorithms Fundamentals",
    studentName: "Spike Student Alpha",
    instructorName: "Spike Instructor Alpha",
    surveyTitle: "Course Pulse Survey"
  },
  b: {
    className: "Systems Programming Studio",
    studentName: "Spike Student Betty",
    instructorName: "Spike Instructor Bruno",
    surveyTitle: "Midterm Feedback Questionnaire"
  }
};
const SEED = SEEDS[VARIANT];

/** Advance the virtual cursor until a new phrase matches, bounded. */
async function nextUntil(harness: AtHarness, re: RegExp, max = 120): Promise<AtObservation> {
  let obs: AtObservation = { spokenSinceLastAction: [], currentItem: "", domFocus: null };
  for (let i = 0; i < max; i++) {
    obs = await harness.run("next");
    if (re.test(obs.spokenSinceLastAction.join(" "))) return obs;
  }
  throw new Error(`nextUntil: no phrase matching ${re} within ${max} steps (last: "${obs.currentItem}")`);
}

function stepDurations(harness: AtHarness): number[] {
  return harness.steps.map((s) => new Date(s.endedTimestamp).getTime() - new Date(s.startedTimestamp).getTime());
}

// ---------------------------------------------------------------------------
// Seeding (mirrors a11y-evidence.spec.ts beforeAll, survey + assignment only)
// ---------------------------------------------------------------------------
let course: Awaited<ReturnType<typeof createClass>>;
let student: TestingUser;
let instructor: TestingUser;
let surveyId: string;
let surveyUrl: string;
let resultsUrl: string;

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

test.beforeAll(async () => {
  test.skip(!process.env.A11Y_SPIKE_S1, "spike S1 is opt-in (set A11Y_SPIKE_S1=1)");

  course = await createClass({ name: SEED.className });
  [student, instructor] = await createUsersInClass([
    { role: "student", class_id: course.id, name: SEED.studentName, useMagicLink: true },
    { role: "instructor", class_id: course.id, name: SEED.instructorName, useMagicLink: true }
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
      title: SEED.surveyTitle,
      description: "Survey for the S1 VSR spike"
    })
    .select("id")
    .single();
  expect(surveyErr).toBeNull();
  surveyId = survey!.id;
  surveyUrl = `/course/${course.id}/surveys/${surveyId}`;

  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Spike Assignment",
    assignment_slug: `e2e-a11y-spike-s1-${course.id}`
  });
  const sub = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  resultsUrl = `/course/${course.id}/assignments/${assignment.id}/submissions/${sub.submission_id}/results`;
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test("S1: complete + submit the survey using only AtHarness SR commands", async ({ page }) => {
  test.setTimeout(300_000);
  const harness = await AtHarness.install(page);

  await loginAsUser(page, student, course);
  await page.goto(surveyUrl);
  await waitForPageReady(page, page.getByRole("heading", { name: /what is your name/i }));
  await settlePage(page);

  // q1: required text question.
  await nextUntil(harness, /what is your name/i);
  let obs = await harness.run("next");
  if (!/textbox/i.test(obs.spokenSinceLastAction.join(" "))) obs = await nextUntil(harness, /textbox/i, 5);
  await harness.run("interact");
  await harness.run("type", "Ada Lovelace");
  await harness.run("stopInteracting");

  // q2: radio "Just right".
  await nextUntil(harness, /just right/i);
  await harness.run("act");

  // q3: checkbox "Graphs".
  await nextUntil(harness, /graphs/i);
  await harness.run("act");

  // q4: comment box.
  await nextUntil(harness, /any other feedback/i);
  obs = await harness.run("next");
  if (!/textbox/i.test(obs.spokenSinceLastAction.join(" "))) obs = await nextUntil(harness, /textbox/i, 5);
  await harness.run("interact");
  await harness.run("type", "No further feedback.");
  await harness.run("stopInteracting");

  // APP DEFECT (found by this flow, 2026-07-14): the survey page autosaves on
  // every value change with NO debounce; the blur-triggered autosave upsert
  // (is_submitted:false) races the Complete upsert (is_submitted:true) and can
  // land last, silently reverting a submitted survey to un-submitted
  // (observed: submitted_at set, is_submitted=false, writes <1ms apart).
  // Workaround here: let the trailing autosave land before submitting.
  // Real fix belongs in app/course/[course_id]/surveys/[survey_id]/page.tsx
  // (separate PR, same policy as other app defects the tool finds).
  await page.waitForTimeout(1500);

  // Complete.
  await nextUntil(harness, /complete/i);
  await harness.run("act");
  await page.waitForTimeout(2500); // submission round-trip

  // Artifacts: raw spoken log (S3/Wave-1 diffs), full step records, bindings.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rawLog = harness.steps.flatMap((s) => s.rawSpoken);
  fs.writeFileSync(path.join(OUT_DIR, `survey-spoken-log.${VARIANT}${RUN_SUFFIX}.json`), JSON.stringify(rawLog, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, `survey-steps.${VARIANT}${RUN_SUFFIX}.json`),
    JSON.stringify(harness.steps, null, 2)
  );
  fs.writeFileSync(
    path.join(OUT_DIR, `bindings.${VARIANT}${RUN_SUFFIX}.json`),
    JSON.stringify({ ...SEED, courseId: String(course.id), surveyId: String(surveyId) }, null, 2)
  );

  // GATE: DB says submitted — independent of anything the SR heard.
  const { data: response } = await supabase
    .from("survey_responses")
    .select("is_submitted, response")
    .eq("survey_id", surveyId)
    .eq("profile_id", student.private_profile_id)
    .single();
  expect(response?.is_submitted).toBe(true);

  // GATE: per-command latency.
  const durations = stepDurations(harness);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  console.log(`[S1] survey commands=${durations.length} avg=${avg.toFixed(0)}ms worst=${Math.max(...durations)}ms`);
  expect(avg).toBeLessThan(1000);
});

test("S1: AtHarness latency on the Monaco-heavy results page", async ({ page }) => {
  test.setTimeout(300_000);
  const harness = await AtHarness.install(page);

  await loginAsUser(page, student, course);
  await page.goto(resultsUrl);
  await waitForPageReady(page, page.getByText(/test results/i).first());
  await settlePage(page);

  const first = await harness.run("observe"); // triggers the lazy start()
  console.log(`[S1] results start item: "${first.currentItem}"`);
  await harness.run("moveToNextHeading");
  await harness.run("moveToNextLandmark");
  await harness.run("readNext", "10");

  const durations = stepDurations(harness);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  console.log(`[S1] results commands=${durations.length} avg=${avg.toFixed(0)}ms worst=${Math.max(...durations)}ms`);
  const structural = harness.steps.filter((s) => s.command.startsWith("moveTo"));
  for (const s of structural) console.log(`[S1] ${s.command}: "${s.observation.spokenSinceLastAction.join(" | ")}"`);
  expect(avg).toBeLessThan(1000);
});
