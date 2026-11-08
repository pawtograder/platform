/* eslint-disable no-console */
/**
 * Seeds exam and quiz assignments into a class: question trees, template PDFs and page
 * images, scanned papers in every batch state, finalized submissions with exam_v1
 * artifacts, in-app quiz attempts, and grading. Scenarios live in examTemplates.ts.
 *
 * Writes go through the same RPCs the app and the exam worker use wherever the service
 * role may call them (exam_create, exam_upsert_questions_and_regions,
 * exam_sync_rubric_from_questions, exam_create_submission, quiz_autograde). The OCR,
 * matching, and finalize steps run in the exam-async-worker against a vision provider, so
 * the seeder writes their results directly in the shapes the worker produces.
 *
 * Page images are rendered from SVG with sharp, using the draw operations that
 * generateExamPdf reports, so a page image lines up with its regions exactly. That needs
 * a font with Helvetica's metrics, since generateExamPdf lays text out with them: Liberation
 * Sans or Nimbus Sans. The seeder image installs Liberation. Other fonts render wider than
 * the layout allows (DejaVu Sans by about 14%), so lines run past the margin and no longer
 * match the OCR word boxes. With no font at all, pages render with boxes but no text.
 */
import { faker } from "@faker-js/faker";
import { addDays, addMinutes } from "date-fns";
import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";
import sharp from "sharp";

import { generateExamPdf, type ExamPdfDrawOp, type GeneratedQuestion } from "@/lib/exam/pdfGenerate";
import { wordsInRegion, type NormRect, type WordBox } from "@/lib/exam/regionMath";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { supabase, type TestingUser } from "../tests/e2e/TestingUtils";
import { EXAM_SCENARIOS, type SeedExamQuestion, type SeedExamScenario } from "./examTemplates";

export interface ExamConfig {
  /** Scenario keys from examTemplates.ts to seed. Defaults to all of them. */
  scenarios?: string[];
  /**
   * Most students whose papers are scanned for each paper exam. Every scanned page is a
   * rendered image uploaded to storage, so this bounds the seed's cost in large classes.
   */
  maxScannedStudents?: number;
}

export type ExamSeedSummary = {
  assignments: { id: number; title: string; type: string; submissions: number }[];
};

// US Letter in PDF points, rendered at 2x: the size the in-browser rasterizer produces.
const PAGE_W_PT = 612;
const PAGE_H_PT = 792;
const SCALE = 2;
const PAGE_W_PX = PAGE_W_PT * SCALE;
const PAGE_H_PX = PAGE_H_PT * SCALE;

// Metric-compatible with the Helvetica that generateExamPdf measures text with.
const PRINT_FONT = "'Liberation Sans', 'Nimbus Sans', Helvetica, Arial, sans-serif";
const HAND_FONT =
  "'Comic Neue', 'Patrick Hand', 'Comic Sans MS', 'Segoe Print', cursive, 'Liberation Sans', sans-serif";
const INK = "#1f3c88";

const OBJECTIVE = new Set(["multiple_choice", "true_false", "numeric"]);

// ============================
// Question tree helpers
// ============================

type BuiltQuestion = SeedExamQuestion & { level: 1 | 2 | 3; ordinal: number; isLeaf: boolean };

function buildTree(questions: SeedExamQuestion[]): BuiltQuestion[] {
  const byKey = new Map(questions.map((q) => [q.key, q]));
  const labels = new Set<string>();
  const siblingCount = new Map<string, number>();
  const hasChildren = new Set(questions.map((q) => q.parent).filter((p): p is string => !!p));
  return questions.map((q) => {
    if (labels.has(q.label)) throw new Error(`examTemplates: duplicate label "${q.label}"`);
    labels.add(q.label);
    let level = 1;
    for (let p = q.parent; p; p = byKey.get(p)?.parent) {
      if (!byKey.has(p)) throw new Error(`examTemplates: ${q.key} has unknown parent ${p}`);
      level++;
    }
    if (level > 3) throw new Error(`examTemplates: ${q.key} is nested deeper than 3 levels`);
    const parentKey = q.parent ?? "";
    const ordinal = siblingCount.get(parentKey) ?? 0;
    siblingCount.set(parentKey, ordinal + 1);
    return { ...q, level: level as 1 | 2 | 3, ordinal, isLeaf: !hasChildren.has(q.key) };
  });
}

function totalPoints(tree: BuiltQuestion[]): number {
  return tree.filter((q) => q.isLeaf && q.answer_type).reduce((sum, q) => sum + (q.points ?? 0), 0);
}

// ============================
// Student answers
// ============================

type StudentAnswer = {
  /** What the student wrote, as text. Empty when the answer is left blank. */
  text: string;
  /** The structured value: a choice, choice list, boolean, number, or the text itself. */
  value: Json;
  /** Fraction of the question's points the answer deserves. */
  credit: number;
  /** Multiple choice: the indexes of the circled choices. */
  circled?: number[];
};

/** A student's chance of answering well, so their answers are consistent across an exam. */
function studentAbility(): number {
  return faker.number.float({ min: 0.3, max: 0.98 });
}

