// Exam OCR / vision provider layer (Deno).
//
// Two stages behind one interface:
//   * external OCR  -> raw text + per-word bounding boxes (normalized 0..1)
//   * Google Gemini -> template extraction, identity (name/ID) reading, answer structuring
//
// Selected by EXAM_VISION_PROVIDER:
//   "fake"   (default in tests)  -> deterministic, offline
//   anything else                 -> CompositeProvider(external=GoogleVision, vision=Gemini)
//
// No npm deps — everything is REST (fetch).

import type { NormRect, WordBox } from "./examRegionText.ts";
export type { NormRect, WordBox } from "./examRegionText.ts";
export { wordsInRegion } from "./examRegionText.ts";

export type PageImage = { name: string; bytes: Uint8Array; width: number; height: number };

export type ProposedQuestion = {
  client_id: string;
  parent_client_id?: string | null;
  level: 1 | 2 | 3;
  ordinal: number;
  label?: string;
  prompt?: string;
  answer_type?: string;
  choices?: unknown;
  points?: number;
};
export type ProposedRegion = {
  question_client_id?: string | null;
  kind: "answer" | "student_id" | "name";
  page_number: number;
} & NormRect;
export type ProposedTree = { questions: ProposedQuestion[]; regions: ProposedRegion[] };

export type IdentityResult = { sisId?: string; name?: string };
export type StructuredAnswer = { value: unknown; text: string };

export interface ExamVisionProvider {
  ocrImage(page: PageImage): Promise<{ text: string; words: WordBox[] }>;
  extractTemplate(pages: PageImage[]): Promise<ProposedTree>;
  readIdentity(page: PageImage, region: NormRect | null): Promise<IdentityResult>;
  structureAnswer(
    answerType: string | null,
    page: PageImage,
    region: NormRect,
    ocrText: string
  ): Promise<StructuredAnswer>;
}

