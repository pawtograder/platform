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

export type NormRect = { x: number; y: number; width: number; height: number };
export type WordBox = NormRect & { text: string };
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

/** Text of the words whose center falls inside `region` (reading order: top-to-bottom, left-to-right). */
export function wordsInRegion(words: WordBox[], region: NormRect): string {
  const inside = words.filter((w) => {
    const cx = w.x + w.width / 2;
    const cy = w.y + w.height / 2;
    return cx >= region.x && cx <= region.x + region.width && cy >= region.y && cy <= region.y + region.height;
  });
  // Banded total order: group into ~0.02-tall rows (top-to-bottom), then left-to-right.
  // The pairwise `Math.abs(a.y-b.y) > 0.02 ? ... : ...` form is non-transitive, so it yields
  // engine-defined ordering for words clustered within a row. Keep in sync with lib/exam/regionMath.ts.
  inside.sort((a, b) => {
    const band = Math.round(a.y / 0.02) - Math.round(b.y / 0.02);
    return band !== 0 ? band : a.x - b.x;
  });
  return inside
    .map((w) => w.text)
    .join(" ")
    .trim();
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
// ---------------------------------------------------------------------------
export class FakeExamVisionProvider implements ExamVisionProvider {
  ocrImage(page: PageImage): Promise<{ text: string; words: WordBox[] }> {
    const sis = page.name.match(/sis-([A-Za-z0-9]+)/)?.[1] ?? "unknown";
    const text = `OCR(${page.name}) sis-${sis}`;
    // place one word box per token spread down the page so region math has something to bite on
    const tokens = text.split(/\s+/);
    const words: WordBox[] = tokens.map((t, i) => ({
      text: t,
      x: 0.1,
      y: 0.1 + ((i * 0.05) % 0.8),
      width: 0.3,
      height: 0.03
    }));
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
    _page: PageImage,
    _region: NormRect,
    ocrText: string
  ): Promise<StructuredAnswer> {
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
      signal: AbortSignal.timeout(60000)
    });
    let res: Response;
    let body: string;
    try {
      res = await fetch(request);
      // Read the body here too: a connection that resets, or a timeout that fires, after the
      // headers arrive surfaces from the body read rather than from fetch.
      body = await res.text();
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
    if (res.status === 429) throw new ProviderRateLimitError("Gemini rate limited", 60);
    // No body: an error page can reflect request material (see ProviderTransientError).
    if (res.status >= 500) throw new ProviderTransientError("gemini", "server_error", res.status);
    if (!res.ok) throw new Error(`Gemini failed: ${res.status} ${body}`);
    // Outside the catch: a body that is not JSON stays a SyntaxError, as before.
    const json = JSON.parse(body);
    return json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  }
  private imagePart(page: PageImage) {
    return { inline_data: { mime_type: "image/png", data: toBase64(page.bytes) } };
  }
  private parseJson<T>(text: string, fallback: T): T {
    try {
      const cleaned = text
        .replace(/^```json\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  }
  async extractTemplate(pages: PageImage[]): Promise<ProposedTree> {
    const parts: unknown[] = [
      {
        text:
          "You are given page images of an exam template. Identify the question structure as up to 3 " +
          "nested levels (level 1 = sections/parts, level 2 = questions, level 3 = sub-questions/items) and " +
          "the bounding box (normalized 0..1: x,y,width,height) where each leaf answer is written. Also locate " +
          "the region where the student writes their name and the region for their student ID. Return strict " +
          'JSON: { "questions": [{ "client_id","parent_client_id","level","ordinal","label","prompt",' +
          '"answer_type","points" }], "regions": [{ "question_client_id"|null,"kind"(answer|name|student_id),' +
          '"page_number","x","y","width","height" }] }.'
      },
      ...pages.map((p) => this.imagePart(p))
    ];
    const text = await this.generate(parts);
    return this.parseJson<ProposedTree>(text, { questions: [], regions: [] });
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
  // Override only to point Gemini at a local fault-injecting stand-in (tests/e2e/exam-provider-faults.spec.ts).
  // An empty value (e.g. `EXAM_GEMINI_BASE_URL=` in an env file) means unset, not a relative URL.
  const geminiBaseUrl = (
    Deno.env.get("EXAM_GEMINI_BASE_URL")?.trim() || "https://generativelanguage.googleapis.com"
  ).replace(/\/+$/, "");
  return new CompositeExamVisionProvider(
    new GoogleVisionOcr(ocrKey, ocrRpm),
    new GeminiVision(geminiKey, model, geminiRpm, geminiBaseUrl)
  );
}