function answerQuestion(q: BuiltQuestion, ability: number): StudentAnswer {
  const choices = q.choices ?? [];
  const correct = Math.random() < ability;
  // A few answers are left blank, more often by weaker students.
  if (Math.random() < 0.06 * (1.2 - ability)) return { text: "", value: null, credit: 0 };

  switch (q.answer_type) {
    case "multiple_choice": {
      const key = q.correct_answer as { choice?: string; choices?: string[] } | undefined;
      if (key?.choices) {
        // Select-all-that-apply: a wrong answer adds or drops one option.
        const picked = new Set(key.choices);
        if (!correct) {
          const toggle = faker.helpers.arrayElement(choices);
          if (picked.has(toggle) && picked.size > 1) picked.delete(toggle);
          else picked.add(toggle);
        }
        const values = choices.filter((c) => picked.has(c));
        const isRight = values.length === key.choices.length && values.every((v) => key.choices!.includes(v));
        return {
          text: values.join(", "),
          value: values,
          credit: isRight ? 1 : 0,
          circled: values.map((v) => choices.indexOf(v))
        };
      }
      const wrong = choices.filter((c) => c !== key?.choice);
      const choice = correct || wrong.length === 0 ? key!.choice! : faker.helpers.arrayElement(wrong);
      return {
        text: choice,
        value: choice,
        credit: choice === key?.choice ? 1 : 0,
        circled: [choices.indexOf(choice)]
      };
    }
    case "true_false": {
      const key = (q.correct_answer as { value: boolean }).value;
      const value = correct ? key : !key;
      return { text: value ? "True" : "False", value, credit: value === key ? 1 : 0 };
    }
    case "numeric": {
      const key = (q.correct_answer as { value: number }).value;
      const value = correct || !q.distractors?.length ? key : faker.helpers.arrayElement(q.distractors);
      const tolerance = q.grading_tolerance ?? 0;
      return { text: String(value), value, credit: Math.abs(value - key) <= tolerance ? 1 : 0 };
    }
    default: {
      const responses = q.responses ?? [{ text: faker.lorem.sentences(2), credit: 0.5 }];
      // Stronger students land nearer the best answer, with some noise.
      const position = Math.min(0.999, Math.max(0, 1 - ability + faker.number.float({ min: -0.2, max: 0.2 })));
      const response = responses[Math.floor(position * responses.length)];
      return { text: response.text, value: response.text, credit: response.credit };
    }
  }
}

// ============================
// Page rendering
// ============================

type HandMark =
  | { kind: "text"; x: number; y: number; size: number; text: string }
  | { kind: "circle"; cx: number; cy: number; rx: number; ry: number };

let helvetica: { regular: PDFFont; bold: PDFFont } | null = null;

/** Helvetica metrics, to place printed words in the OCR output where the PDF draws them. */
async function fontMetrics() {
  if (!helvetica) {
    const doc = await PDFDocument.create();
    helvetica = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold)
    };
  }
  return helvetica;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Top-left normalized rect of a word drawn at PDF baseline (x, y). */
function wordBox(text: string, x: number, baselineY: number, width: number, size: number): WordBox {
  return {
    text,
    x: x / PAGE_W_PT,
    y: (PAGE_H_PT - baselineY - size * 0.8) / PAGE_H_PT,
    width: width / PAGE_W_PT,
    height: size / PAGE_H_PT
  };
}

/** Word boxes for printed text, split the way an OCR engine reports them. */
async function printedWords(ops: ExamPdfDrawOp[]): Promise<WordBox[]> {
  const fonts = await fontMetrics();
  const words: WordBox[] = [];
  for (const op of ops) {
    if (op.kind !== "text") continue;
    const font = op.bold ? fonts.bold : fonts.regular;
    let cursor = op.x;
    for (const token of op.text.split(/(\s+)/)) {
      const width = font.widthOfTextAtSize(token, op.size);
      if (token.trim()) words.push(wordBox(token, cursor, op.y, width, op.size));
      cursor += width;
    }
  }
  return words;
}

/** Approximate handwriting width: wider than Helvetica, and a little uneven. */
function handWidth(text: string, size: number): number {
  return text.length * size * 0.55;
}

function handWords(marks: HandMark[]): WordBox[] {
  const words: WordBox[] = [];
  for (const m of marks) {
    if (m.kind !== "text") continue;
    let cursor = m.x;
    for (const token of m.text.split(/\s+/).filter(Boolean)) {
      const width = handWidth(token, m.size);
      words.push(wordBox(token, cursor, m.y, width, m.size));
      cursor += width + m.size * 0.35;
    }
  }
  return words;
}

/**
 * Wrap handwriting into a box given as a top-left normalized region. Returns the marks and
 * whatever did not fit, which a student carries over to a continuation box.
 */
function writeInRegion(text: string, region: NormRect, size: number): { marks: HandMark[]; rest: string } {
  const left = region.x * PAGE_W_PT + 8;
  const top = PAGE_H_PT - region.y * PAGE_H_PT;
  const maxWidth = region.width * PAGE_W_PT - 16;
  const lineHeight = size * 1.35;
  const maxLines = Math.max(1, Math.floor((region.height * PAGE_H_PT - 6) / lineHeight));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (handWidth(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const marks = lines.slice(0, maxLines).map((l, i) => ({
    kind: "text" as const,
    x: left + faker.number.float({ min: -2, max: 6 }),
    y: top - 4 - size - i * lineHeight,
    size,
    text: l
  }));
  return { marks, rest: lines.slice(maxLines).join(" ") };
}

function pageSvg(ops: ExamPdfDrawOp[], marks: HandMark[], scanned: boolean): string {
  const parts: string[] = [];
  for (const op of ops) {
    if (op.kind === "rect") {
      parts.push(
        `<rect x="${op.x}" y="${PAGE_H_PT - op.y - op.height}" width="${op.width}" height="${op.height}" fill="none" stroke="#999999" stroke-width="1"/>`
      );
    } else {
      parts.push(
        `<text x="${op.x}" y="${PAGE_H_PT - op.y}" font-size="${op.size}" font-family="${PRINT_FONT}"${op.bold ? ' font-weight="bold"' : ""} fill="#000000" xml:space="preserve">${xmlEscape(op.text)}</text>`
      );
    }
  }
  for (const m of marks) {
    if (m.kind === "circle") {
      parts.push(
        `<ellipse cx="${m.cx}" cy="${PAGE_H_PT - m.cy}" rx="${m.rx}" ry="${m.ry}" fill="none" stroke="${INK}" stroke-width="1.6" transform="rotate(${faker.number.int({ min: -8, max: 8 })} ${m.cx} ${PAGE_H_PT - m.cy})"/>`
      );
    } else {
      parts.push(
        `<text x="${m.x}" y="${PAGE_H_PT - m.y}" font-size="${m.size}" font-family="${HAND_FONT}" fill="${INK}" xml:space="preserve">${xmlEscape(m.text)}</text>`
      );
    }
  }
  const background = scanned ? "#fbfaf5" : "#ffffff";
  // A scan sits slightly askew on the glass and picks up specks of dust.
  const tilt = scanned ? faker.number.float({ min: -0.35, max: 0.35 }) : 0;
  const specks = scanned
    ? Array.from(
        { length: faker.number.int({ min: 6, max: 20 }) },
        () =>
          `<circle cx="${faker.number.float({ min: 0, max: PAGE_W_PT })}" cy="${faker.number.float({ min: 0, max: PAGE_H_PT })}" r="${faker.number.float({ min: 0.2, max: 0.8 })}" fill="#8a8a8a" opacity="0.5"/>`
      ).join("")
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W_PX}" height="${PAGE_H_PX}" viewBox="0 0 ${PAGE_W_PT} ${PAGE_H_PT}">` +
    `<rect width="${PAGE_W_PT}" height="${PAGE_H_PT}" fill="${background}"/>` +
    `<g transform="rotate(${tilt} ${PAGE_W_PT / 2} ${PAGE_H_PT / 2})">${parts.join("")}</g>${specks}</svg>`
  );
}

