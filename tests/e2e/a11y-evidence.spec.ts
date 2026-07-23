/**
 * Phase A evidence-collection driver (repo-coupled) for the a11y-judge kit.
 *
 * Opt-in only: `test.skip(!process.env.A11Y_EVIDENCE)` keeps this out of the
 * default E2E lane. It seeds nine student pages, installs the live-region
 * recorder BEFORE navigation, drives the collectors in tools/a11y-judge/collect,
 * and writes one evidence bundle per (page, criterion) under
 *   a11y-evidence/<runId>/<pageId>/<criterion>/{manifest.json, att-*}
 * then refreshes the a11y-evidence/latest symlink.
 *
 * Criterion -> collector mapping (per plan table):
 *   1.3.2, 2.4.6  reading order (DOM text walk + ariaSnapshot) + full-page shot
 *   2.4.3         tab order JSON + numbered-badge full-page shot
 *   2.4.7         per-stop live focus indicators (focused crop + pristine-rect ref)
 *   4.1.2         name/role/value dump + suspect crops
 *   1.1.1         img/svg accname + surrounding text + image crops
 *   4.1.3         live-region mutation log across an interaction (survey autosave)
 *   3.3.1         survey-taking only: invalid-submit error state
 *
 * Set A11Y_STABILITY=1 to additionally re-collect the survey bundles a second
 * time (same seed / same live page) and diff the probe-JSON hashes — the
 * deferred Wave-1A hash-stability gate.
 */
import fs from "fs";
import path from "path";
import { addDays } from "date-fns";
import type { Locator, Page } from "@playwright/test";
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
import { EvidenceBundleWriter } from "../../tools/a11y-judge/collect/bundle";
import {
  canonicalizeForHash,
  type CollectorInfo,
  type EvidenceBundle,
  type FocusIndicatorStop,
  type PageMeta
} from "../../tools/a11y-judge/schema/evidence";
import { collectReadingOrder } from "../../tools/a11y-judge/collect/readingOrder";
import { collectTabOrder } from "../../tools/a11y-judge/collect/tabOrder";
import { collectFocusIndicators } from "../../tools/a11y-judge/collect/focusIndicator";
import { collectNameRoleValue, collectImages } from "../../tools/a11y-judge/collect/nameRoleValue";
import { installLiveRegionRecorder, collectLiveRegionLog } from "../../tools/a11y-judge/collect/liveRegions";
import { ErrorFlowRecorder } from "../../tools/a11y-judge/collect/errorFlows";
import { withFocusBadges } from "../../tools/a11y-judge/collect/annotate";
import { getMutation, writeGroundTruthSidecar, MUTATION_ENV_VAR, MUTATIONS } from "../../tools/a11y-judge/mutations";
import type { Mutation } from "../../tools/a11y-judge/mutations";
import {
  SETTLE_MS,
  settlePage,
  waitForPageReady as waitForPageReadyShared
} from "../../tools/a11y-judge/agent/pageReady";
import { createHash } from "crypto";
import { A11Y_CODE_FILES, A11Y_CODE_FILE_NAME } from "./a11yAgentSeeding";

const EVIDENCE_ROOT = path.resolve(process.cwd(), "a11y-evidence");
const RUN_ID = process.env.A11Y_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const TAB_MAX_STOPS = 60;
const FOCUS_MAX_STOPS = 25;
const REF_CROP_PAD = 24;

test.describe.configure({ mode: "serial" });

// Seeded-defect gauntlet support: A11Y_MUTATION=<id> plants exactly one known
// WCAG failure (skipped on pages outside the mutation's pageIds). Resolved once
// so a typo aborts the whole run instead of mislabeling it clean.
const ACTIVE_MUTATION: Mutation | null = (() => {
  const id = process.env[MUTATION_ENV_VAR]?.trim();
  if (!id) return null;
  const mutation = getMutation(id);
  if (!mutation) {
    throw new Error(`Unknown ${MUTATION_ENV_VAR}="${id}". Known ids: ${MUTATIONS.map((m) => m.id).join(", ")}`);
  }
  return mutation;
})();