/** Thrown when a provider is rate-limited; the worker requeues with this delay. */
export class ProviderRateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds = 60) {
    super(message);
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type TransientFailureCategory = "server_error" | "timeout" | "aborted" | "network";

/**
 * Thrown when a provider request failed in transit or with a 5xx: the request may succeed if
 * retried, so callers must not treat it as an unusable answer. The worker's dispatcher retries it
 * on its normal backoff.
 *
 * The message is deliberately bounded to provider, category and status. It is persisted to the
 * batch error and DLQ and sent to Sentry, so it must not carry response bodies or transport
 * error text, either of which can reflect request material such as the API key.
 */
export class ProviderTransientError extends Error {
  constructor(
    readonly provider: string,
    readonly category: TransientFailureCategory,
    readonly status?: number
  ) {
    super(`${provider} request failed: category=${category}${status === undefined ? "" : ` status=${status}`}`);
    this.name = "ProviderTransientError";
  }
}

/** How long one Gemini request may take before generate gives up on it. */
const GEMINI_TIMEOUT_MS = 60000;
/** Template pages per Auto-extract request; 2 pages took 18-27s against GEMINI_TIMEOUT_MS. */
const TEMPLATE_PAGES_PER_REQUEST = 2;
/** A run of template pages sent in one Auto-extract request, numbered from 1 across the template. */
type PageGroup = { firstPage: number; lastPage: number };

/**
 * Auto-extract failed for some of the template's pages, so nothing is imported. exam-extract-template
 * shows the message to the instructor as is, so it says which pages and what to do. Like
 * ProviderTransientError's, it never carries response or transport text; the failure itself is
 * kept as the cause.
 */
export class TemplateExtractError extends Error {
  constructor(
    readonly pageRanges: [number, number][],
    cause: unknown
  ) {
    const pages = pageRanges.map(([first, last]) => (first === last ? `${first}` : `${first}–${last}`));
    const single = pageRanges.length === 1 && pageRanges[0][0] === pageRanges[0][1];
    super(
      `Auto-extract couldn't read ${single ? "page" : "pages"} ${pages.join(", ")} (${describeFailure(cause)}). ` +
        "Nothing was imported. Try again, or draw the regions by hand.",
      { cause }
    );
    this.name = "TemplateExtractError";
  }
}

/**
 * Gemini answered a group of template pages with something that isn't a question tree. Like
 * ProviderTransientError's, its message never carries the response text.
 */
export class TemplateResponseError extends Error {
  constructor() {
    super("Gemini's answer was not a question tree");
    this.name = "TemplateResponseError";
  }
}

function describeFailure(err: unknown): string {
  if (err instanceof ProviderTransientError && err.category === "timeout") {
    return `Gemini took longer than ${GEMINI_TIMEOUT_MS / 1000} seconds`;
  }
  if (err instanceof ProviderTransientError) return "the request to Gemini failed";
  if (err instanceof ProviderRateLimitError) return "Gemini is rate limiting requests";
  if (err instanceof TemplateResponseError) return "Gemini's answer couldn't be read";
  return "Gemini returned an error";
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Whether `tree` has what mergeTemplateGroups reads: lists of questions and regions made of
 * objects, with an id and a label it can use. Other fields are left to the caller.
 */
function isQuestionTree(tree: unknown): tree is ProposedTree {
  if (!isObject(tree) || !Array.isArray(tree.questions) || !Array.isArray(tree.regions)) return false;
  if (!tree.regions.every(isObject)) return false;
  return tree.questions.every(
    (q) =>
      isObject(q) &&
      (typeof q.client_id === "number" || (typeof q.client_id === "string" && q.client_id !== "")) &&
      (q.label == null || typeof q.label === "string")
  );
}

const byOrdinal = (a: ProposedQuestion, b: ProposedQuestion) => (a.ordinal ?? 0) - (b.ordinal ?? 0);

// "Problem 2 (continued)" and "Problem 2." are the same question as "Problem 2".
const labelKey = (label: string | undefined) =>
  (label ?? "")
    .toLowerCase()
    .replace(/\(\s*cont[^)]*\)/g, "")
    .replace(/[\s.:]+$/, "")
    .trim();
const sameQuestion = (a: ProposedQuestion, b: ProposedQuestion) =>
  labelKey(a.label) !== "" && labelKey(a.label) === labelKey(b.label);

/**
 * Merges the answers for consecutive groups of template pages into one proposal.
 *
 * Gemini numbers pages and picks client_ids within each request, so page numbers are shifted to
 * the whole template (a page number past the group's own pages is dropped rather than shifted onto
 * another group's page) and ids are prefixed with the group. Top-level ordinals continue across
 * groups. A problem that runs over a group boundary comes back from both groups, and the halves
 * are joined (joinContinued). Only the first name and student ID regions are kept: a name line in
 * every page footer would otherwise give one per group, and the worker reads whichever one the
 * database returns first.
 */
function mergeTemplateGroups(groups: (PageGroup & { tree: ProposedTree })[]): ProposedTree {
  const questions: ProposedQuestion[] = [];
  const regions: ProposedRegion[] = [];
  let topCount = 0;
  let lastTop: ProposedQuestion | undefined;
  groups.forEach(({ firstPage, lastPage, tree }, g) => {
    const id = (raw: string) => `g${g + 1}:${raw}`;
    // Not a truthiness check: Gemini can answer with numeric ids, and 0 is a real reference.
    const ref = (raw: string | null | undefined) => (raw == null || raw === "" ? null : id(raw));
    const groupQuestions = (tree.questions ?? []).map((q) => ({
      ...q,
      client_id: id(q.client_id),
      parent_client_id: ref(q.parent_client_id)
    }));
    questions.push(...groupQuestions);
    for (const r of tree.regions ?? []) {
      const inGroup =
        Number.isInteger(r.page_number) && r.page_number >= 1 && r.page_number <= lastPage - firstPage + 1;
      if (!inGroup) continue;
      if (r.kind !== "answer" && regions.some((kept) => kept.kind === r.kind)) continue;
      regions.push({
        ...r,
        page_number: firstPage + r.page_number - 1,
        question_client_id: ref(r.question_client_id)
      });
    }
    const tops = groupQuestions.filter((q) => !q.parent_client_id).sort(byOrdinal);
    for (const [i, top] of tops.entries()) {
      if (i === 0 && lastTop && sameQuestion(lastTop, top)) {
        joinContinued(lastTop, top, questions, regions);
      } else {
        top.ordinal = ++topCount;
        lastTop = top;
      }
    }
  });
  return { questions, regions };
}

/**
 * `continued` is the next group's copy of `kept`, the question the previous group ended on. Its
 * parts move under `kept`, numbered after kept's own, and it is removed. When kept's last part and
 * continued's first part are the same question too (a part split over the boundary), those two
 * are joined the same way.
 */
function joinContinued(
  kept: ProposedQuestion,
  continued: ProposedQuestion,
  questions: ProposedQuestion[],
  regions: ProposedRegion[]
) {
  const partsOf = (q: ProposedQuestion) => questions.filter((x) => x.parent_client_id === q.client_id).sort(byOrdinal);
  const keptParts = partsOf(kept);
  const movedParts = partsOf(continued);
  questions.splice(questions.indexOf(continued), 1);
  for (const r of regions) {
    if (r.question_client_id === continued.client_id) r.question_client_id = kept.client_id;
  }
  kept.points ??= continued.points;
  const lastPart = keptParts.at(-1);
  let ordinal = lastPart?.ordinal ?? 0;
  for (const [i, part] of movedParts.entries()) {
    if (i === 0 && lastPart && sameQuestion(lastPart, part)) {
      joinContinued(lastPart, part, questions, regions);
    } else {
      part.parent_client_id = kept.client_id;
      part.ordinal = ++ordinal;
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Simple per-process token-bucket rate limiter (spaces calls within one run).
// ---------------------------------------------------------------------------
class RateLimiter {
  private nextAt = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
function rpmToInterval(rpm: number): number {
  return rpm > 0 ? Math.ceil(60000 / rpm) : 0;
}

// ---------------------------------------------------------------------------
// Fake provider — deterministic, offline. Used by tests.
// Scan page names are expected to encode the student's SIS id, e.g.
//   "...__sis-12345__page-0.png"  ->  readIdentity returns { sisId: "12345" }
// A page name containing FAKE_TRANSIENT_FAULT_MARKER makes structureAnswer fail the way a 5xx,
// timeout or reset from Gemini does (tests/e2e/exam-finalize-provider-retry.spec.ts).
// ---------------------------------------------------------------------------
const FAKE_TRANSIENT_FAULT_MARKER = "__fault-transient__";

export class FakeExamVisionProvider implements ExamVisionProvider {
  ocrImage(page: PageImage): Promise<{ text: string; words: WordBox[] }> {
    const sis = page.name.match(/sis-([A-Za-z0-9]+)/)?.[1] ?? "unknown";
    const text = `OCR(${page.name}) sis-${sis}`;
    // Tokens tiled across a grid, not just down one column.
    //
    // This read as "spread down the page", but `text` is only ever two tokens, so every page put
    // its words at y 0.10 and 0.15 and nowhere else. wordsInRegion keeps a word when its centre is
    // inside the region, so any answer region below roughly y 0.17 matched nothing and ocr_text
    // came back "" -- including the one in exam-grading.spec.ts, which sits at y 0.3..0.5.
    //
    // The first fix tiled down the page only, and Adhiraj pointed out on review that every box was
    // still x 0.1..0.4, so a region that misses x = 0.25 matched nothing even though the comment
    // claimed "anywhere on the page". Hence a grid. Centres land every 0.2 across and every 0.05
    // down, so any region at least 0.2 wide and 0.05 tall has a word in it, which is the bound a
    // fake OCR backend owes the tests that depend on it.
    const tokens = text.split(/\s+/);
    const COL_CENTRES = [0.1, 0.3, 0.5, 0.7, 0.9];
    const ROW_COUNT = 18; // y centres 0.065 .. 0.915, one row every 0.05
    const BOX_W = 0.18;
    const BOX_H = 0.03;
    const words: WordBox[] = [];
    for (let row = 0; row < ROW_COUNT; row++) {
      for (let col = 0; col < COL_CENTRES.length; col++) {
        words.push({
          text: tokens[(row * COL_CENTRES.length + col) % tokens.length],
          x: COL_CENTRES[col] - BOX_W / 2,
          y: 0.05 + row * 0.05,
          width: BOX_W,
          height: BOX_H
        });
      }
    }
    return Promise.resolve({ text, words });
  }
  extractTemplate(_pages: PageImage[]): Promise<ProposedTree> {
    return Promise.resolve({ questions: [], regions: [] });
  }
  readIdentity(page: PageImage, _region: NormRect | null): Promise<IdentityResult> {
    const sisId = page.name.match(/sis-([A-Za-z0-9]+)/)?.[1];
    const name = page.name.match(/name-([A-Za-z0-9 _-]+?)(?:__|\.|$)/)?.[1]?.replace(/_/g, " ");
    return Promise.resolve({ sisId, name });
  }
  structureAnswer(
    _answerType: string | null,
    page: PageImage,
    _region: NormRect,
    ocrText: string
  ): Promise<StructuredAnswer> {
    if (page.name.includes(FAKE_TRANSIENT_FAULT_MARKER)) {
      return Promise.reject(new ProviderTransientError("fake", "server_error", 503));
    }
    return Promise.resolve({ value: ocrText, text: ocrText });
  }
}

// ---------------------------------------------------------------------------
// Google Cloud Vision OCR (DOCUMENT_TEXT_DETECTION) for ocrImage.
// ---------------------------------------------------------------------------
class GoogleVisionOcr {
  private limiter: RateLimiter;
  constructor(
    private apiKey: string,
    rpm: number
  ) {
    this.limiter = new RateLimiter(rpmToInterval(rpm));
  }
  async ocrImage(page: PageImage): Promise<{ text: string; words: WordBox[] }> {
    await this.limiter.wait();
    const body = {
      requests: [
        {
          image: { content: toBase64(page.bytes) },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }]
        }
      ]
    };
    // The key goes in x-goog-api-key, not ?key=: a URL ends up in fetch error messages, proxy
    // logs and Sentry breadcrumbs, and the CI lane uploads the edge-function log as an artifact.
    const res = await fetch("https://vision.googleapis.com/v1/images:annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      // Bound the call so a stalled connection can't hang the worker indefinitely (it has no
      // other timeout); a timeout surfaces as a transient error and the message requeues.
      signal: AbortSignal.timeout(30000)
    });
    if (res.status === 429) throw new ProviderRateLimitError("Vision OCR rate limited", 60);
    if (!res.ok) throw new Error(`Vision OCR failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    // A per-image error arrives inside an HTTP 200 batch response, with no fullTextAnnotation.
    // Treating that as "an empty page" was silent data loss: processPage would persist non-null
    // ocr_data, the match join would count the page as OCR'd, and the batch could be reviewed
    // and finalized with permanently blank responses -- no retry, no error surfaced anywhere.
    const perImageError = json?.responses?.[0]?.error;
    if (perImageError) {
      const code = perImageError.code;
      const message = perImageError.message ?? JSON.stringify(perImageError);
      // Vision reports quota exhaustion per image as RESOURCE_EXHAUSTED (8); route it to the
      // same backoff path as an HTTP 429 rather than the generic error path.
      if (code === 8 || /quota|rate limit|resource[ _]exhausted/i.test(message)) {
        throw new ProviderRateLimitError(`Vision OCR rate limited: ${message}`, 60);
      }
      throw new Error(`Vision OCR failed for ${page.name}: ${message}`);
    }
    const response = json?.responses?.[0];
    // A body without a per-image response is malformed; fail rather than record the page as read.
    if (!response || typeof response !== "object") {
      throw new Error(`Vision OCR returned no response for ${page.name}; refusing to record it as empty`);
    }
    // A per-image response with no error and no fullTextAnnotation is how Vision reports a page
    // with no text: a blank 850x1100 white PNG returns `{"responses":[{}]}` (checked against the
    // live API 2026-10-24). Treating that as a failure sent every blank page (scratch pages, blank
    // backs) through retries into the DLQ, and the batch could never reach review.
    const annotation = response.fullTextAnnotation;
    if (!annotation) return { text: "", words: [] };
    const text: string = annotation?.text ?? "";
    const words: WordBox[] = [];
    const w = page.width || 1;
    const h = page.height || 1;
    for (const pageAnn of annotation?.pages ?? []) {
      for (const block of pageAnn.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          for (const word of para.words ?? []) {
            const wordText = (word.symbols ?? []).map((s: { text: string }) => s.text).join("");
            const verts = word.boundingBox?.vertices ?? [];
            if (verts.length === 0) continue;
            const xs = verts.map((v: { x?: number }) => v.x ?? 0);
            const ys = verts.map((v: { y?: number }) => v.y ?? 0);
            const minX = Math.min(...xs);
            const minY = Math.min(...ys);
            words.push({
              text: wordText,
              x: minX / w,
              y: minY / h,
              width: (Math.max(...xs) - minX) / w,
              height: (Math.max(...ys) - minY) / h
            });
          }
        }
      }
    }
    return { text, words };
  }
}

// ---------------------------------------------------------------------------
// Gemini (generativelanguage REST) for template extraction / identity / structuring.
// ---------------------------------------------------------------------------
class GeminiVision {
  private limiter: RateLimiter;
  constructor(
    private apiKey: string,
    private model: string,
    rpm: number,
    private baseUrl: string
  ) {
    this.limiter = new RateLimiter(rpmToInterval(rpm));
  }
  private async generate(parts: unknown[]): Promise<string> {
    await this.limiter.wait();
    // Key in a header rather than the query string; see GoogleVisionOcr.ocrImage.
    // Build the request before sending it, so a malformed URL, header or body throws here as the
    // programming error it is, and only a failure of the request itself reaches the catch below.
    const request = new Request(`${this.baseUrl}/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 }
      }),
      // Bound the call so a stalled connection can't hang the worker indefinitely.
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      // fetch would otherwise follow a redirect and resend x-goog-api-key to wherever it points.
      // A redirect rejects as a TypeError, classified below like any other failed request.
      redirect: "error"
    });
    let res: Response;
    let body = "";
    try {
      res = await fetch(request);
      // Read a successful body here too: a connection that resets, or a timeout that fires, after
      // the headers arrive surfaces from the body read rather than from fetch. An error status is
      // classified below by the status alone, so its body is never read and cannot fail first.
      if (res.ok) body = await res.text();
    } catch (err) {
      // The request rejects with a TypeError when the connection fails or is reset, and with a
      // TimeoutError/AbortError when the signal above fires. Those are worth retrying, unlike an
      // unusable answer, so they must not reach structureAnswer's caller as a plain Error. Only
      // the category is kept: transport error text embeds the URL and can echo request material.
      if (err instanceof TypeError) throw new ProviderTransientError("gemini", "network");
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new ProviderTransientError("gemini", "timeout");
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new ProviderTransientError("gemini", "aborted");
      }
      throw err;
    }
    if (!res.ok) {
      // Release the unread body. A failure here (e.g. the body already errored) must not replace
      // the status's classification.
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) throw new ProviderRateLimitError("Gemini rate limited", 60);
      // No body in either error: an error page can reflect request material, and both messages
      // reach the batch error, the DLQ and Sentry (see ProviderTransientError). A 4xx stays a
      // plain Error.
      if (res.status >= 500) throw new ProviderTransientError("gemini", "server_error", res.status);
      throw new Error(`Gemini failed: ${res.status}`);
    }
    // Outside the catch: a body that is not JSON stays a SyntaxError, as before.
    const json = JSON.parse(body);
    return json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  }
  private imagePart(page: PageImage) {
    return { inline_data: { mime_type: "image/png", data: toBase64(page.bytes) } };
  }
  private stripFences(text: string): string {
    return text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }
  private parseJson<T>(text: string, fallback: T): T {
    try {
      return JSON.parse(this.stripFences(text)) as T;
    } catch {
      return fallback;
    }
  }
  // All the pages used to go to Gemini in one request, which generate cuts off at
  // GEMINI_TIMEOUT_MS. How long Gemini takes depends on how much is on the pages: 4 pages took
  // about 49s, and 8 or more pages of different questions never finished (#1369). So the pages go
  // in groups of TEMPLATE_PAGES_PER_REQUEST, all at once (the rate limiter still spaces the
  // requests), and the answers are merged. allSettled rather than all, so no request is left
  // running after this returns and every group that failed can be named.
  async extractTemplate(pages: PageImage[]): Promise<ProposedTree> {
    const groups: (PageGroup & { pages: PageImage[] })[] = [];
    for (let i = 0; i < pages.length; i += TEMPLATE_PAGES_PER_REQUEST) {
      const slice = pages.slice(i, i + TEMPLATE_PAGES_PER_REQUEST);
      groups.push({ firstPage: i + 1, lastPage: i + slice.length, pages: slice });
    }
    const settled = await Promise.allSettled(groups.map((group) => this.extractTemplateGroup(group, pages.length)));
    const answered: (PageGroup & { tree: ProposedTree })[] = [];
    const failed: [number, number][] = [];
    let firstFailure: unknown;
    settled.forEach((result, g) => {
      const { firstPage, lastPage } = groups[g];
      if (result.status === "fulfilled") {
        answered.push({ firstPage, lastPage, tree: result.value });
      } else {
        failed.push([firstPage, lastPage]);
        firstFailure ??= result.reason;
      }
    });
    if (failed.length > 0) throw new TemplateExtractError(failed, firstFailure);
    return mergeTemplateGroups(answered);
  }
  private async extractTemplateGroup(
    { firstPage, lastPage, pages }: PageGroup & { pages: PageImage[] },
    totalPages: number
  ): Promise<ProposedTree> {
    const parts: unknown[] = [
      {
        text:
          `These are ${firstPage === lastPage ? `page ${firstPage}` : `pages ${firstPage}-${lastPage}`} of a ` +
          `${totalPages}-page exam template. Count "page_number" by the image's position in this request, ` +
          "starting at 1, not by any number printed on the page. " +
          "You are given page images of an exam template. Identify the question structure as up to 3 " +
          "nested levels (level 1 = sections/parts, level 2 = questions, level 3 = sub-questions/items) and " +
          "the bounding box (normalized 0..1: x,y,width,height) where each leaf answer is written. Also locate " +
          "the region where the student writes their name and the region for their student ID. Return strict " +
          'JSON: { "questions": [{ "client_id","parent_client_id","level","ordinal","label","prompt",' +
          '"answer_type","points" }], "regions": [{ "question_client_id"|null,"kind"(answer|name|student_id),' +
          '"page_number","x","y","width","height" }] }. "answer_type" must be exactly one of "free_text", ' +
          '"short_answer", "multiple_choice", "numeric" or "true_false"; use "free_text" for a section or ' +
          "question that only groups sub-questions."
      },
      ...pages.map((p) => this.imagePart(p))
    ];
    const text = await this.generate(parts);
    // Not parseJson: an empty fallback would count as an answer and leave these pages out.
    let tree: unknown;
    try {
      tree = JSON.parse(this.stripFences(text));
    } catch {
      throw new TemplateResponseError();
    }
    if (!isQuestionTree(tree)) throw new TemplateResponseError();
    return tree;
  }
  async readIdentity(page: PageImage, region: NormRect | null): Promise<IdentityResult> {
    const hint = region ? `The identity is within the normalized region ${JSON.stringify(region)}. ` : "";
    const text = await this.generate([
      {
        text:
          hint +
          "Read the student name and student ID written on this exam page. Return strict JSON " +
          '{ "name": string|null, "sisId": string|null }.'
      },
      this.imagePart(page)
    ]);
    return this.parseJson<IdentityResult>(text, {});
  }
  async structureAnswer(
    answerType: string | null,
    page: PageImage,
    region: NormRect,
    ocrText: string
  ): Promise<StructuredAnswer> {
    const text = await this.generate([
      {
        text:
          `Answer type: ${answerType ?? "free_text"}. Region (normalized): ${JSON.stringify(region)}. ` +
          `OCR text of the region: ${JSON.stringify(ocrText)}. Return strict JSON ` +
          '{ "value": <the structured answer>, "text": <cleaned free text> }.'
      },
      this.imagePart(page)
    ]);
    return this.parseJson<StructuredAnswer>(text, { value: ocrText, text: ocrText });
  }
}