async function renderPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
}

// ============================
// Templates
// ============================

type RegionPayload = {
  question_client_id: string | null;
  kind: "answer" | "student_id" | "name";
  page_number: number;
} & NormRect;

type Template = {
  numPages: number;
  pdfBytes: Uint8Array;
  /** Draw operations per page (1-based). */
  opsByPage: Map<number, ExamPdfDrawOp[]>;
  /** Regions exactly where the PDF draws its boxes; used to place handwriting. */
  drawnRegions: RegionPayload[];
  /** Regions as stored: exact for generated templates, hand-drawn (looser) for uploaded PDFs. */
  storedRegions: RegionPayload[];
};

/** Regions an instructor drew by hand over an uploaded PDF: padded and a little off. */
function handDrawn(region: RegionPayload): RegionPayload {
  const jitter = () => faker.number.float({ min: -0.004, max: 0.004 });
  const x = Math.max(0, region.x - 0.006 + jitter());
  const y = Math.max(0, region.y - 0.004 + jitter());
  return {
    ...region,
    x,
    y,
    width: Math.min(1 - x, region.width + 0.012 + jitter()),
    height: Math.min(1 - y, region.height + 0.008 + jitter())
  };
}

// Page margin generateExamPdf uses, in points.
const PDF_MARGIN = 54;

/**
 * Insert a page right after the one holding `q`'s answer box, carrying a second answer box
 * for the same question, as an instructor's own PDF might ("continue your answer here").
 * Later pages shift down by one. Returns the new page count.
 */
function addContinuationPage(
  q: BuiltQuestion,
  opsByPage: Map<number, ExamPdfDrawOp[]>,
  regions: RegionPayload[],
  pageCount: number
): number {
  const index = regions.findIndex((r) => r.kind === "answer" && r.question_client_id === q.key);
  if (index < 0) throw new Error(`examTemplates: ${q.key} continues its answer but has no answer box`);
  const after = regions[index].page_number;
  for (let page = pageCount; page > after; page--) {
    const ops = opsByPage.get(page) ?? [];
    opsByPage.set(
      page + 1,
      ops.map((op) => ({ ...op, page_number: page + 1 }))
    );
  }
  for (const r of regions) if (r.page_number > after) r.page_number += 1;

  const page = after + 1;
  const width = PAGE_W_PT - 2 * PDF_MARGIN;
  const headingY = PAGE_H_PT - PDF_MARGIN - 13;
  const noteY = headingY - 20;
  const boxTop = noteY - 14;
  const boxHeight = boxTop - PDF_MARGIN;
  opsByPage.set(page, [
    {
      kind: "text",
      page_number: page,
      text: `${q.label} (continued)`,
      x: PDF_MARGIN,
      y: headingY,
      size: 13,
      bold: true
    },
    {
      kind: "text",
      page_number: page,
      text: "Continue your answer in the box below.",
      x: PDF_MARGIN,
      y: noteY,
      size: 11,
      bold: false
    },
    { kind: "rect", page_number: page, x: PDF_MARGIN, y: PDF_MARGIN, width, height: boxHeight }
  ]);
  regions.splice(index + 1, 0, {
    question_client_id: q.key,
    kind: "answer",
    page_number: page,
    x: PDF_MARGIN / PAGE_W_PT,
    y: (PAGE_H_PT - boxTop) / PAGE_H_PT,
    width: width / PAGE_W_PT,
    height: boxHeight / PAGE_H_PT
  });
  return pageCount + 1;
}

async function buildTemplate(scenario: SeedExamScenario, tree: BuiltQuestion[]): Promise<Template> {
  const ops: ExamPdfDrawOp[] = [];
  const generated: GeneratedQuestion[] = tree.map((q) => ({
    client_id: q.key,
    parent_client_id: q.parent ?? null,
    level: q.level,
    ordinal: q.ordinal,
    label: q.label,
    prompt: q.prompt ?? null,
    answer_type: q.answer_type ?? null,
    choices: q.choices ?? null
  }));
  const { bytes, regions, numPages } = await generateExamPdf(generated, {
    title: scenario.title,
    onDraw: (op) => ops.push(op)
  });
  const opsByPage = new Map<number, ExamPdfDrawOp[]>();
  for (const op of ops) {
    const list = opsByPage.get(op.page_number) ?? [];
    list.push(op);
    opsByPage.set(op.page_number, list);
  }
  const drawnRegions: RegionPayload[] = regions.map((r) => ({ ...r }));
  let pageCount = numPages;
  for (const q of tree.filter((t) => t.answerContinues)) {
    if (scenario.template === "generated") {
      throw new Error(`examTemplates: ${q.key} continues its answer, which a generated template cannot show`);
    }
    pageCount = addContinuationPage(q, opsByPage, drawnRegions, pageCount);
  }
  return {
    numPages: pageCount,
    pdfBytes: bytes,
    opsByPage,
    drawnRegions,
    storedRegions: scenario.template === "generated" ? drawnRegions : drawnRegions.map(handDrawn)
  };
}