/**
 * Apply the active mutation (if any, and if applicable to this page) BEFORE
 * navigation, and write the groundTruth.json sidecar into the page's evidence
 * dir so the gauntlet can score judge verdicts against the planted label.
 */
async function applyMutationForPage(page: Page, pageId: string): Promise<void> {
  const applies = Boolean(ACTIVE_MUTATION && (!ACTIVE_MUTATION.pageIds || ACTIVE_MUTATION.pageIds.includes(pageId)));
  if (ACTIVE_MUTATION && applies) {
    await ACTIVE_MUTATION.apply(page);
  }
  writeGroundTruthSidecar(pageDir(pageId), applies ? ACTIVE_MUTATION : null);
}

function pageDir(pageId: string): string {
  return path.join(EVIDENCE_ROOT, RUN_ID, pageId);
}

/** Shared mutation-tolerant page-ready wait (extracted to agent/pageReady.ts). */
async function waitForPageReady(page: Page, strict: Locator, structuralFallback?: Locator): Promise<void> {
  await waitForPageReadyShared(page, strict, { structuralFallback, mutationTolerant: Boolean(ACTIVE_MUTATION) });
}

function makeWriter(pageId: string, criterion: string, pageMeta: PageMeta, page: Page): EvidenceBundleWriter {
  return new EvidenceBundleWriter(path.join(pageDir(pageId), criterion), pageMeta, { page });
}

function collector(name: string): CollectorInfo {
  return { name, version: "1" };
}

async function buildPageMeta(page: Page, id: string, route: string, browser: string): Promise<PageMeta> {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const title = await page.title().catch(() => "");
  return { id, route, title, viewport: { width: vp.width, height: vp.height }, browser };
}

/** Crop a rect (CSS px, padded) out of a full-page PNG using the browser codec. */
async function cropFromPristine(
  page: Page,
  pristine: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  dpr: number
): Promise<Buffer | null> {
  const out = await page.evaluate(
    async ({ data, r, ratio, pad }) => {
      const resp = await fetch(`data:image/png;base64,${data}`);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const sx = Math.max(0, Math.round((r.x - pad) * ratio));
      const sy = Math.max(0, Math.round((r.y - pad) * ratio));
      const sw = Math.min(bmp.width - sx, Math.round((r.w + pad * 2) * ratio));
      const sh = Math.min(bmp.height - sy, Math.round((r.h + pad * 2) * ratio));
      if (sw <= 0 || sh <= 0) {
        bmp.close();
        return null;
      }
      const canvas = new OffscreenCanvas(sw, sh);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bmp.close();
        return null;
      }
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
      bmp.close();
      const outBlob = await canvas.convertToBlob({ type: "image/png" });
      const ab = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    },
    { data: pristine.toString("base64"), r: rect, ratio: dpr, pad: REF_CROP_PAD }
  );
  return out ? Buffer.from(out, "base64") : null;
}

/**
 * Settle the page for deterministic capture: fixed animation/settle wait, then
 * poll until every aria-live / role=status region's text stops changing. The
 * global "Realtime connection status" region transitions ("connecting" ->
 * "All realtime connections active") during load; captured mid-transition it
 * destabilizes the reading-order text walk and ariaSnapshot between runs. We
 * wait for two consecutive identical samples (bounded), so both runs capture
 * the same steady state.
 */
// settlePage extracted to tools/a11y-judge/agent/pageReady.ts (shared with the
// agentic AT harness) — behavior unchanged.

interface CollectOptions {
  /** Optional interaction run before the live-region log is read (survey autosave). */
  liveRegionInteraction?: () => Promise<void>;
}

/**
 * Collect the seven standard bundles (1.3.2, 2.4.6, 2.4.3, 2.4.7, 4.1.2, 1.1.1,
 * 4.1.3) for the already-navigated, settled `page`. Returns every finalized
 * bundle. 3.3.1 is handled separately (survey-only, re-navigates).
 */