/** External OCR (Vision) for ocrImage + Gemini for the vision/structuring tasks. */
class CompositeExamVisionProvider implements ExamVisionProvider {
  constructor(
    private ocr: GoogleVisionOcr,
    private gemini: GeminiVision
  ) {}
  ocrImage(page: PageImage) {
    return this.ocr.ocrImage(page);
  }
  extractTemplate(pages: PageImage[]) {
    return this.gemini.extractTemplate(pages);
  }
  readIdentity(page: PageImage, region: NormRect | null) {
    return this.gemini.readIdentity(page, region);
  }
  structureAnswer(answerType: string | null, page: PageImage, region: NormRect, ocrText: string) {
    return this.gemini.structureAnswer(answerType, page, region, ocrText);
  }
}

// Cached per isolate. Each call used to construct a fresh provider, and with the external
// backend that meant a fresh RateLimiter whose nextAt starts at zero -- so EXAM_OCR_RPM was not
// enforced even between the pages of one runBatch, and ordinary batches tripped provider quotas
// and fell into repeated backoff/DLQ handling. Caching makes the limiter span every message an
// isolate handles.
//
// Known limitation, stated rather than implied: the scheduler spawns up to five workers, each a
// separate isolate with its own limiter, so the effective ceiling is up to 5x EXAM_OCR_RPM.
// Enforcing a true global rate needs shared state (a DB token bucket); until then set
// EXAM_OCR_RPM to your provider quota divided by the worker count.
let cachedProvider: ExamVisionProvider | null = null;