// ============================
// Utilities
// ============================

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

function check<T>(result: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null || result.data === undefined) throw new Error(`${what}: no data returned`);
  return result.data as NonNullable<T>;
}

async function upload(bucket: string, path: string, bytes: Uint8Array, contentType: string) {
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`upload ${bucket}/${path}: ${error.message}`);
}

/** A student number as it might be written on a paper: seeded users have no SIS id. */
function studentNumber(profileId: string): string {
  const digits = profileId.replace(/\D/g, "").padEnd(7, "0").slice(0, 7);
  return `00${digits}`;
}

/** What OCR makes of a hastily written name: a dropped letter and an abbreviated first name. */
function smudge(name: string): string {
  const chars = name.split("");
  chars.splice(faker.number.int({ min: 1, max: Math.max(1, chars.length - 2) }), 1);
  const [first, ...rest] = chars.join("").split(" ");
  return rest.length ? `${first[0]}. ${rest.join(" ")}` : first;
}

// ============================
// Seeding
// ============================

type ClassPeople = {
  classId: number;
  students: TestingUser[];
  graders: TestingUser[];
  instructors: TestingUser[];
};

type SeededExam = {
  assignmentId: number;
  rubricId: number;
  examId: number;
  /** exam_questions.id by scenario question key. */
  questionIds: Map<string, number>;
  tree: BuiltQuestion[];
  template: Template;
};

async function createAssessmentAssignment(scenario: SeedExamScenario, tree: BuiltQuestion[], classId: number) {
  const now = new Date();
  const settings = check(
    await supabase
      .from("assignment_self_review_settings")
      .insert({ class_id: classId, enabled: false })
      .select("id")
      .single(),
    `self review settings for ${scenario.title}`
  );
  // Mirrors the assignment form for quiz/exam types: no repository, no autograder,
  // individual only, and no branch protection.
  const assignment = check(
    await supabase
      .from("assignments")
      .insert({
        class_id: classId,
        title: scenario.title,
        slug: scenario.slug,
        description:
          scenario.delivery === "paper"
            ? `${scenario.title}. Written in class on paper; scanned papers are graded online.`
            : `${scenario.title}. Taken online; objective questions are graded automatically.`,
        release_date: addDays(now, scenario.releaseOffsetDays).toISOString(),
        due_date: addDays(now, scenario.dueOffsetDays).toISOString(),
        total_points: totalPoints(tree),
        assignment_type: scenario.assignmentType,
        repo_mode: "none",
        template_repo: null,
        has_autograder: false,
        has_handgrader: true,
        group_config: "individual",
        allow_student_formed_groups: false,
        permit_empty_submissions: false,
        allow_not_graded_submissions: false,
        self_review_setting_id: settings.id,
        protect_block_force_push: false,
        protect_require_pull_request: false,
        protect_required_reviewers: 0
      })
      .select("id")
      .single(),
    `assignment ${scenario.title}`
  );
  // The grading rubric is attached by an AFTER INSERT trigger, so it is not in the insert's RETURNING row.
  const { grading_rubric_id } = check(
    await supabase.from("assignments").select("grading_rubric_id").eq("id", assignment.id).single(),
    `read back assignment ${scenario.title}`
  );
  if (!grading_rubric_id) throw new Error(`assignment ${scenario.title} has no grading rubric`);
  return { assignmentId: assignment.id, rubricId: grading_rubric_id };
}

async function createExam(scenario: SeedExamScenario, people: ClassPeople): Promise<SeededExam> {
  const { classId } = people;
  const tree = buildTree(scenario.questions);
  const { assignmentId, rubricId } = await createAssessmentAssignment(scenario, tree, classId);
  const template = await buildTemplate(scenario, tree);

  const examId = check(
    await supabase.rpc("exam_create", {
      p_assignment_id: assignmentId,
      p_source_type: scenario.template === "generated" ? "generated" : "pdf",
      p_num_pages: template.numPages,
      p_delivery_mode: scenario.delivery
    }),
    `exam_create for ${scenario.title}`
  ) as number;

  // The builder keeps the PDF it generates for printing. An uploaded PDF is only rasterized.
  if (scenario.template === "generated") {
    const pdfPath = `classes/${classId}/exams/${examId}/template/generated.pdf`;
    await upload("exam-templates", pdfPath, template.pdfBytes, "application/pdf");
    check(
      await supabase.from("exams").update({ template_pdf_path: pdfPath }).eq("id", examId).select("id"),
      "record template_pdf_path"
    );
  }

  const pageNumbers = Array.from({ length: template.numPages }, (_, i) => i + 1);
  await mapLimit(pageNumbers, 4, async (pageNumber) => {
    const png = await renderPng(pageSvg(template.opsByPage.get(pageNumber) ?? [], [], false));
    const path = `classes/${classId}/exams/${examId}/template/page-${pageNumber}.png`;
    await upload("exam-templates", path, png, "image/png");
    check(
      await supabase
        .from("exam_template_pages")
        .insert({
          class_id: classId,
          exam_id: examId,
          page_number: pageNumber,
          image_path: path,
          width: PAGE_W_PX,
          height: PAGE_H_PX
        })
        .select("id"),
      `template page ${pageNumber}`
    );
  });

  const questionIds = new Map<string, number>();
  if (scenario.template !== "pdf-only") {
    const { error: upsertErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId,
      p_questions: tree.map((q) => ({
        id: null,
        client_id: q.key,
        parent_client_id: q.parent ?? null,
        level: q.level,
        ordinal: q.ordinal,
        label: q.label,
        prompt: q.prompt ?? null,
        answer_type: q.answer_type ?? null,
        choices: q.choices ?? null,
        points: q.isLeaf && q.answer_type ? (q.points ?? 0) : null,
        correct_answer: q.correct_answer ?? null,
        grading_tolerance: q.grading_tolerance ?? null
      })) as unknown as Json,
      p_regions: template.storedRegions as unknown as Json
    });
    if (upsertErr) throw new Error(`questions and regions for ${scenario.title}: ${upsertErr.message}`);
    const { error: syncErr } = await supabase.rpc("exam_sync_rubric_from_questions", {
      p_exam_id: examId,
      p_rubric_id: rubricId
    });
    if (syncErr) throw new Error(`rubric sync for ${scenario.title}: ${syncErr.message}`);

    const rows = check(
      await supabase.from("exam_questions").select("id, label").eq("exam_id", examId),
      "read back exam questions"
    );
    const keyByLabel = new Map(tree.map((q) => [q.label, q.key]));
    for (const row of rows) {
      const key = keyByLabel.get(row.label ?? "");
      if (key) questionIds.set(key, row.id);
    }
  }

  return { assignmentId, rubricId, examId, questionIds, tree, template };
}

