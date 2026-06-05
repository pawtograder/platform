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

/** Text of the words whose center falls inside `region` (reading order: top-to-bottom, left-to-right). */
export function wordsInRegion(words: WordBox[], region: NormRect): string {
  const inside = words.filter((w) => {
    const cx = w.x + w.width / 2;
    const cy = w.y + w.height / 2;
    return cx >= region.x && cx <= region.x + region.width && cy >= region.y && cy <= region.y + region.height;
  });
  inside.sort((a, b) => (Math.abs(a.y - b.y) > 0.02 ? a.y - b.y : a.x - b.x));
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
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 429) throw new ProviderRateLimitError("Vision OCR rate limited", 60);
    if (!res.ok) throw new Error(`Vision OCR failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const annotation = json?.responses?.[0]?.fullTextAnnotation;
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
    rpm: number
  ) {
    this.limiter = new RateLimiter(rpmToInterval(rpm));
  }
  private async generate(parts: unknown[]): Promise<string> {
    await this.limiter.wait();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 }
      })
    });
    if (res.status === 429) throw new ProviderRateLimitError("Gemini rate limited", 60);
    if (!res.ok) throw new Error(`Gemini failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
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

export function getExamVisionProvider(): ExamVisionProvider {
  const which = (Deno.env.get("EXAM_VISION_PROVIDER") ?? "fake").toLowerCase();
  if (which === "fake") return new FakeExamVisionProvider();
  const ocrKey = Deno.env.get("EXAM_OCR_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const geminiKey = Deno.env.get("GOOGLE_API_KEY") ?? "";
  const model = Deno.env.get("EXAM_GEMINI_MODEL") ?? "gemini-2.0-flash";
  const ocrRpm = parseInt(Deno.env.get("EXAM_OCR_RPM") ?? "60", 10);
  const geminiRpm = parseInt(Deno.env.get("EXAM_GEMINI_RPM") ?? "60", 10);
  return new CompositeExamVisionProvider(
    new GoogleVisionOcr(ocrKey, ocrRpm),
    new GeminiVision(geminiKey, model, geminiRpm)
  );
}