async function collectStandardBundles(
  page: Page,
  pageMeta: PageMeta,
  options: CollectOptions = {}
): Promise<EvidenceBundle[]> {
  const bundles: EvidenceBundle[] = [];
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

  // --- 1.3.2 + 2.4.6: reading order (pristine) --------------------------------
  const reading = await collectReadingOrder(page);
  const fullPage = await page.screenshot({ fullPage: true });
  for (const criterion of ["1.3.2", "2.4.6"]) {
    const w = makeWriter(pageMeta.id, criterion, pageMeta, page);
    const shot = await w.addAttachment({
      buffer: fullPage,
      mime: "image/png",
      role: "full-page",
      probeId: null,
      suggestedName: "full-page.png"
    });
    w.addProbe({
      type: "raw-json",
      id: "reading-order-dom",
      label: "DOM-order visible text walk",
      data: reading.textWalk
    });
    w.addProbe({
      type: "raw-json",
      id: "reading-order-aria",
      label: "body ariaSnapshot (reading-order proxy)",
      data: { ariaSnapshot: reading.ariaSnapshot, fullPageAttachmentId: shot.id }
    });
    bundles.push(await w.finalize(criterion, collector("readingOrder")));
  }

  // --- 1.1.1: images ----------------------------------------------------------
  {
    const imagesData = await collectImages(page);
    const w = makeWriter(pageMeta.id, "1.1.1", pageMeta, page);
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const withCrops = [] as Array<Record<string, unknown>>;
    for (const img of imagesData.images) {
      let cropId: string | null = null;
      if (img.visible && img.rect.w > 1 && img.rect.h > 1 && img.rect.y < vp.height && img.rect.x < vp.width) {
        const clip = {
          x: Math.max(0, img.rect.x),
          y: Math.max(0, img.rect.y),
          width: Math.min(img.rect.w, vp.width - Math.max(0, img.rect.x)),
          height: Math.min(img.rect.h, vp.height - Math.max(0, img.rect.y))
        };
        if (clip.width > 1 && clip.height > 1) {
          const buf = await page.screenshot({ clip }).catch(() => null);
          if (buf) {
            const att = await w.addAttachment({
              buffer: buf,
              mime: "image/png",
              role: "image-crop",
              probeId: "images",
              suggestedName: `img-${img.index}.png`
            });
            cropId = att.id;
          }
        }
      }
      withCrops.push({ ...img, cropAttachmentId: cropId });
    }
    w.addProbe({
      type: "raw-json",
      id: "images",
      label: "img/svg accessible names + context",
      data: { images: withCrops }
    });
    bundles.push(await w.finalize("1.1.1", collector("collectImages")));
  }

  // --- 4.1.2: name/role/value -------------------------------------------------
  {
    const nrv = await collectNameRoleValue(page);
    const w = makeWriter(pageMeta.id, "4.1.2", pageMeta, page);
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const suspectCropIds: Array<{ index: number; cropAttachmentId: string }> = [];
    for (const s of nrv.suspectCrops) {
      if (s.rect.y >= vp.height || s.rect.x >= vp.width) continue;
      const clip = {
        x: Math.max(0, s.rect.x - 8),
        y: Math.max(0, s.rect.y - 8),
        width: Math.min(s.rect.w + 16, vp.width - Math.max(0, s.rect.x - 8)),
        height: Math.min(s.rect.h + 16, vp.height - Math.max(0, s.rect.y - 8))
      };
      if (clip.width <= 1 || clip.height <= 1) continue;
      const buf = await page.screenshot({ clip }).catch(() => null);
      if (buf) {
        const att = await w.addAttachment({
          buffer: buf,
          mime: "image/png",
          role: "suspect-control-crop",
          probeId: "name-role-value",
          suggestedName: `suspect-${s.index}.png`
        });
        suspectCropIds.push({ index: s.index, cropAttachmentId: att.id });
      }
    }
    w.addProbe({
      type: "raw-json",
      id: "name-role-value",
      label: "interactive element name/role/value dump",
      data: { controls: nrv.controls, suspectCrops: suspectCropIds }
    });
    bundles.push(await w.finalize("4.1.2", collector("nameRoleValue")));
  }

  // --- 2.4.7: focus indicators (pristine full page + per-stop crops) ----------
  {
    const focus = await collectFocusIndicators(page, { maxStops: FOCUS_MAX_STOPS, settleMs: 250 });
    const w = makeWriter(pageMeta.id, "2.4.7", pageMeta, page);
    const stops: FocusIndicatorStop[] = [];
    for (const s of focus.stops) {
      let focusedId: string | null = null;
      let referenceId: string | null = null;
      if (s.focusedCrop.length > 0) {
        const att = await w.addAttachment({
          buffer: s.focusedCrop,
          mime: "image/png",
          role: "focused-crop",
          probeId: "focus-indicator",
          suggestedName: `focused-${s.n}.png`
        });
        focusedId = att.id;
      }
      const refBuf = await cropFromPristine(page, focus.pristineFullPage, s.rect, dpr).catch(() => null);
      if (refBuf && refBuf.length > 0) {
        const att = await w.addAttachment({
          buffer: refBuf,
          mime: "image/png",
          role: "reference-crop",
          probeId: "focus-indicator",
          suggestedName: `reference-${s.n}.png`
        });
        referenceId = att.id;
      }
      stops.push({
        n: s.n,
        tag: s.tag,
        role: s.role,
        name: s.name,
        testId: s.testId,
        outline: s.outline,
        boxShadow: s.boxShadow,
        borderColor: s.borderColor,
        focusVisibleAttr: s.focusVisibleAttr,
        rect: s.rect,
        focusedAttachmentId: focusedId,
        referenceAttachmentId: referenceId
      });
    }
    w.addProbe({ type: "focus-indicator", id: "focus-indicator", stops });
    bundles.push(await w.finalize("2.4.7", collector("focusIndicator")));
  }

  // --- 2.4.3: tab order + numbered-badge full-page shot -----------------------
  {
    const tab = await collectTabOrder(page, { maxStops: TAB_MAX_STOPS });
    const w = makeWriter(pageMeta.id, "2.4.3", pageMeta, page);
    const badgeShot = await withFocusBadges(
      page,
      tab.stops.map((s) => ({ n: s.n, x: s.x, y: s.y })),
      () => page.screenshot({ fullPage: true })
    );
    const shot = await w.addAttachment({
      buffer: badgeShot,
      mime: "image/png",
      role: "tab-order-badges",
      probeId: "tab-order",
      suggestedName: "tab-badges.png"
    });
    w.addProbe({
      type: "tab-order",
      id: "tab-order",
      maxStops: TAB_MAX_STOPS,
      wrappedAround: tab.wrappedAround,
      truncated: tab.truncated,
      stops: tab.stops
    });
    w.addProbe({
      type: "raw-json",
      id: "tab-order-screenshot",
      label: "badge screenshot reference",
      data: { attachmentId: shot.id }
    });
    bundles.push(await w.finalize("2.4.3", collector("tabOrder")));
  }

  // --- 4.1.3: live-region log across an interaction ---------------------------
  {
    const w = makeWriter(pageMeta.id, "4.1.3", pageMeta, page);
    // Before/after screenshots let the judge compare VISIBLE status changes
    // against what the live-region timeline says was ANNOUNCED — without them a
    // silenced-toast defect (visible status, no announcement) is undecidable.
    const beforeShot = await page.screenshot({ fullPage: false });
    const beforeAtt = await w.addAttachment({
      buffer: beforeShot,
      mime: "image/png",
      role: "before-interaction",
      probeId: "live-regions",
      suggestedName: "before-interaction.png"
    });
    if (options.liveRegionInteraction) {
      await options.liveRegionInteraction();
    }
    await page.waitForTimeout(SETTLE_MS);
    const afterShot = await page.screenshot({ fullPage: false });
    const afterAtt = await w.addAttachment({
      buffer: afterShot,
      mime: "image/png",
      role: "after-interaction",
      probeId: "live-regions",
      suggestedName: "after-interaction.png"
    });
    const { events, visibleStatusEvents } = await collectLiveRegionLog(page);
    w.addProbe({
      type: "raw-json",
      id: "live-regions",
      label: "aria-live/status/alert mutation timeline + aria-independent visible-status text log",
      data: {
        interactionRan: Boolean(options.liveRegionInteraction),
        events,
        // Recorded WITHOUT any aria dependence (toast-like containers by
        // structure): visible status text that appeared, and whether the
        // container carried live-region markup at that moment. Transient
        // toasts vanish before the after-interaction screenshot; this is the
        // durable record that a visible status existed.
        visibleStatusEvents,
        beforeAttachmentId: beforeAtt.id,
        afterAttachmentId: afterAtt.id
      }
    });
    bundles.push(await w.finalize("4.1.3", collector("liveRegions")));
  }

  return bundles;
}