// ---------- Paper exams ----------

type Paper = {
  student: TestingUser | null;
  answers: Map<string, StudentAnswer>;
  pages: { png: Buffer; words: WordBox[] }[];
};

async function writePaper(exam: SeededExam, student: TestingUser | null): Promise<Paper> {
  const { template, tree } = exam;
  const ability = studentAbility();
  const answers = new Map<string, StudentAnswer>();
  /** Text answers still to write, for questions whose answer runs into a continuation box. */
  const unwritten = new Map<string, string>();
  const marksByPage = new Map<number, HandMark[]>();
  const mark = (page: number, ...m: HandMark[]) => marksByPage.set(page, [...(marksByPage.get(page) ?? []), ...m]);
  const fonts = await fontMetrics();

  for (const region of template.drawnRegions) {
    if (!student) break; // a blank paper: nothing written on it
    if (region.kind === "name") {
      mark(region.page_number, ...writeInRegion(student.private_profile_name, region, 13).marks);
      continue;
    }
    if (region.kind === "student_id") {
      mark(region.page_number, ...writeInRegion(studentNumber(student.private_profile_id), region, 13).marks);
      continue;
    }
    const q = tree.find((t) => t.key === region.question_client_id);
    if (!q) continue;
    // A question can have more than one answer box: answer it once, at its first box.
    const firstBox = !answers.has(q.key);
    if (firstBox) {
      const answer = answerQuestion(q, ability);
      answers.set(q.key, answer);
      unwritten.set(q.key, answer.text);
    }
    const answer = answers.get(q.key)!;
    if (!answer.text || (!firstBox && !unwritten.get(q.key))) continue;

    const boxTop = PAGE_H_PT - region.y * PAGE_H_PT;
    const boxLeft = region.x * PAGE_W_PT;
    if (OBJECTIVE.has(q.answer_type ?? "") && !firstBox) continue;
    if (q.answer_type === "multiple_choice") {
      // Circle each chosen option's letter, as printed by generateExamPdf.
      for (const index of answer.circled ?? []) {
        const optionBaseline = boxTop - 14 - index * 18;
        mark(region.page_number, { kind: "circle", cx: boxLeft + 16, cy: optionBaseline + 4, rx: 9, ry: 8 });
      }
    } else if (q.answer_type === "true_false") {
      const baseline = PAGE_H_PT - (region.y + region.height) * PAGE_H_PT + 6;
      const printed = "(   ) True        (";
      const offset = answer.value
        ? fonts.regular.widthOfTextAtSize("(", 11)
        : fonts.regular.widthOfTextAtSize(printed, 11);
      mark(region.page_number, { kind: "text", x: boxLeft + 8 + offset + 1, y: baseline, size: 12, text: "X" });
    } else {
      // Text that does not fit carries over into the question's next box, if it has one.
      const size = q.answer_type === "free_text" ? 12 : 13;
      const { marks, rest } = writeInRegion(unwritten.get(q.key) ?? "", region, size);
      mark(region.page_number, ...marks);
      unwritten.set(q.key, rest);
    }
  }

  const pages = [];
  for (let page = 1; page <= template.numPages; page++) {
    const ops = template.opsByPage.get(page) ?? [];
    const marks = marksByPage.get(page) ?? [];
    const png = await renderPng(pageSvg(ops, marks, true));
    pages.push({ png, words: [...(await printedWords(ops)), ...handWords(marks)] });
  }
  return { student, answers, pages };
}

type FinalizedSubmission = { submissionId: number; student: TestingUser; answers: Map<string, StudentAnswer> };

