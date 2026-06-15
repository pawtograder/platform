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
};

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
      page.drawText(line, { x: MARGIN + indent, y: cursorY, size, font: useFont, color: rgb(0, 0, 0) });
      cursorY -= LINE_GAP;
    }
  };

  const drawAnswerBox = (qClientId: string, answerType: string | null | undefined, choices: string[]) => {
    const boxH = answerBoxHeight(answerType, choices.length);
    ensureSpace(boxH + BLOCK_GAP);
    const boxTopY = cursorY;
    const boxBottomY = boxTopY - boxH;
    page.drawRectangle({
      x: MARGIN,
      y: boxBottomY,
      width: usableWidth,
      height: boxH,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 1
    });
    if (answerType === "multiple_choice" && choices.length) {
      let optY = boxTopY - 14;
      choices.forEach((choice, i) => {
        const letter = String.fromCharCode(65 + i); // A, B, C ...
        page.drawText(`(${letter})  ${choice}`, { x: MARGIN + 8, y: optY, size: 11, font, color: rgb(0, 0, 0) });
        optY -= 18;
      });
    } else if (answerType === "true_false") {
      page.drawText("(   ) True        (   ) False", {
        x: MARGIN + 8,
        y: boxBottomY + 6,
        size: 11,
        font,
        color: rgb(0, 0, 0)
      });
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
    page.drawText("Name:", { x: MARGIN, y: cursorY - 15, size: labelSize, font: bold, color: rgb(0, 0, 0) });
    const nameBoxX = MARGIN + 44;
    const nameBoxW = usableWidth - 44;
    page.drawRectangle({
      x: nameBoxX,
      y: cursorY - fieldH,
      width: nameBoxW,
      height: fieldH,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 1
    });
    regions.push({
      question_client_id: null,
      kind: "name",
      page_number: pageNumber,
      ...toNorm(nameBoxX, cursorY - fieldH, nameBoxW, fieldH)
    });
    cursorY -= fieldH + BLOCK_GAP;
    // Student ID
    ensureSpace(fieldH + BLOCK_GAP);
    page.drawText("Student ID:", { x: MARGIN, y: cursorY - 15, size: labelSize, font: bold, color: rgb(0, 0, 0) });
    const idBoxX = MARGIN + 70;
    const idBoxW = usableWidth - 70;
    page.drawRectangle({
      x: idBoxX,
      y: cursorY - fieldH,
      width: idBoxW,
      height: fieldH,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 1
    });
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