function refreshLatestSymlink(): void {
  const latest = path.join(EVIDENCE_ROOT, "latest");
  try {
    if (fs.existsSync(latest) || fs.lstatSync(latest, { throwIfNoEntry: false })) {
      fs.rmSync(latest, { force: true });
    }
  } catch {
    /* ignore */
  }
  try {
    fs.symlinkSync(RUN_ID, latest);
  } catch {
    /* symlink may fail on some FS — non-fatal */
  }
}

let course: Awaited<ReturnType<typeof createClass>>;
let student: TestingUser;
let instructor: TestingUser;
let surveyUrl: string;
let resultsUrl: string;
let gradeUrl: string;
let discussionThreadUrl: string;
let discussionListUrl: string;
let gradebookUrl: string;
let assignmentsListUrl: string;
let submissionFilesUrl: string;
let regradeRequestsUrl: string;
let officeHoursUrl: string;

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
  test.skip(!process.env.A11Y_EVIDENCE, "evidence collection is opt-in (set A11Y_EVIDENCE=1)");

  course = await createClass({ name: "E2E A11y Evidence Class" });
  [student, instructor] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Evidence Student", useMagicLink: true },
    { role: "instructor", class_id: course.id, name: "Evidence Instructor", useMagicLink: true }
  ]);

  // Survey.
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
  surveyUrl = `/course/${course.id}/surveys/${survey!.id}`;

  // Assignment + submission -> results + grade pages.
  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Evidence Assignment",
    assignment_slug: `e2e-a11y-evidence-${course.id}`
  });
  const sub = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id,
    files: A11Y_CODE_FILES
  });
  resultsUrl = `/course/${course.id}/assignments/${assignment.id}/submissions/${sub.submission_id}/results`;
  gradeUrl = resultsUrl.replace(/results$/, "grade");
  submissionFilesUrl = resultsUrl.replace(/results$/, "files");
  assignmentsListUrl = `/course/${course.id}/assignments`;

  // Regrade request (opened) so the student's regrade dashboard has content.
  await createRegradeRequest(
    sub.submission_id,
    assignment.id,
    student.private_profile_id,
    instructor.private_profile_id,
    assignment.rubricChecks[0]!.id,
    course.id,
    "opened"
  );
  regradeRequestsUrl = `/course/${course.id}/regrade-requests`;

  // Office hours: seed one open help request so the queue page has content.
  await insertHelpRequest({
    class_id: course.id,
    student_profile_id: student.private_profile_id,
    request: "Seeded question: my tests pass locally but fail on the autograder."
  });
  officeHoursUrl = `/course/${course.id}/office-hours`;

  // Discussion thread.
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
  discussionThreadUrl = `/course/${course.id}/discussion/${thread!.id}`;
  discussionListUrl = `/course/${course.id}/discussion`;
  gradebookUrl = `/course/${course.id}/gradebook`;
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.afterAll(async () => {
  if (!process.env.A11Y_EVIDENCE) return;
  refreshLatestSymlink();
});