async function seedScanBatches(
  scenario: SeedExamScenario,
  exam: SeededExam,
  people: ClassPeople,
  maxScanned: number
): Promise<FinalizedSubmission[]> {
  const { classId } = people;
  const { template } = exam;
  const scanned = faker.helpers.shuffle([...people.students]).slice(0, maxScanned);
  const uploader = people.instructors[0]?.user_id ?? null;
  const finalized: FinalizedSubmission[] = [];

  for (const [batchIndex, spec] of (scenario.batches ?? []).entries()) {
    const students = scanned.slice(0, Math.max(1, Math.round(scanned.length * spec.fraction)));
    // The review batch includes one paper with nothing legible on it, which staff skip.
    const papers: (TestingUser | null)[] = spec.status === "review" ? [...students, null] : students;
    const totalPages = papers.length * template.numPages;
    // A failed upload stops part-way through; only a prefix of the pages is stored.
    const storedPages = spec.status === "error" ? Math.floor(totalPages * 0.6) : totalPages;
    const ocrDone = spec.status === "review" || spec.status === "completed";

    const batch = check(
      await supabase
        .from("exam_scan_batches")
        .insert({
          class_id: classId,
          exam_id: exam.examId,
          uploaded_by: uploader,
          total_pages: totalPages,
          pages_per_exam: template.numPages,
          status: spec.status === "completed" ? "review" : spec.status,
          error:
            spec.status === "error"
              ? `incomplete upload: upload scan page ${storedPages} failed: The connection was reset by the server`
              : null,
          created_at: addMinutes(addDays(new Date(), scenario.dueOffsetDays), 90 + batchIndex * 45).toISOString()
        })
        .select("id")
        .single(),
      `scan batch for ${scenario.title}`
    );
    const batchId = batch.id;
    console.log(
      `     batch ${batchId} (${spec.status}): ${papers.length} papers, ${storedPages}/${totalPages} pages stored`
    );

    const written = await mapLimit(papers, 4, (student) => writePaper(exam, student));

    // Upload pages and record them.
    const pageRows = await mapLimit(
      written.flatMap((paper, examIndex) => paper.pages.map((page, p) => ({ paper, examIndex, page, p }))),
      6,
      async ({ page, examIndex, p }) => {
        const pageIndex = examIndex * template.numPages + p;
        if (pageIndex >= storedPages) return null;
        const path = `classes/${classId}/exams/${exam.examId}/batches/${batchId}/page-${pageIndex}.png`;
        await upload("exam-scans", path, page.png, "image/png");
        const row = check(
          await supabase
            .from("exam_scan_pages")
            .insert({
              class_id: classId,
              exam_id: exam.examId,
              batch_id: batchId,
              page_index: pageIndex,
              image_path: path,
              width: PAGE_W_PX,
              height: PAGE_H_PX,
              ocr_text: ocrDone ? page.words.map((w) => w.text).join(" ") : null,
              ocr_data: ocrDone ? ({ words: page.words } as unknown as Json) : null
            })
            .select("id")
            .single(),
          `scan page ${pageIndex}`
        );
        return { id: row.id, examIndex, path };
      }
    );

    if (!ocrDone) continue;

    // Match results, as the worker leaves them for review.
    for (const [examIndex, paper] of written.entries()) {
      const student = paper.student;
      let match: {
        detected_name: string | null;
        detected_sis_id: string | null;
        matched_profile_id: string | null;
        match_confidence: number | null;
        match_status: "unmatched" | "suggested" | "confirmed" | "skipped";
      };
      if (!student) {
        match = {
          detected_name: null,
          detected_sis_id: null,
          matched_profile_id: null,
          match_confidence: null,
          match_status: "skipped"
        };
      } else if (spec.status === "completed") {
        match = {
          detected_name: student.private_profile_name,
          detected_sis_id: studentNumber(student.private_profile_id),
          matched_profile_id: student.private_profile_id,
          match_confidence: 1,
          match_status: "confirmed"
        };
      } else {
        const roll = examIndex % 10;
        if (roll === 8) {
          // Illegible name: no student suggested.
          match = {
            detected_name: smudge(smudge(student.private_profile_name)),
            detected_sis_id: null,
            matched_profile_id: null,
            match_confidence: null,
            match_status: "unmatched"
          };
        } else if (roll === 9) {
          // Partly legible: a low-confidence suggestion.
          match = {
            detected_name: smudge(student.private_profile_name),
            detected_sis_id: null,
            matched_profile_id: student.private_profile_id,
            match_confidence: faker.number.float({ min: 0.45, max: 0.65, fractionDigits: 2 }),
            match_status: "suggested"
          };
        } else {
          match = {
            detected_name: student.private_profile_name,
            detected_sis_id: studentNumber(student.private_profile_id),
            matched_profile_id: student.private_profile_id,
            match_confidence: faker.number.float({ min: 0.86, max: 1, fractionDigits: 2 }),
            match_status: roll === 6 || roll === 7 ? "confirmed" : "suggested"
          };
        }
      }

      const ownPages = pageRows.filter((r): r is NonNullable<typeof r> => !!r && r.examIndex === examIndex);
      const scannedRow = check(
        await supabase
          .from("exam_scanned_submissions")
          .insert({
            class_id: classId,
            exam_id: exam.examId,
            batch_id: batchId,
            exam_index: examIndex,
            ...match
          })
          .select("id")
          .single(),
        `scanned submission ${examIndex}`
      );
      check(
        await supabase
          .from("exam_scan_pages")
          .update({ scanned_submission_id: scannedRow.id })
          .in(
            "id",
            ownPages.map((p) => p.id)
          )
          .select("id"),
        "link scan pages"
      );

      if (spec.status !== "completed" || !student) continue;
      finalized.push(await finalizePaper(exam, classId, scannedRow.id, student, paper));
    }

    if (spec.status === "completed") {
      check(
        await supabase.from("exam_scan_batches").update({ status: "completed" }).eq("id", batchId).select("id"),
        "complete batch"
      );
    }
  }
  return finalized;
}