export function getExamVisionProvider(): ExamVisionProvider {
  if (cachedProvider) return cachedProvider;
  cachedProvider = buildExamVisionProvider();
  return cachedProvider;
}

function buildExamVisionProvider(): ExamVisionProvider {
  const configured = Deno.env.get("EXAM_VISION_PROVIDER")?.trim().toLowerCase();
  // FAIL CLOSED on an unset variable. This used to default to "fake", and nothing in the repo
  // sets the variable -- so any deployment that had not been specially configured produced
  // deterministic PLACEHOLDER OCR while every job still reported success. Staff could reach
  // match review and finalization, confirm students against fabricated text, and have grades
  // recorded from it, with no error anywhere to indicate the scans were never read. A missing
  // configuration must look like a missing configuration, so the fake provider is now opt-IN
  // (tests and the local/e2e stack set EXAM_VISION_PROVIDER=fake explicitly).
  if (!configured) {
    throw new Error(
      "EXAM_VISION_PROVIDER is not set. Set it to 'gemini' (with GOOGLE_API_KEY) for real OCR, " +
        "or explicitly to 'fake' for tests and local development. It previously defaulted to " +
        "'fake', which silently produced placeholder OCR that looked like a successful scan."
    );
  }
  const which = configured;
  if (which === "fake") return new FakeExamVisionProvider();
  const ocrKey = Deno.env.get("EXAM_OCR_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const geminiKey = Deno.env.get("GOOGLE_API_KEY") ?? "";
  // Fail fast with an actionable message instead of constructing providers with empty keys
  // (which would otherwise surface as opaque 400/401s from Google deep in OCR/extraction).
  if (!ocrKey || !geminiKey) {
    throw new Error(
      `EXAM_VISION_PROVIDER='${which}' requires GOOGLE_API_KEY` +
        " (and optionally EXAM_OCR_API_KEY for a separate OCR key) to be set."
    );
  }
  const model = Deno.env.get("EXAM_GEMINI_MODEL") ?? "gemini-3.8-flash";
  const ocrRpm = parseInt(Deno.env.get("EXAM_OCR_RPM") ?? "60", 10);
  const geminiRpm = parseInt(Deno.env.get("EXAM_GEMINI_RPM") ?? "60", 10);
  return new CompositeExamVisionProvider(
    new GoogleVisionOcr(ocrKey, ocrRpm),
    new GeminiVision(geminiKey, model, geminiRpm, geminiBaseUrl(Deno.env.get("EXAM_GEMINI_BASE_URL")))
  );
}

// Hosts EXAM_GEMINI_BASE_URL may name. The override exists only to point the real adapter at a
// local fault-injecting stand-in (_shared/examVision.provider.test.ts), and every request carries
// GOOGLE_API_KEY, so it must not be configurable to any other destination.
// host.docker.internal is here because the edge runtime runs in a container, where loopback is
// the container itself, so functions served locally can only reach a stand-in on the machine
// through it. This bounds what the variable can name; where these names resolve is still up to
// the host's resolver and Docker configuration.
const GEMINI_TEST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);

function geminiBaseUrl(raw: string | undefined): string {
  // An empty value (e.g. `EXAM_GEMINI_BASE_URL=` in an env file) means unset, not a relative URL.
  const value = raw?.trim();
  if (!value) return "https://generativelanguage.googleapis.com";
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // Reported below with every other rejection.
  }
  // Checked on the parsed URL, not the string, and the request is built from url.origin, so the
  // host checked is the host requested. A bare origin only: a path, query, fragment or userinfo
  // has no use here. The value is not echoed, since this message reaches the batch error.
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !GEMINI_TEST_HOSTS.has(url.hostname) ||
    url.href !== `${url.origin}/`
  ) {
    throw new Error(
      "EXAM_GEMINI_BASE_URL may only point at a local test server: an http(s) origin on localhost, " +
        "127.0.0.1, [::1] or host.docker.internal, with no path. Leave it unset to use Gemini."
    );
  }
  return url.origin;
}
