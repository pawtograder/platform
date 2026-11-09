// Generate a printable exam/quiz PDF from the exam_questions tree.
//
// Because WE lay out the page, we know every answer box's position exactly and emit it
// as a normalized-0..1 region — no upload + Gemini/vision step needed. The same regions
// are then persisted via exam_upsert_questions_and_regions, so a generated paper exam
// feeds the existing OCR/scan/match pipeline, and an in-app quiz shares one definition.
//
// Pure pdf-lib (no canvas), so this runs both in the browser (alongside pdfRasterize)
// and under Node for unit tests.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

export type NormRect = { x: number; y: number; width: number; height: number };

export type GeneratedQuestion = {
  client_id: string;
  parent_client_id: string | null;
  level: 1 | 2 | 3;
  ordinal: number;
  label?: string | null;
  prompt?: string | null;
  answer_type?: string | null;
  choices?: unknown;
};

export type GeneratedRegion = {
  question_client_id: string | null;
  kind: "answer" | "student_id" | "name";
  page_number: number;
} & NormRect;

export type GeneratedTemplate = {
  bytes: Uint8Array;
  regions: GeneratedRegion[];
  numPages: number;
};

export type GenerateExamPdfOptions = {
  title?: string;
  /** [width, height] in PDF points. Defaults to US Letter. */
  pageSize?: [number, number];
  /** Draw Name / Student ID capture boxes on page 1 (default true). */
  includeIdentity?: boolean;
  /**
   * Called with every text run and rectangle as it is drawn, in PDF points with a
   * bottom-left origin. Lets a caller without a PDF rasterizer (the Node seeder) render
   * page images that match the PDF exactly.
   */
  onDraw?: (op: ExamPdfDrawOp) => void;
};

export type ExamPdfDrawOp =
  | { kind: "text"; page_number: number; text: string; x: number; y: number; size: number; bold: boolean }
  | { kind: "rect"; page_number: number; x: number; y: number; width: number; height: number };

const MARGIN = 54; // 0.75"
const LINE_GAP = 4;
const BLOCK_GAP = 12;

function answerBoxHeight(answerType: string | null | undefined, choiceCount: number): number {
  switch (answerType) {
    case "free_text":
      return 96;
    case "short_answer":
      return 40;
    case "numeric":
      return 26;
    case "true_false":
      return 22;
    case "multiple_choice":
      return Math.max(22, choiceCount * 18 + 6);
    default:
      return 32;
  }
}

function asChoiceList(choices: unknown): string[] {
  if (Array.isArray(choices)) {
    return choices.map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && "text" in (c as Record<string, unknown>)) {
        return String((c as Record<string, unknown>).text);
      }
      return String(c);
    });
  }
  return [];
}

/** Greedy word-wrap to a max width at the given font size. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

/** Build a stable pre-order traversal of the question tree from a flat list. */
function preorder(questions: GeneratedQuestion[]): GeneratedQuestion[] {
  const childrenOf = new Map<string | null, GeneratedQuestion[]>();
  for (const q of questions) {
    const key = q.parent_client_id ?? null;
    const arr = childrenOf.get(key) ?? [];
    arr.push(q);
    childrenOf.set(key, arr);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.ordinal - b.ordinal);
  const out: GeneratedQuestion[] = [];
  const visit = (parent: string | null) => {
    for (const q of childrenOf.get(parent) ?? []) {
      out.push(q);
      visit(q.client_id);
    }
  };
  visit(null);
  return out;
}