/** What the worker's finalize step does for one confirmed paper. */
async function finalizePaper(
  exam: SeededExam,
  classId: number,
  scannedSubmissionId: number,
  student: TestingUser,
  paper: Paper
): Promise<FinalizedSubmission> {
  const submissionId = check(
    await supabase.rpc("exam_create_submission", { p_scanned_submission_id: scannedSubmissionId }),
    "exam_create_submission"
  ) as number;
  const profileId = student.private_profile_id;

  const pageRefs = await mapLimit(paper.pages, 4, async (page, i) => {
    const name = `exam-page-${i + 1}.png`;
    const storageKey = `classes/${classId}/profiles/${profileId}/submissions/${submissionId}/files/${name}`;
    await upload("submission-files", storageKey, page.png, "image/png");
    check(
      await supabase
        .from("submission_files")
        .insert({
          submission_id: submissionId,
          name,
          class_id: classId,
          profile_id: profileId,
          is_binary: true,
          mime_type: "image/png",
          file_size: page.png.length,
          storage_key: storageKey,
          contents: null
        })
        .select("id"),
      `submission file ${name}`
    );
    return { page_number: i + 1, storage_key: storageKey, width: PAGE_W_PX, height: PAGE_H_PX };
  });

  const questions = exam.template.storedRegions
    .filter((r) => r.kind === "answer" && r.question_client_id)
    .map((r) => {
      const q = exam.tree.find((t) => t.key === r.question_client_id)!;
      const page = paper.pages[r.page_number - 1];
      const ocrText = page ? wordsInRegion(page.words, r) : "";
      const answer = paper.answers.get(q.key);
      // The worker structures every non-free-text answer; free text stays as the OCR text.
      const structured = q.answer_type === "free_text" || !answer?.text ? ocrText : answer.value;
      return {
        exam_question_id: exam.questionIds.get(q.key),
        page_number: r.page_number,
        region: { x: r.x, y: r.y, width: r.width, height: r.height },
        ocr_text: ocrText,
        structured_value: structured
      };
    });

  check(
    await supabase
      .from("submission_artifacts")
      .insert({
        submission_id: submissionId,
        class_id: classId,
        profile_id: profileId,
        name: "Exam",
        data: { format: "exam_v1", pages: pageRefs, questions } as unknown as Json
      })
      .select("id"),
    "exam artifact"
  );
  check(
    await supabase
      .from("exam_scanned_submissions")
      .update({ finalized_at: new Date().toISOString() })
      .eq("id", scannedSubmissionId)
      .select("id"),
    "stamp finalized_at"
  );
  return { submissionId, student, answers: paper.answers };
}

// ---------- In-app quizzes ----------

/** What quiz_submit does, for a student, without needing to sign in as them. */
async function seedQuizAttempts(
  scenario: SeedExamScenario,
  exam: SeededExam,
  people: ClassPeople
): Promise<FinalizedSubmission[]> {
  const { classId } = people;
  const attempts = scenario.attempts;
  if (!attempts) return [];
  const leaves = exam.tree.filter((q) => q.isLeaf && q.answer_type);
  const due = addDays(new Date(), scenario.dueOffsetDays);
  const releasedAt = addDays(new Date(), scenario.releaseOffsetDays);
  const window = Math.max(1, due.getTime() - releasedAt.getTime());
  const finalized: FinalizedSubmission[] = [];

  const takers = people.students.filter(() => Math.random() < attempts.submitRate);
  await mapLimit(takers, 6, async (student) => {
    const ability = studentAbility();
    const tries = Math.random() < attempts.retakeRate ? 2 : 1;
    let attemptAt = releasedAt.getTime() + Math.random() * window * 0.7;
    for (let attempt = 0; attempt < tries; attempt++) {
      // A retake usually does a bit better.
      const answers = new Map(leaves.map((q) => [q.key, answerQuestion(q, Math.min(0.99, ability + attempt * 0.1))]));
      const questions = leaves
        .filter((q) => answers.get(q.key)!.text)
        .map((q) => {
          const region = exam.template.storedRegions.find((r) => r.kind === "answer" && r.question_client_id === q.key);
          const answer = answers.get(q.key)!;
          return {
            exam_question_id: exam.questionIds.get(q.key),
            page_number: region?.page_number ?? null,
            region: region ? { x: region.x, y: region.y, width: region.width, height: region.height } : null,
            ocr_text: typeof answer.value === "string" ? answer.value : JSON.stringify(answer.value),
            structured_value: answer.value
          };
        });
      const submittedAt = new Date(attemptAt);
      attemptAt += faker.number.int({ min: 10, max: 60 * 24 }) * 60_000;

      // The insert hook deactivates the student's earlier attempt.
      const submission = check(
        await supabase
          .from("submissions")
          .insert({
            assignment_id: exam.assignmentId,
            profile_id: student.private_profile_id,
            class_id: classId,
            sha: "quiz",
            repository: `quiz/${exam.assignmentId}/${student.private_profile_id}`,
            run_attempt: attempt,
            run_number: 1,
            is_active: true,
            submitted_via: "manual",
            created_at: submittedAt.toISOString()
          })
          .select("id")
          .single(),
        `quiz submission for ${student.private_profile_name}`
      );
      check(
        await supabase
          .from("submission_artifacts")
          .insert({
            submission_id: submission.id,
            class_id: classId,
            profile_id: student.private_profile_id,
            name: "Quiz",
            data: { format: "exam_v1", pages: [], questions } as unknown as Json
          })
          .select("id"),
        "quiz artifact"
      );
      const { error: gradeErr } = await supabase.rpc("quiz_autograde", { p_submission_id: submission.id });
      if (gradeErr) throw new Error(`quiz_autograde ${submission.id}: ${gradeErr.message}`);
      if (attempt === tries - 1) finalized.push({ submissionId: submission.id, student, answers });
    }
  });
  return finalized;
}

// ---------- Grading ----------

/** Graders each student may not be graded by, from grading_conflicts. */
async function loadGradingConflicts(classId: number): Promise<Map<string, Set<string>>> {
  const conflicts = new Map<string, Set<string>>();
  for (let from = 0; ; from += 1000) {
    const rows = check(
      await supabase
        .from("grading_conflicts")
        .select("grader_profile_id, student_profile_id")
        .eq("class_id", classId)
        .order("id")
        .range(from, from + 999),
      "read grading conflicts"
    );
    for (const r of rows) {
      const set = conflicts.get(r.student_profile_id) ?? new Set<string>();
      set.add(r.grader_profile_id);
      conflicts.set(r.student_profile_id, set);
    }
    if (rows.length < 1000) return conflicts;
  }
}