test("evidence: survey-taking page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "survey-taking");
  await loginAsUser(page, student, course);
  await page.goto(surveyUrl);
  await waitForPageReady(
    page,
    page.getByRole("heading", { name: /what is your name/i }),
    page.locator(".sd-question").first()
  );
  await settlePage(page);

  const pageMeta = await buildPageMeta(page, "survey-taking", surveyUrl, browserName);

  // --- 3.3.1: invalid-submit error identification (survey only) --------------
  // MUST run first, on the pristine (unanswered) survey — the q1 required field
  // is empty so clicking Complete triggers SurveyJS validation. If we ran this
  // after the autosave interaction below, the saved answer would satisfy the
  // requirement and the survey would submit instead of erroring.
  const recorder = new ErrorFlowRecorder(page);
  const completeBtn = page.locator("input.sd-navigation__complete-btn");
  const hasComplete = await completeBtn.count().then((c) => c > 0);
  let flowAvailable = false;
  let submitted = false;
  let snapshot: Awaited<ReturnType<ErrorFlowRecorder["snapshotErrorState"]>> | null = null;
  if (hasComplete) {
    await recorder.step("click Complete with required q1 empty", async () => {
      await completeBtn
        .first()
        .click({ force: true })
        .catch(() => {});
      await page.waitForTimeout(1200);
    });
    snapshot = await recorder.snapshotErrorState();
    submitted = await page
      .getByText(/submitted successfully/i)
      .count()
      .then((c) => c > 0)
      .catch(() => false);
    const requiredErrorVisible = await page
      .locator(".sd-question__erbox, .sv-string-viewer")
      .filter({ hasText: /response required|please answer|cannot be empty|value required/i })
      .first()
      .isVisible()
      .catch(() => false);
    // A genuine 3.3.1 flow: submission was blocked AND an error was surfaced
    // (aria-invalid field or a visible required-field message).
    flowAvailable = !submitted && (snapshot.invalidFields.length > 0 || requiredErrorVisible);
  }
  const errWriter = makeWriter("survey-taking", "3.3.1", pageMeta, page);
  const errShot = await page.screenshot({ fullPage: true });
  const errAtt = await errWriter.addAttachment({
    buffer: errShot,
    mime: "image/png",
    role: "post-error",
    probeId: "error-flow",
    suggestedName: "survey-error-state.png"
  });
  errWriter.addProbe({
    type: "raw-json",
    id: "error-flow",
    label: "invalid-submit error identification",
    data: {
      flowAvailable,
      submittedInsteadOfErroring: submitted,
      transcript: recorder.transcript,
      snapshot,
      postErrorAttachmentId: errAtt.id
    }
  });
  const errorBundle = await errWriter.finalize("3.3.1", collector("errorFlows"));

  // Reset to a clean survey for the standard collection (the validation error
  // above was never saved, so a fresh navigation restores the unanswered form).
  await page.goto(surveyUrl);
  await waitForPageReady(
    page,
    page.getByRole("heading", { name: /what is your name/i }),
    page.locator(".sd-question").first()
  );
  await settlePage(page);

  const surveyInteraction = async () => {
    // Mirror the audit spec's dynamic keyboard flow (WITHOUT completing) so
    // autosave fires and any status live regions get recorded. Under an active
    // mutation the accessible name may be rewritten — fall back to structure.
    const q1 = ACTIVE_MUTATION
      ? page.locator('.sd-question input[type="text"]').first()
      : page.getByRole("textbox", { name: /what is your name/i });
    await q1.focus();
    await page.keyboard.type("Alice");
    await page.keyboard.press("Tab"); // blur commits q1 -> autosave
    await page.waitForTimeout(1800);
    await page.keyboard.press("Space"); // select a radio -> autosave
    await page.waitForTimeout(1800);
  };

  const bundles = await collectStandardBundles(page, pageMeta, { liveRegionInteraction: surveyInteraction });
  bundles.push(errorBundle);

  expect(bundles.length).toBe(8);

  // --- Deferred hash-stability gate (opt-in) ---------------------------------
  // Two back-to-back collections on IDENTICAL page content (no autosave
  // interaction, read-only collectors) so any probe-JSON diff is genuine
  // collector nondeterminism rather than a content change. Compares the
  // canonicalized manifest with attachments excluded + page id/route
  // normalized (screenshot bytes are never byte-identical run to run, and the
  // two sub-runs live in different output dirs).
  if (process.env.A11Y_STABILITY) {
    await page.goto(surveyUrl);
    await expect(page.getByRole("heading", { name: /what is your name/i })).toBeVisible({ timeout: 30_000 });
    await settlePage(page);
    const metaA = await buildPageMeta(page, "survey-taking__stab_a", surveyUrl, browserName);
    const runA = await collectStandardBundles(page, metaA);
    await settlePage(page);
    const metaB = await buildPageMeta(page, "survey-taking__stab_b", surveyUrl, browserName);
    const runB = await collectStandardBundles(page, metaB);

    const byCriterion = new Map(runA.map((b) => [b.criterion, b]));
    const hashOf = (b: EvidenceBundle) =>
      createHash("sha256")
        .update(canonicalizeForHash({ ...b, page: { ...b.page, id: "X", route: "X" }, attachments: [] }))
        .digest("hex")
        .slice(0, 12);
    const report: string[] = [];
    for (const rb of runB) {
      const fb = byCriterion.get(rb.criterion);
      if (!fb) continue;
      const a = hashOf(fb);
      const c = hashOf(rb);
      const attStable = fb.contentHash === rb.contentHash;
      report.push(
        `  ${rb.criterion.padEnd(6)} probeJSON=${a === c ? "STABLE  " : "UNSTABLE"} (${a} vs ${c})  fullHash=${attStable ? "identical" : "differs"}`
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[A11Y_STABILITY] survey-taking probe-JSON stability, two back-to-back read-only collections (page id/route normalized, attachments excluded):\n${report.join("\n")}\n`
    );
  }
});

test("evidence: autograder-results page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "autograder-results");
  await loginAsUser(page, student, course);
  await page.goto(resultsUrl);
  await waitForPageReady(page, page.getByText(/test results/i).first());
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "autograder-results", resultsUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});

test("evidence: grade-summary page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "grade-summary");
  await loginAsUser(page, student, course);
  await page.goto(gradeUrl);
  await waitForPageReady(page, page.getByText(/autograder/i).first());
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "grade-summary", gradeUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});

test("evidence: gradebook page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "gradebook");
  await loginAsUser(page, student, course);
  await page.goto(gradebookUrl);
  await waitForPageReady(page, page.getByRole("heading", { name: /gradebook/i }).first());
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "gradebook", gradebookUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});

test("evidence: discussion page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "discussion");
  await loginAsUser(page, student, course);
  await page.goto(discussionListUrl);
  await page.waitForTimeout(SETTLE_MS);
  await page.goto(discussionThreadUrl);
  await waitForPageReady(page, page.getByText("Evidence thread subject").first());
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "discussion", discussionThreadUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});

test("evidence: assignments-list page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "assignments-list");
  await loginAsUser(page, student, course);
  await page.goto(assignmentsListUrl);
  await waitForPageReady(page, page.getByText("Evidence Assignment").first());
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "assignments-list", assignmentsListUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});

test("evidence: submission-files page (Monaco code viewer)", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "submission-files");
  await loginAsUser(page, student, course);
  await page.goto(submissionFilesUrl);
  // Ready = the seeded file appears in the tree AND Monaco has mounted.
  await waitForPageReady(page, page.getByText(A11Y_CODE_FILE_NAME).first(), page.locator(".monaco-editor").first());
  await page
    .locator(".monaco-editor")
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
    .catch(() => {});
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "submission-files", submissionFilesUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});

test("evidence: regrade-requests page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "regrade-requests");
  await loginAsUser(page, student, course);
  await page.goto(regradeRequestsUrl);
  await waitForPageReady(page, page.getByText(/regrade/i).first(), page.locator("#main-content, main").first());
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "regrade-requests", regradeRequestsUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});

test("evidence: office-hours page", async ({ page, browserName }) => {
  test.setTimeout(300_000);
  await installLiveRegionRecorder(page);
  await applyMutationForPage(page, "office-hours");
  await loginAsUser(page, student, course);
  await page.goto(officeHoursUrl);
  // The queue page is realtime-heavy; wait on its named region (a bare
  // getByText match can land on a hidden nav/skip-link node) with a
  // structural fallback to the main landmark.
  await waitForPageReady(
    page,
    page.getByRole("region", { name: /office hours/i }).first(),
    page.locator("#main-content, main").first()
  );
  await settlePage(page);
  const pageMeta = await buildPageMeta(page, "office-hours", officeHoursUrl, browserName);
  const bundles = await collectStandardBundles(page, pageMeta);
  expect(bundles.length).toBe(7);
});