export async function generateExamPdf(
  questions: GeneratedQuestion[],
  opts: GenerateExamPdfOptions = {}
): Promise<GeneratedTemplate> {
  const [pageWidth, pageHeight] = opts.pageSize ?? [612, 792];
  const includeIdentity = opts.includeIdentity ?? true;
  const usableWidth = pageWidth - 2 * MARGIN;
  const contentBottom = MARGIN;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Fail fast, and as a whole, on text the standard fonts cannot encode. StandardFonts use
  // WinAnsi (Windows-1252), so a CJK/Cyrillic/emoji character makes pdf-lib throw from deep
  // inside drawText -- previously mid-save, after exam_create had already run, with an opaque
  // "WinAnsi cannot encode" message and no indication of which question was at fault. The
  // alternative is embedding a Unicode font via @pdf-lib/fontkit, which means shipping a font
  // binary; until that is wanted, reject the input with a message naming the offending
  // characters. Deliberately NOT stripping them: that silently corrupts the exam text.
  const unsupported = new Set<string>();
  const checkText = (text: string | null | undefined) => {
    if (!text) return;
    for (const ch of text) {
      try {
        font.encodeText(ch);
      } catch {
        unsupported.add(ch);
      }
    }
  };
  checkText(opts.title);
  for (const q of questions) {
    checkText(q.label);
    checkText(q.prompt);
    if (Array.isArray(q.choices)) for (const c of q.choices) checkText(String(c));
  }
  if (unsupported.size > 0) {
    const shown = [...unsupported].slice(0, 10).join(" ");
    throw new Error(
      `The printable PDF cannot render these character(s): ${shown}. ` +
        `Printable exams use the standard PDF fonts, which only support Western European ` +
        `characters. Please replace them in the question text and save again.`
    );
  }

  const regions: GeneratedRegion[] = [];
  let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
  let pageNumber = 1;
  let cursorY = pageHeight - MARGIN;

  // bottom-left pdf rect -> top-left normalized region
  const toNorm = (x: number, yBottom: number, w: number, h: number): NormRect => ({
    x: x / pageWidth,
    y: (pageHeight - (yBottom + h)) / pageHeight,
    width: w / pageWidth,
    height: h / pageHeight
  });

  const newPage = () => {
    page = doc.addPage([pageWidth, pageHeight]);
    pageNumber += 1;
    cursorY = pageHeight - MARGIN;
  };

  const drawText = (text: string, x: number, y: number, size: number, useFont: PDFFont) => {
    page.drawText(text, { x, y, size, font: useFont, color: rgb(0, 0, 0) });
    opts.onDraw?.({ kind: "text", page_number: pageNumber, text, x, y, size, bold: useFont === bold });
  };

  const drawBox = (x: number, y: number, width: number, height: number) => {
    page.drawRectangle({ x, y, width, height, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
    opts.onDraw?.({ kind: "rect", page_number: pageNumber, x, y, width, height });
  };

  // ensure `needed` vertical points are available below the cursor; page-break otherwise
  const ensureSpace = (needed: number) => {
    if (cursorY - needed < contentBottom) newPage();
  };

  const drawParagraph = (text: string, size: number, useFont: PDFFont, indent: number) => {
    if (!text) return;
    const lines = wrapText(text, useFont, size, usableWidth - indent);
    for (const line of lines) {
      ensureSpace(size + LINE_GAP);
      cursorY -= size;
      drawText(line, MARGIN + indent, cursorY, size, useFont);
      cursorY -= LINE_GAP;
    }
  };

  const drawAnswerBox = (qClientId: string, answerType: string | null | undefined, choices: string[]) => {
    const boxH = answerBoxHeight(answerType, choices.length);
    // ensureSpace only ever starts ONE new page, so a block taller than a whole page silently
    // overflowed: the rectangle and the later choices were drawn below the page edge, and the
    // normalized region emitted for OCR could exceed height 1 -- an answer box that no scan
    // can ever be read against. Reject it here, with the count that caused it, rather than
    // producing a broken template. (Same choice as the WinAnsi pre-flight: fail loudly rather
    // than emit something subtly unusable.)
    const maxBlockHeight = pageHeight - 2 * MARGIN;
    if (boxH + BLOCK_GAP > maxBlockHeight) {
      throw new Error(
        `An answer block for this question needs ${Math.ceil(boxH)}pt but a page only provides ` +
          `${Math.floor(maxBlockHeight)}pt` +
          (choices.length > 0 ? ` (${choices.length} choices)` : "") +
          `. Split the question or reduce the number of choices.`
      );
    }
    ensureSpace(boxH + BLOCK_GAP);
    const boxTopY = cursorY;
    const boxBottomY = boxTopY - boxH;
    drawBox(MARGIN, boxBottomY, usableWidth, boxH);
    if (answerType === "multiple_choice" && choices.length) {
      let optY = boxTopY - 14;
      choices.forEach((choice, i) => {
        const letter = String.fromCharCode(65 + i); // A, B, C ...
        drawText(`(${letter})  ${choice}`, MARGIN + 8, optY, 11, font);
        optY -= 18;
      });
    } else if (answerType === "true_false") {
      drawText("(   ) True        (   ) False", MARGIN + 8, boxBottomY + 6, 11, font);
    }
    regions.push({
      question_client_id: qClientId,
      kind: "answer",
      page_number: pageNumber,
      ...toNorm(MARGIN, boxBottomY, usableWidth, boxH)
    });
    cursorY = boxBottomY - BLOCK_GAP;
  };

  // --- title ---
  if (opts.title) {
    drawParagraph(opts.title, 18, bold, 0);
    cursorY -= 4;
  }

  // --- identity capture boxes (page 1) ---
  if (includeIdentity) {
    const fieldH = 22;
    const labelSize = 11;
    // Name
    ensureSpace(fieldH + BLOCK_GAP);
    drawText("Name:", MARGIN, cursorY - 15, labelSize, bold);
    const nameBoxX = MARGIN + 44;
    const nameBoxW = usableWidth - 44;
    drawBox(nameBoxX, cursorY - fieldH, nameBoxW, fieldH);
    regions.push({
      question_client_id: null,
      kind: "name",
      page_number: pageNumber,
      ...toNorm(nameBoxX, cursorY - fieldH, nameBoxW, fieldH)
    });
    cursorY -= fieldH + BLOCK_GAP;
    // Student ID
    ensureSpace(fieldH + BLOCK_GAP);
    drawText("Student ID:", MARGIN, cursorY - 15, labelSize, bold);
    const idBoxX = MARGIN + 70;
    const idBoxW = usableWidth - 70;
    drawBox(idBoxX, cursorY - fieldH, idBoxW, fieldH);
    regions.push({
      question_client_id: null,
      kind: "student_id",
      page_number: pageNumber,
      ...toNorm(idBoxX, cursorY - fieldH, idBoxW, fieldH)
    });
    cursorY -= fieldH + BLOCK_GAP + 6;
  }

  // --- questions ---
  const ordered = preorder(questions);
  const hasChildren = new Set(questions.map((q) => q.parent_client_id).filter((p): p is string => p != null));

  for (const q of ordered) {
    const indent = (q.level - 1) * 14;
    const headingFont = q.level === 1 ? bold : font;
    const headingSize = q.level === 1 ? 13 : 11;
    if (q.label) drawParagraph(q.label, headingSize, headingFont, indent);
    if (q.prompt) drawParagraph(q.prompt, 11, font, indent);

    const isLeaf = !hasChildren.has(q.client_id);
    if (isLeaf && q.answer_type) {
      drawAnswerBox(q.client_id, q.answer_type, asChoiceList(q.choices));
    } else {
      cursorY -= LINE_GAP;
    }
  }

  const bytes = await doc.save();
  return { bytes, regions, numPages: doc.getPageCount() };
}