async function gradeExamSubmissions(
  scenario: SeedExamScenario,
  exam: SeededExam,
  people: ClassPeople,
  submissions: FinalizedSubmission[]
) {
  if (!scenario.grading || submissions.length === 0) return;
  const { classId } = people;
  const staff = people.graders.length > 0 ? people.graders : people.instructors;
  const checks = check(
    await supabase
      .from("rubric_checks")
      .select("id, points, exam_question_id")
      .eq("rubric_id", exam.rubricId)
      .not("exam_question_id", "is", null),
    "read exam rubric checks"
  );
  const checkByQuestion = new Map(checks.map((c) => [c.exam_question_id!, c]));
  const keyByQuestionId = new Map([...exam.questionIds].map(([k, id]) => [id, k]));
  // In chunks: PostgREST caps a response at 1,000 rows, and a long id list overflows the URL.
  const reviewBySubmission = new Map<number, number | null>();
  for (let start = 0; start < submissions.length; start += 200) {
    const ids = submissions.slice(start, start + 200).map((s) => s.submissionId);
    const rows = check(
      await supabase.from("submissions").select("id, grading_review_id").in("id", ids),
      "read grading reviews"
    );
    for (const r of rows) reviewBySubmission.set(r.id, r.grading_review_id);
  }
  const conflicts = await loadGradingConflicts(classId);
  /** The i-th grader in rotation, skipping any with a grading conflict for this student. */
  const pickGrader = (student: TestingUser, i: number): string => {
    const blocked = conflicts.get(student.private_profile_id);
    for (let k = 0; k < staff.length; k++) {
      const candidate = staff[(i + k) % staff.length].private_profile_id;
      if (!blocked?.has(candidate)) return candidate;
    }
    return people.instructors[0]?.private_profile_id ?? staff[i % staff.length].private_profile_id;
  };
  const now = new Date().toISOString();
  const due = addDays(new Date(), scenario.dueOffsetDays + 7).toISOString();

  let graded = 0;
  await mapLimit(submissions, 6, async (sub, i) => {
    const reviewId = reviewBySubmission.get(sub.submissionId);
    if (!reviewId) return;
    const grader = pickGrader(sub.student, i);
    const completed = Math.random() < scenario.grading!.completedFraction;
    if (completed) {
      const comments = [];
      for (const [questionId, rubricCheck] of checkByQuestion) {
        const answer = sub.answers.get(keyByQuestionId.get(questionId) ?? "");
        if (!answer || answer.credit <= 0) continue;
        const points = Math.round(answer.credit * rubricCheck.points * 2) / 2;
        comments.push({
          submission_id: sub.submissionId,
          submission_review_id: reviewId,
          class_id: classId,
          author: grader,
          rubric_check_id: rubricCheck.id,
          points,
          comment:
            answer.credit >= 1
              ? "Correct."
              : faker.helpers.arrayElement([
                  "Partial credit: on the right track, but the explanation is incomplete.",
                  "Partial credit: identifies the idea but misses a key detail.",
                  "Partial credit: see the solution for what a full answer covers."
                ]),
          released: true
        });
      }
      if (comments.length > 0) {
        check(await supabase.from("submission_comments").insert(comments).select("id"), "grading comments");
      }
      graded++;
    }
    check(
      await supabase
        .from("submission_reviews")
        .update({
          grader,
          completed_by: completed ? grader : null,
          completed_at: completed ? now : null,
          released: completed && scenario.grading!.release
        })
        .eq("id", reviewId)
        .select("id"),
      "update grading review"
    );
    check(
      await supabase
        .from("review_assignments")
        .insert({
          class_id: classId,
          assignment_id: exam.assignmentId,
          submission_id: sub.submissionId,
          submission_review_id: reviewId,
          rubric_id: exam.rubricId,
          assignee_profile_id: grader,
          due_date: due,
          completed_at: completed ? now : null,
          completed_by: completed ? grader : null,
          max_allowable_late_tokens: 0,
          hard_deadline: false
        })
        .select("id"),
      "review assignment"
    );
  });
  console.log(
    `     graded ${graded}/${submissions.length} submissions${scenario.grading.release ? " (released)" : " (not released)"}`
  );
}

// ---------- Entry point ----------

/**
 * Throw on an exam config that seedExams would reject. Called when the config is set, so
 * a bad value fails before the seed writes anything.
 */
export function validateExamConfig(config: ExamConfig): void {
  const unknown = (config.scenarios ?? []).filter((k) => !EXAM_SCENARIOS.some((s) => s.key === k));
  if (unknown.length) {
    throw new Error(
      `Unknown exam scenarios: ${unknown.join(", ")}. Known: ${EXAM_SCENARIOS.map((s) => s.key).join(", ")}`
    );
  }
  const max = config.maxScannedStudents;
  if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
    throw new Error(`maxScannedStudents must be a non-negative integer, got ${max}`);
  }
}

export async function seedExams(people: ClassPeople, config: ExamConfig = {}): Promise<ExamSeedSummary> {
  validateExamConfig(config);
  const wanted = config.scenarios ? new Set(config.scenarios) : null;
  const scenarios = EXAM_SCENARIOS.filter((s) => !wanted || wanted.has(s.key));
  const maxScanned = config.maxScannedStudents ?? 40;
  console.log(`\n📝 Creating ${scenarios.length} exams and quizzes...`);

  const summary: ExamSeedSummary = { assignments: [] };
  for (const scenario of scenarios) {
    console.log(`   ${scenario.title} (${scenario.assignmentType}, ${scenario.delivery}, ${scenario.template})`);
    const exam = await createExam(scenario, people);
    console.log(
      `     assignment ${exam.assignmentId}, exam ${exam.examId}: ${exam.template.numPages} page(s), ` +
        `${exam.questionIds.size} question(s), ${exam.questionIds.size ? exam.template.storedRegions.length : 0} region(s)`
    );
    const submissions =
      scenario.delivery === "paper"
        ? await seedScanBatches(scenario, exam, people, maxScanned)
        : await seedQuizAttempts(scenario, exam, people);
    if (scenario.delivery === "in_app" && submissions.length) {
      console.log(`     ${submissions.length} students took the quiz`);
    }
    await gradeExamSubmissions(scenario, exam, people, submissions);
    summary.assignments.push({
      id: exam.assignmentId,
      title: scenario.title,
      type: `${scenario.assignmentType}/${scenario.delivery}`,
      submissions: submissions.length
    });
  }
  console.log(`✓ Created ${scenarios.length} exams and quizzes`);
  return summary;
}
